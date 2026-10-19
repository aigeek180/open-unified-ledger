import { createHash, randomUUID } from "node:crypto";
import {
  type Approval,
  approve as signApproval,
  contracts,
  type Deployment,
  devKeys,
  type Network,
  rpcUrlFor,
  sandboxChain,
} from "@oul/chain";
import { bankAccounts, isUetr } from "@oul/domain";
import { Ledger } from "@oul/ledger";
import { dealerOf, depositOf, homeCurrency, type Operator, registryOperator, type Scenario } from "@oul/scenario";
import type { CurrencyCode } from "@oul/domain";
import { sql } from "drizzle-orm";
import { type Address, createPublicClient, createWalletClient, http, type LocalAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendAudit, type AuditEntry, readAudit, verifyAudit } from "./audit.ts";
import { assertCovered, bookPending, sameFlow } from "./booking.ts";
import {
  activeAccount,
  applyBinding,
  type ChangeRequest,
  type ChangeRow,
  completeRotation,
  getChange,
  insertChange,
  listChanges,
  revokeClaim,
  signingKeys,
  startRotation,
  updateChange,
} from "./changes.ts";
import { mirrorMap, Mutex, type RuntimeContext } from "./context.ts";
import type { Defect } from "./defects.ts";
import { FlowRejected } from "./errors.ts";
import {
  bondSummary,
  checkIssue,
  planNextPayment,
  recordAffirmation,
  requireAffirmation,
  setAffirmationStatus,
  verifyHolderPayment,
} from "./bonds.ts";
import {
  type Affirmation,
  approversOf,
  type CustodyAllocation,
  bondInfo,
  bookersOf,
  centralBankOf,
  type Flow,
  flowCurrency,
  flowValue,
  initiatorOf,
  isBondFlow,
  isRepoFlow,
  legsOf,
  linesFor,
  type Quote,
  submitterOf,
} from "./flows.ts";
import { checkFxFlow, holdDealerQuote, issueQuote, keepQuote, type QuoteRequest, requestedQuote, sameQuote } from "./fx.ts";
import {
  applyHoldingBinding,
  applyWalletRecovery,
  checkCustody,
  completeCustodyRecovery,
  currentCustodyWallet,
  custodyAllocation,
  custodyClients,
  custodyWallets,
  ensureCustody,
  isCustodian,
  requireCustodiansWallet,
  startCustodyRecovery,
} from "./custody.ts";
import { identityView } from "./identity.ts";
import {
  callsToNotify,
  checkRepo,
  collateralUnitsIn,
  getMarginCall,
  getRepo,
  listRepos,
  type MarginCallRow,
  markNotified,
  recordMarginCall,
  repoConventions,
  repoView,
  requireFreeUnits,
  requireRepoAffirmation,
} from "./repo.ts";
import { listenTick } from "./listener.ts";
import { accountStatement, instructionMessages, statementAccount } from "./messages.ts";
import { migrateRuntime } from "./migrate.ts";
import {
  approvedInstructionsWaiting,
  assertMayDecide,
  assertMayInitiate,
  findOperator,
  getProposal,
  listProposals,
  operatorActor,
  operatorsOf,
  peerActor,
  type Proposal,
  type ProposalStatus,
  recordDecision,
  insertProposal,
  type Requirement,
  requirementFor,
  setProposalStatus,
} from "./policy.ts";
import { latestReconciliation, type Reconciliation } from "./reconciler.ts";
import {
  getInstruction,
  type InstructionRow,
  type InstructionStatus,
  listInstructions,
  listQuotes,
  readCursor,
  updateInstruction,
} from "./store.ts";
import { submitTick } from "./submitter.ts";
import { sweepTick } from "./sweeper.ts";

/**
 * The default schema for a participant's books: one per deployment, so a
 * fresh chain starts fresh books instead of meeting an old chain's cursor and
 * opening entry. Contract addresses alone do not identify a deployment: the
 * sandbox's keys are deterministic, so every fresh chain puts the same
 * contracts at the same addresses. The scenario and deployment time do.
 */
export function booksSchema(participant: string, deployment: Deployment): string {
  const identity = `${deployment.scenario}|${deployment.deployedAt}|${deployment.contracts.engine.toLowerCase()}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `p_${participant.replaceAll("-", "_")}_${suffix}`;
}

/** How this participant reaches the others: HTTP between services, direct calls in tests. */
export interface Peers {
  /** Ask `participant` to co-sign `flow`; it books its own side before signing. */
  approve(participant: string, flow: Flow): Promise<Approval>;
  /** Ask the central bank to fund a bank with wholesale tokens. */
  requestFunding(centralBank: string, flow: Flow): Promise<void>;
  /** Ask the dealer for a signed FX quote. */
  quote(dealer: string, request: QuoteRequest): Promise<Quote>;
  /** Ask another participant for an administrative change it makes, under its own policy (SPEC.md §15). */
  requestChange(participant: string, request: ChangeRequest): Promise<void>;
  /** Ask a custodian for the omnibus wallet its clients' units go to now (SPEC.md §15). */
  custodyWallet(bank: string): Promise<Address>;
  /**
   * Tell the other side of a repo of a margin call (SPEC.md §5.8): the
   * margin it must deliver, and by when. Without it, a call stays at the
   * side that made it, and the other side cannot deliver against it.
   */
  marginCall?(participant: string, call: { flow: Flow; dueBy: number }): Promise<void>;
}

/** A flow as a caller asks for it: the participant assigns the deadline, and the UETR unless given. */
export type FlowRequest = Flow extends infer F
  ? F extends Flow
    ? Omit<F, "uetr" | "deadline"> & { readonly uetr?: string }
    : never
  : never;

export interface ParticipantOptions {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
  readonly network: Network;
  readonly participant: string;
  readonly databaseUrl: string;
  /** Postgres schema for this participant's books; see `booksSchema` for the default. */
  readonly schema?: string;
  /** Signs transactions and approvals; the participant's sandbox key by default. */
  readonly account?: LocalAccount;
  readonly peers: Peers;
  readonly pollIntervalMs?: number;
  /** How long an instruction may wait to settle before it expires. */
  readonly deadlineSeconds?: number;
  readonly log?: (message: string) => void;
  /** Deliberate defects, for the conformance kit's broken engines only (defects.ts). */
  readonly defects?: ReadonlySet<Defect>;
  /** How many Postgres connections its books may hold; the ledger's default if unset. */
  readonly maxConnections?: number;
}

/**
 * One participant's runtime (SPEC.md §4.3, §4.4): its core ledger plus the
 * outbox, submitter, listener, reconciler and expiry sweeper that keep it in
 * step with the shared ledger. The bank and central bank services wrap it in
 * an HTTP API.
 */
export class Participant {
  readonly rt: RuntimeContext;
  private readonly peers: Peers;
  private readonly pollIntervalMs: number;
  private readonly deadlineSeconds: number;
  private running: Promise<void> | undefined;
  private readonly initiating = new Map<string, Promise<InstructionRow>>();
  private stopping = false;

  private constructor(rt: RuntimeContext, options: ParticipantOptions) {
    this.rt = rt;
    this.peers = options.peers;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.deadlineSeconds = options.deadlineSeconds ?? 600;
  }

  static async open(options: ParticipantOptions): Promise<Participant> {
    const { scenario, deployment, network, participant } = options;
    const meta = deployment.participants[participant];
    if (!meta) throw new Error(`"${participant}" is not a central bank or bank in ${deployment.scenario}`);
    const books = await Ledger.open({
      connectionString: options.databaseUrl,
      schema: options.schema ?? booksSchema(participant, deployment),
      ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    });
    await migrateRuntime(books);

    const spec = scenario.ledgers.find((l) => l.participant === participant)!;
    await books.openAccounts(spec.chart);
    if (spec.opening.length > 0) {
      await books.post({
        idempotencyKey: "opening",
        description: "Opening balances",
        status: "posted",
        at: new Date(deployment.deployedAt),
        lines: spec.opening,
      });
    }

    const chain = sandboxChain(network.chainId, rpcUrlFor(network, participant));
    // The key it signs with now: its configured one, or a later sandbox key it has rotated to since.
    const account = await activeAccount(books.database, participant, options.account ?? privateKeyToAccount(devKeys.participant(participant)));
    const mirrors = mirrorMap(scenario, deployment, participant);
    const log = options.log ?? (() => {});
    const rt: RuntimeContext = {
      scenario,
      deployment,
      network,
      participant,
      kind: meta.kind,
      currency: homeCurrency(scenario, participant),
      reserves: scenario.participants.find((p) => p.id === participant)!.reserves,
      books,
      lock: new Mutex(),
      // No block-number cache: the listener must see each new block as soon as it exists.
      client: createPublicClient({ chain, transport: http(), cacheTime: 0 }) as PublicClient,
      wallet: createWalletClient({ account, chain, transport: http() }),
      account,
      flows: { scenario, deployment },
      log: (message) => log(`[${participant}] ${message}`),
      watchedTokens: mirrors.watched,
      accountFor: mirrors.accountFor,
      watchCustodyWallet: mirrors.watchCustodyWallet,
      defects: options.defects ?? new Set(),
    };
    for (const wallet of await ensureCustody(rt)) rt.watchCustodyWallet(wallet.address);
    return new Participant(rt, options);
  }

  get id(): string {
    return this.rt.participant;
  }

  // ---------------------------------------------------------------- operations

  /**
   * Start a flow this participant initiates: fund or redeem its wholesale,
   * tokenize or detokenize a customer's deposit, pay a customer of another
   * bank, or, for bonds, issue (as agent), sell, or pay a coupon or redeem (as
   * agent). Safe to retry with the same UETR.
   */
  async initiate(request: FlowRequest, by: string): Promise<InstructionRow> {
    const operator = this.operator(by);
    // Concurrent requests for one UETR share one attempt. Each would otherwise
    // set its own deadline, and a co-signer's stored approval for the first
    // deadline would not cover the instruction submitted with the second.
    if (!request.uetr) return this.initiateOnce(request, operator);
    const inFlight = this.initiating.get(request.uetr);
    if (inFlight) {
      return inFlight.then((row) => {
        if (!sameFlow(row.flow, { ...request, uetr: row.uetr, deadline: row.flow.deadline } as Flow)) {
          throw new FlowRejected("conflicting-instruction", `UETR ${row.uetr} is already used for a different instruction`);
        }
        return row;
      });
    }
    const attempt = this.initiateOnce(request, operator).finally(() => this.initiating.delete(request.uetr!));
    this.initiating.set(request.uetr, attempt);
    return attempt;
  }

  private async initiateOnce(request: FlowRequest, operator: Operator): Promise<InstructionRow> {
    // The engine judges a deadline by block time, so it is set from block time;
    // a payment across currencies settles before its quote expires, or not at all.
    const now = await this.chainTime();
    const flow = { ...request, uetr: request.uetr ?? randomUUID(), deadline: this.deadlineFrom(now, request) } as Flow;
    this.validate(flow);
    const initiator = initiatorOf(flow, this.rt.flows);
    if (initiator !== this.id) {
      throw new FlowRejected("not-a-party", `${this.id} cannot initiate a ${flow.kind} for ${initiator}`);
    }
    const existing = await getInstruction(this.rt.books.database, flow.uetr);
    if (existing) return (await bookPending(this.rt, { ...flow, deadline: existing.flow.deadline }, existing.role)).row;
    const requirement = this.requirement(flow);
    assertMayInitiate(operator, requirement);

    // Check our own side before asking anyone else to book theirs.
    if (flow.kind === "bond-issue") await checkIssue(this.rt, flow);
    if (flow.kind === "bond-issue" || flow.kind === "bond-trade") await this.checkWallets(flow);
    // A seller delivers only units it owns and has not pledged as repo collateral (SPEC.md §5.7).
    if (flow.kind === "bond-trade" && !flow.sellerCustody) await requireFreeUnits(this.rt, flow.bond, BigInt(flow.units));
    if (isRepoFlow(flow)) await checkRepo(this.rt, flow, "submitter");
    if (flow.kind === "pvp") {
      if (!sameQuote(await requestedQuote(this.rt, flow.quote.id), flow.quote)) {
        throw new FlowRejected("invalid-flow", `Quote ${flow.quote.id} is not the one ${this.id} was given`);
      }
      await checkFxFlow(this.rt, flow, now);
    }
    await assertCovered(this.rt.books, linesFor(flow, this.id, this.rt.flows));

    const role = flow.kind === "fund" ? "party" : "submitter";
    const initiated = { actor: operatorActor(operator.id), action: "initiated" as const, detail: initiationDetail(flow, requirement) };
    if (requirement.required > 0) {
      // Booked, so its funds are held, but neither signed nor sent until the policy is met.
      const { row } = await bookPending(this.rt, flow, role, [], {
        status: "proposed",
        proposal: { initiator: operatorActor(operator.id), requirement },
        audit: [initiated],
      });
      this.rt.log(`${flow.kind} ${flow.uetr} waits for ${requirement.required} approval(s) from ${requirement.roles.join(" or ")}`);
      return row;
    }
    const released = { actor: "runtime", action: "released" as const, detail: { approvals: 0 } };

    if (flow.kind === "fund") {
      const { row } = await bookPending(this.rt, flow, "party", [], { audit: [initiated, released] });
      try {
        await this.peers.requestFunding(centralBankOf(flow, this.rt.scenario), flow);
      } catch (error) {
        await this.abandon(row, `the central bank refused: ${(error as Error).message}`);
        throw error;
      }
      return (await getInstruction(this.rt.books.database, flow.uetr))!;
    }

    const approvals = await this.coSignatures(flow);
    return (await bookPending(this.rt, flow, "submitter", approvals, { audit: [initiated, released] })).row;
  }

  /**
   * Ask every co-signer for its signature. Across currencies the dealer signs
   * first: its quote and its liquidity decide whether there is a payment at
   * all, so the payee's bank books nothing for one the dealer refuses.
   */
  private async coSignatures(flow: Flow): Promise<Approval[]> {
    return flow.kind === "pvp"
      ? approversOf(flow).reduce<Promise<Approval[]>>(async (signed, p) => [...(await signed), await this.peers.approve(p, flow)], Promise.resolve([]))
      : Promise.all(approversOf(flow).map((p) => this.peers.approve(p, flow)));
  }

  /** What the policy asks of a flow, by its kind and the cash it moves in its own currency. */
  private requirement(flow: Flow): Requirement {
    return requirementFor(this.rt.scenario, this.id, flow.kind, { minor: flowValue(flow), currency: flowCurrency(flow, this.rt.scenario) });
  }

  private deadlineFrom(now: number, flow: { kind: string; quote?: Quote }): number {
    const deadline = now + this.deadlineSeconds;
    return flow.kind === "pvp" && flow.quote ? Math.min(deadline, flow.quote.expiresAt) : deadline;
  }

  /** One of this participant's operators, or `unauthenticated`. */
  operator(id: string): Operator {
    const found = findOperator(this.rt.scenario, this.id, id);
    if (!found) throw new FlowRejected("unauthenticated", `${this.id} has no operator "${id}"`);
    return found;
  }

  /**
   * An operator approves or rejects what waits for its participant's policy:
   * an instruction, an affirmation or a change. Once enough approvals are
   * recorded the subject is released (an instruction asks its co-signers and
   * goes to the engine; an affirmation takes effect); a rejection voids an
   * instruction's pending entry, as a refused flow does.
   */
  async decide(subject: string, by: string, decision: "approve" | "reject"): Promise<Proposal> {
    const operator = this.operator(by);
    const now = await this.chainTime();
    const outcome = await this.rt.lock.run(() =>
      this.rt.books.transaction(async (tx) => {
        const proposal = await getProposal(tx.db, subject, { forUpdate: true });
        if (!proposal) throw new FlowRejected("not-found", `Nothing waits for approval under ${subject} at ${this.id}`);
        assertMayDecide(proposal, operator);
        await recordDecision(tx.db, subject, operator, decision);
        const row = proposal.kind === "instruction" ? await getInstruction(tx.db, subject) : undefined;
        if (decision === "reject") {
          await setProposalStatus(tx.db, subject, "rejected");
          if (proposal.kind === "change") await updateChange(tx.db, subject, { status: "rejected", error: `rejected by ${operator.id}` });
          if (row) {
            const entry = await tx.entryByKey(row.entryKey);
            if (entry?.status === "pending") await tx.void(entry.id, { at: new Date() });
            await updateInstruction(tx.db, subject, { status: "rejected", lastError: `rejected by ${operator.id}` });
          }
          if (proposal.kind === "affirmation") await setAffirmationStatus(tx.db, subject, "rejected");
          await appendAudit(tx.db, { actor: operatorActor(operator.id), action: "rejected", subject, detail: { roles: operator.roles } });
          return "rejected" as const;
        }
        await appendAudit(tx.db, { actor: operatorActor(operator.id), action: "approved", subject, detail: { roles: operator.roles } });
        const approvals = proposal.decisions.filter((d) => d.decision === "approve").length + 1;
        if (approvals < proposal.required) return "open" as const;
        await setProposalStatus(tx.db, subject, "approved");
        if (row) {
          // Released under a deadline from now, so the wait for approvals does not eat into the time to settle;
          // a request another participant sent keeps the deadline it booked under.
          if (proposal.initiator.startsWith("operator:")) {
            await updateInstruction(tx.db, subject, { flow: { ...row.flow, deadline: this.deadlineFrom(now, row.flow) } as Flow });
          }
          await appendAudit(tx.db, { actor: "runtime", action: "released", subject, detail: { approvals } });
        }
        if (proposal.kind === "affirmation") {
          await setAffirmationStatus(tx.db, subject, "affirmed");
          await appendAudit(tx.db, { actor: "runtime", action: "affirmed", subject, detail: { approvals } });
        }
        if (proposal.kind === "change") {
          await updateChange(tx.db, subject, { status: "approved" });
          await appendAudit(tx.db, { actor: "runtime", action: "released", subject, detail: { approvals } });
        }
        return "approved" as const;
      }),
    );
    this.rt.log(`${operator.id} ${decision === "approve" ? "approved" : "rejected"} ${subject}`);
    if (outcome === "approved") {
      const kind = (await getProposal(this.rt.books.database, subject))?.kind;
      if (kind === "change") await this.applyChange(subject);
      else if (kind === "affirmation") await this.notifyCalls();
      else await this.dispatch(subject);
    }
    return (await getProposal(this.rt.books.database, subject))!;
  }

  private readonly dispatching = new Map<string, Promise<void>>();

  /**
   * Send on an instruction whose policy is met: ask its co-signers and queue
   * it for the engine, ask the central bank to fund, or at a central bank
   * queue the mint. Idempotent, and retried each tick while a counterparty
   * cannot be reached; a counterparty's refusal fails the instruction and
   * voids its entry.
   */
  private dispatch(uetr: string): Promise<void> {
    const inFlight = this.dispatching.get(uetr);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      const row = await getInstruction(this.rt.books.database, uetr);
      if (row?.status !== "proposed") return;
      const flow = row.flow;
      try {
        if (row.role === "party") {
          await this.peers.requestFunding(centralBankOf(flow, this.rt.scenario), flow);
          await updateInstruction(this.rt.books.database, uetr, { status: "awaiting" });
        } else if (this.rt.kind === "central-bank") {
          await updateInstruction(this.rt.books.database, uetr, { status: "ready" });
        } else {
          if (flow.deadline <= (await this.chainTime())) throw new FlowRejected("invalid-flow", "Its deadline passed before it was released");
          const approvals = await this.coSignatures(flow);
          await updateInstruction(this.rt.books.database, uetr, { status: "ready", approvals });
        }
      } catch (error) {
        if (error instanceof FlowRejected) {
          await this.abandon(row, `refused: ${error.message}`);
          throw error;
        }
        this.rt.log(`could not release ${uetr} yet: ${(error as Error).message}`);
        throw error;
      }
    })().finally(() => this.dispatching.delete(uetr));
    this.dispatching.set(uetr, attempt);
    return attempt;
  }

  /** Release what was approved but not sent on, after a restart or a counterparty being away. */
  private async releaseTick(): Promise<void> {
    for (const uetr of await approvedInstructionsWaiting(this.rt.books.database)) {
      await this.dispatch(uetr).catch(() => undefined);
    }
  }

  /**
   * Co-sign a flow another participant initiated. The approver rebuilds the
   * legs itself, books its own side, and only then signs what it computed.
   */
  async approve(flow: Flow): Promise<Approval> {
    this.validate(flow);
    if (!approversOf(flow).includes(this.id)) {
      throw new FlowRejected("not-a-party", `${this.id} is not asked to approve this ${flow.kind}`);
    }
    const now = await this.chainTime();
    if (flow.deadline <= now) {
      throw new FlowRejected("invalid-flow", "The instruction's deadline has passed");
    }
    // Across currencies: every party checks the quote; the dealer signs only its own, once.
    if (flow.kind === "pvp") {
      await checkFxFlow(this.rt, flow, now);
      if (flow.quote.dealer === this.id) await holdDealerQuote(this.rt, flow);
    }
    // A holder checks its coupon itself; a buyer pays only for what its operator agreed to.
    let custody: CustodyAllocation | undefined;
    if (flow.kind === "bond-redeem" && (await collateralUnitsIn(this.rt.books.database, flow.bond)) > 0n) {
      // Units held or pledged as repo collateral go back to their owner before the bond is redeemed (SPEC.md §5.10).
      throw new FlowRejected("invalid-flow", `${this.id} has units of ${flow.bond} in open repos: they are returned before redemption`);
    }
    // A repo's other side checks every flow against its own record, and an open or a change of collateral
    // only if its own operator affirmed it (SPEC.md §5.7–§5.10).
    if (isRepoFlow(flow)) {
      await checkRepo(this.rt, flow, "approver");
      await requireRepoAffirmation(this.rt, flow);
    }
    if (flow.kind === "bond-coupon" || flow.kind === "bond-redeem") {
      await verifyHolderPayment(this.rt, flow);
      await checkCustody(this.rt, flow);
      // Its clients' shares come from its positions at the record block, so its books must have reached it.
      if (flow.payments.some((p) => p.bank === this.id && p.wallet)) {
        if (((await readCursor(this.rt.books.database)) ?? 0n) < BigInt(flow.recordBlock)) await listenTick(this.rt);
        custody = await custodyAllocation(this.rt, flow);
      }
    }
    if (flow.kind === "bond-issue" || flow.kind === "bond-trade") {
      await requireAffirmation(this.rt, flow);
      await checkCustody(this.rt, flow);
      await this.checkWallets(flow);
    }
    const approval = await signApproval(
      this.rt.account,
      this.rt.network.chainId,
      this.rt.deployment.contracts.engine,
      legsOf(flow, this.rt.flows),
    );
    const signed = { actor: "runtime", action: "signed" as const, detail: { signer: approval.signer, for: submitterOf(flow, this.rt.flows), kind: flow.kind } };
    const { row } = await bookPending(this.rt, flow, "approver", [approval], { audit: [signed], ...(custody ? { custody } : {}) });
    return row.approvals[0]!;
  }

  /** Every custody wallet a bond flow names is bound to its bank in the registry (§15). */
  private async checkWallets(flow: Extract<Flow, { kind: "bond-issue" | "bond-trade" }>): Promise<void> {
    const named =
      flow.kind === "bond-issue"
        ? flow.allocations.filter((a) => a.custody).map((a) => [a.bank, a.custody!.wallet] as const)
        : [
            ...(flow.sellerCustody ? [[flow.seller, flow.sellerCustody.wallet] as const] : []),
            ...(flow.buyerCustody ? [[flow.buyer, flow.buyerCustody.wallet] as const] : []),
          ];
    for (const [bank, wallet] of named) await requireCustodiansWallet(this.rt, bank, wallet);
  }

  /**
   * Record that this bank's operator agreed to buy in an issue or a trade, so
   * it co-signs that instruction when the agent or seller sends it. Above its
   * policy's threshold the affirmation counts only once approved.
   */
  async affirm(request: Affirmation, by: string): Promise<{ status: "affirmed" | "proposed" }> {
    const operator = this.operator(by);
    const flow = { ...request, deadline: Number.MAX_SAFE_INTEGER } as Flow;
    this.validate(flow);
    if (!approversOf(flow).includes(this.id)) {
      throw new FlowRejected("not-a-party", `${this.id} does not co-sign this ${flow.kind}, so it has nothing to affirm`);
    }
    let value: bigint;
    let call: MarginCallRow | undefined;
    if (isRepoFlow(flow)) {
      // A repo's terms, or the marks behind a change to its collateral, checked against this bank's own record.
      await checkRepo(this.rt, flow, "affirmer");
      value = flowValue(flow);
      if (flow.kind === "repo-margin") {
        // The side receiving units calls the margin, due within the scenario's time.
        const dueBy = (await this.chainTime()) + repoConventions(this.rt).marginCallSeconds;
        call = { uetr: flow.uetr, repo: flow.repo, flow, caller: this.id, dueBy, notified: false };
      }
    } else {
      const bond = request as Extract<Affirmation, { kind: "bond-issue" | "bond-trade" }>;
      // A client it buys for verifies, and the units go to its own omnibus wallet (§15).
      await checkCustody(this.rt, flow);
      // What this bank pays: its own allocation in an issue, the whole consideration in a trade.
      const mine = bond.kind === "bond-issue" ? bond.allocations.filter((a) => a.bank === this.id) : [{ units: bond.units }];
      value = mine.reduce((t, a) => t + BigInt(a.units) * BigInt(bond.price), 0n);
    }
    const requirement = requirementFor(this.rt.scenario, this.id, request.kind, { minor: value, currency: flowCurrency(flow, this.rt.scenario) });
    assertMayInitiate(operator, requirement);
    const status = requirement.required > 0 ? "proposed" : "affirmed";
    await this.rt.lock.run(() =>
      this.rt.books.transaction(async (tx) => {
        const existing = await getProposal(tx.db, request.uetr);
        if (existing) throw new FlowRejected("conflicting-instruction", `${request.uetr} is already ${existing.status} here`);
        await recordAffirmation(tx.db, request, status);
        if (call) await recordMarginCall(tx.db, call);
        await appendAudit(tx.db, { actor: operatorActor(operator.id), action: "initiated", subject: request.uetr, detail: initiationDetail(flow, requirement) });
        if (requirement.required > 0) {
          await insertProposal(tx.db, { subject: request.uetr, kind: "affirmation", initiator: operatorActor(operator.id), requirement });
        } else {
          await appendAudit(tx.db, { actor: "runtime", action: "affirmed", subject: request.uetr, detail: { approvals: 0 } });
        }
      }),
    );
    if (call && status === "affirmed") await this.notifyCalls();
    return { status };
  }

  // ---------------------------------------------------------------- repo (SPEC.md §5.7–§5.10)

  /** Tell the other side of each affirmed margin call it has not heard of yet; retried each tick. */
  private async notifyCalls(): Promise<void> {
    if (!this.rt.scenario.repo || !this.peers.marginCall) return;
    for (const call of await callsToNotify(this.rt.books.database)) {
      const other = call.flow.lender === this.id ? call.flow.borrower : call.flow.lender;
      try {
        await this.peers.marginCall(other, { flow: call.flow, dueBy: call.dueBy });
        await markNotified(this.rt.books.database, call.uetr);
        this.rt.log(`told ${other} of margin call ${call.uetr}, due by ${call.dueBy}`);
      } catch (error) {
        this.rt.log(`could not tell ${other} of margin call ${call.uetr} yet: ${(error as Error).message}`);
      }
    }
  }

  /**
   * The other side of a repo makes a margin call: it is checked against this
   * bank's own record, as the delivery will be, and kept with its due time,
   * so this bank can deliver against it and both sides see it overdue if it
   * is not met in time.
   */
  async receiveMarginCall(call: { flow: Flow; dueBy: number }): Promise<{ uetr: string; dueBy: number }> {
    const { flow } = call;
    this.validate(flow);
    if (flow.kind !== "repo-margin") throw new FlowRejected("invalid-flow", `A margin call is a repo-margin, not a ${flow.kind}`);
    const caller = flow.direction === "deliver" ? flow.lender : flow.borrower;
    if (caller === this.id) throw new FlowRejected("not-a-party", `${this.id} made this call itself`);
    await checkRepo(this.rt, flow, "called");
    const existing = await getMarginCall(this.rt.books.database, flow.uetr);
    if (existing && existing.flow.uetr !== flow.uetr) throw new FlowRejected("conflicting-instruction", `${flow.uetr} is another call here`);
    await this.rt.books.database.transaction(async (tx) => {
      await recordMarginCall(tx, { uetr: flow.uetr, repo: flow.repo, flow, caller, dueBy: call.dueBy, notified: true });
      await appendAudit(tx, { actor: peerActor(caller), action: "initiated", subject: flow.uetr, detail: { kind: "margin-call", units: flow.units, bond: flow.bond, dueBy: call.dueBy } });
    });
    return { uetr: flow.uetr, dueBy: call.dueBy };
  }

  /** The repos this bank is party to, newest first, each as it sees it. */
  async repos() {
    const now = await this.chainTime();
    return Promise.all((await listRepos(this.rt.books.database)).map((r) => repoView(this.rt, r, now)));
  }

  async repo(id: string) {
    const repo = await getRepo(this.rt.books.database, id);
    return repo ? repoView(this.rt, repo, await this.chainTime()) : undefined;
  }

  // ---------------------------------------------------------------- administrative changes (SPEC.md §15)

  /**
   * An administrator starts an administrative change here: it waits for the
   * approvals its policy requires, like a flow, and is applied once they are
   * recorded.
   */
  async proposeChange(request: ChangeRequest, by: string): Promise<ChangeRow> {
    const operator = this.operator(by);
    if (request.action === "bind-address" || (request.action === "recovery" && request.op === "recover")) {
      throw new FlowRejected("invalid-flow", `${request.action} is asked by another participant, not started here`);
    }
    if (request.action === "recovery" && !isCustodian(this.rt)) throw new FlowRejected("not-a-party", `${this.id} holds no bonds for clients`);
    if (request.action === "claim" && !this.rt.deployment.identity?.claimIssuers[this.id]) {
      throw new FlowRejected("not-a-party", `${this.id} issues no claims in ${this.rt.scenario.id}`);
    }
    return this.recordChange(request, operatorActor(operator.id), operator);
  }

  /**
   * Another participant asks for a change this one makes: as the registry's
   * operator, admitting its new signing key. It is checked now, held for
   * this participant's own policy, and applied once approved.
   */
  async receiveChange(request: ChangeRequest): Promise<ChangeRow> {
    if (request.action === "recovery" && request.op === "recover") {
      // As a bond's agent: a custodian asks it to recover its lost omnibus wallet (§15).
      if (bondInfo(this.rt.scenario, request.bond).agent !== this.id) throw new FlowRejected("not-a-party", `${this.id} is not the agent of ${request.bond}`);
      return this.recordChange(request, peerActor(request.holder));
    }
    if (request.action !== "bind-address") throw new FlowRejected("invalid-flow", `${request.action} is not asked of another participant`);
    if (registryOperator(this.rt.scenario).id !== this.id) {
      throw new FlowRejected("not-a-party", `${this.id} does not operate the registry`);
    }
    if (!this.rt.deployment.participants[request.participant]) throw new FlowRejected("invalid-flow", `"${request.participant}" is not a participant`);
    return this.recordChange(request, peerActor(request.participant));
  }

  private async recordChange(request: ChangeRequest, initiator: string, operator?: Operator): Promise<ChangeRow> {
    const action = request.action;
    const requirement = requirementFor(this.rt.scenario, this.id, action);
    if (operator) assertMayInitiate(operator, requirement);
    const id = randomUUID();
    await this.rt.lock.run(() =>
      this.rt.books.transaction(async (tx) => {
        await insertChange(tx.db, { id, request, initiator, status: requirement.required > 0 ? "proposed" : "approved" });
        await appendAudit(tx.db, {
          actor: initiator,
          action: "initiated",
          subject: id,
          detail: { action, rule: requirement.rule, required: requirement.required, roles: requirement.roles, request: changeSummary(request) },
        });
        if (requirement.required > 0) await insertProposal(tx.db, { subject: id, kind: "change", initiator, requirement });
        else await appendAudit(tx.db, { actor: "runtime", action: "released", subject: id, detail: { approvals: 0 } });
      }),
    );
    if (requirement.required === 0) await this.applyChange(id);
    return (await getChange(this.rt.books.database, id))!;
  }

  /** Apply an approved change; a refusal by a counterparty or the chain fails it, with the reason kept. */
  private async applyChange(id: string): Promise<void> {
    const change = await getChange(this.rt.books.database, id);
    if (change?.status !== "approved") return;
    try {
      const request = change.request;
      const ask = (participant: string, r: ChangeRequest) => this.peers.requestChange(participant, r);
      const result =
        request.action === "rotate-key"
          ? await startRotation(this.rt, id, ask)
          : request.action === "bind-address"
            ? request.op === "holding"
              ? await applyHoldingBinding(this.rt, request)
              : await applyBinding(this.rt, request)
            : request.action === "claim"
              ? await revokeClaim(this.rt, request)
              : request.op === "recover"
                ? await applyWalletRecovery(this.rt, request)
                : await startCustodyRecovery(this.rt, ask, (wallet) => this.rt.watchCustodyWallet(wallet));
      // A rotation and a custody recovery finish once the chain shows what others did; the rest are done.
      const done = request.action === "rotate-key" || (request.action === "recovery" && request.op === "custody-wallet") ? "requested" : "applied";
      await this.rt.books.database.transaction(async (tx) => {
        await updateChange(tx, id, { status: done, result });
        if (done === "applied") await appendAudit(tx, { actor: "runtime", action: "changed", subject: id, detail: result });
      });
      // The registry's operator rotating its own key admitted it already: sign with it at once.
      if (change.request.action === "rotate-key") await completeRotation(this.rt);
      if (change.request.action === "recovery") await this.custodyTick();
    } catch (error) {
      await this.rt.books.database.transaction(async (tx) => {
        await updateChange(tx, id, { status: "failed", error: (error as Error).message });
        await appendAudit(tx, { actor: "runtime", action: "refused", subject: id, detail: { reason: (error as Error).message } });
      });
      throw error;
    }
  }

  /** Finish a custody recovery the chain shows done, and mark its change applied. */
  private async custodyTick(): Promise<void> {
    const wallet = await completeCustodyRecovery(this.rt);
    if (!wallet) return;
    await this.rt.books.database.transaction(async (tx) => {
      for (const change of (await listChanges(tx, 50)).filter((c) => c.action === "recovery" && c.status === "requested")) {
        await updateChange(tx, change.id, { status: "applied" });
        await appendAudit(tx, { actor: "runtime", action: "changed", subject: change.id, detail: { action: "recovery", newWallet: wallet } });
      }
    });
  }

  /** Another custodian's omnibus wallet now, for a flow that delivers its client's units there (§15). */
  peerCustodyWallet(bank: string): Promise<Address> {
    return this.peers.custodyWallet(bank);
  }

  /** As a custodian, the omnibus wallet its clients' units go to now (§15). */
  custodyWallet(): Promise<Address> {
    return currentCustodyWallet(this.rt);
  }

  /** As a custodian: its omnibus wallets, and each client's position in each bond (§15). */
  async custody() {
    const wallets = await custodyWallets(this.rt.books.database);
    const block = await this.rt.client.getBlockNumber();
    const bonds = [];
    for (const spec of this.rt.scenario.instruments.bonds) {
      const token = this.rt.deployment.tokens[spec.symbol];
      if (token?.kind !== "bond") continue;
      let held = 0n;
      for (const w of wallets) {
        held += (await this.rt.client.readContract({ address: token.address, abi: contracts.Bond.abi, functionName: "balanceOf", args: [w.address] })) as bigint;
      }
      const positions = (await Promise.all(
        custodyClients(this.rt).map(async (client) => ({
          client,
          units: (await this.rt.books.balance(bankAccounts.custodyPosition(spec.symbol, client))).posted.minor / bondInfo(this.rt.scenario, spec.symbol).terms.face.minor,
        })),
      ));
      bonds.push({ bond: spec.symbol, onChain: held, positions });
    }
    return { custodian: isCustodian(this.rt), clients: custodyClients(this.rt), wallets, block, bonds };
  }

  changes(limit = 50): Promise<ChangeRow[]> {
    return listChanges(this.rt.books.database, limit);
  }

  change(id: string): Promise<ChangeRow | undefined> {
    return getChange(this.rt.books.database, id);
  }

  /** Its identity for securities and the claims on it; as a trusted issuer, the claims it made (ERC-3643). */
  identity() {
    return identityView(this.rt);
  }

  /** The keys this participant has signed with, and the one it signs with now. */
  async keys() {
    return { current: this.rt.account.address, keys: await signingKeys(this.rt.books.database) };
  }

  /** As paying agent, pay the bond's next scheduled coupon, or redeem it if that is the last. */
  async payNextBondPayment(symbol: string, by: string, uetr?: string): Promise<InstructionRow> {
    const plan = await planNextPayment(this.rt, symbol);
    return this.initiate(uetr ? ({ ...plan, uetr } as FlowRequest) : plan, by);
  }

  /** As dealer, price and sign an FX quote for a bank's payment (SPEC.md §13). */
  async quote(request: QuoteRequest): Promise<Quote> {
    return issueQuote(this.rt, request, await this.chainTime());
  }

  /**
   * As a payer's bank, ask the dealer to quote `sourceAmount` (minor units of
   * this bank's own currency) into `to`, check the quote and keep it, so a
   * payment can settle at it.
   */
  async requestQuote(to: CurrencyCode, sourceAmount: string): Promise<Quote> {
    const dealer = dealerOf(this.rt.scenario);
    if (!dealer) throw new FlowRejected("invalid-flow", `${this.rt.scenario.id} has no FX dealer`);
    const quote = await this.peers.quote(dealer, { requester: this.id, from: this.rt.currency, to, sourceAmount });
    return keepQuote(this.rt, quote, await this.chainTime());
  }

  /** A quote this bank asked the dealer for and kept, to pay at. */
  heldQuote(id: string): Promise<Quote> {
    return requestedQuote(this.rt, id);
  }

  /** The quotes this participant gave as dealer or asked for, newest first. */
  quotes(limit = 50) {
    return listQuotes(this.rt.books.database, limit);
  }

  /** The central bank's side of funding: check the bank's settlement account, book, submit. */
  async receiveFunding(flow: Flow): Promise<InstructionRow> {
    this.validate(flow);
    if (flow.kind !== "fund" || this.rt.kind !== "central-bank") {
      throw new FlowRejected("not-a-party", `${this.id} does not fund wholesale`);
    }
    // The mint is this central bank's outgoing instruction, so its own policy decides whether an operator
    // must approve it first; the bank that asked is its initiator.
    const requirement = this.requirement(flow);
    const initiated = { actor: peerActor(flow.bank), action: "initiated" as const, detail: initiationDetail(flow, requirement) };
    if (requirement.required > 0) {
      return (await bookPending(this.rt, flow, "submitter", [], { status: "proposed", proposal: { initiator: peerActor(flow.bank), requirement }, audit: [initiated] })).row;
    }
    const released = { actor: "runtime", action: "released" as const, detail: { approvals: 0 } };
    return (await bookPending(this.rt, flow, "submitter", [], { audit: [initiated, released] })).row;
  }

  // ---------------------------------------------------------------- reads

  async instruction(uetr: string) {
    const row = await getInstruction(this.rt.books.database, uetr);
    if (!row) return undefined;
    const entry = await this.rt.books.entryByKey(row.entryKey);
    return { ...row, entryStatus: entry?.status ?? null };
  }

  /** A page of this participant's instructions, newest first, each with its journal entry's status. */
  async instructions(options: {
    limit: number;
    before?: { createdAt: Date; uetr: string };
    statuses?: readonly InstructionStatus[];
  }) {
    const rows = await listInstructions(this.rt.books.database, options);
    return Promise.all(
      rows.map(async (row) => ({ ...row, entryStatus: (await this.rt.books.entryByKey(row.entryKey))?.status ?? null })),
    );
  }

  /** The journal entry that books an instruction here, if it has been booked. */
  entry(uetr: string) {
    return getInstruction(this.rt.books.database, uetr).then((row) => (row ? this.rt.books.entryByKey(row.entryKey) : undefined));
  }

  bond(symbol: string) {
    return bondSummary(this.rt, symbol);
  }

  /** The ISO 20022 messages that concern this participant for one of its instructions. */
  messages(uetr: string) {
    return instructionMessages(this.rt, uetr);
  }

  /**
   * A camt.053 statement of an account this participant owes: at a bank, a
   * customer's deposit or tokenized deposit; at the central bank, a bank's
   * settlement account or wholesale line. Undefined for any other account.
   */
  async statement(request: { kind: string; owner: string }, period: { from: Date; to: Date }) {
    const account = statementAccount(this.rt, request);
    return account ? accountStatement(this.rt, account, period) : undefined;
  }

  /** This participant's operators and policy, as the scenario names them. */
  get operators() {
    return operatorsOf(this.rt.scenario, this.id);
  }

  /** What waits for, or got, its policy's approvals, newest first. */
  proposals(options: { status?: ProposalStatus; limit?: number } = {}): Promise<Proposal[]> {
    return listProposals(this.rt.books.database, { limit: options.limit ?? 50, ...(options.status ? { status: options.status } : {}) });
  }

  proposal(subject: string): Promise<Proposal | undefined> {
    return getProposal(this.rt.books.database, subject);
  }

  /** A page of the audit log, newest first. */
  audit(options: { limit: number; before?: bigint; subject?: string }): Promise<AuditEntry[]> {
    return readAudit(this.rt.books.database, options);
  }

  /** Walk the audit log's hash chain from its first entry. */
  verifyAudit() {
    return verifyAudit(this.rt.books.database);
  }

  reconciliation(): Promise<Reconciliation | undefined> {
    return latestReconciliation(this.rt);
  }

  async breaks(limit = 50) {
    const result = await this.rt.books.database.execute(sql`
      SELECT id::text, block::text, kind, uetr, tx_hash, detail, recorded_at
        FROM chain_breaks ORDER BY id DESC LIMIT ${limit}
    `);
    return result.rows;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Run the submitter, listener and sweeper until `stop()`. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = (async () => {
      let tick = 0;
      while (!this.stopping) {
        try {
          await completeRotation(this.rt);
          await this.custodyTick();
          await this.releaseTick();
          await this.notifyCalls();
          await submitTick(this.rt);
          await listenTick(this.rt);
          if (tick++ % 5 === 0) await sweepTick(this.rt);
        } catch (error) {
          this.rt.log(`tick failed: ${(error as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    })();
  }

  /** One pass of every loop, for tests and scripted runs. */
  async tick(): Promise<void> {
    await completeRotation(this.rt);
    await this.custodyTick();
    await this.releaseTick();
    await this.notifyCalls();
    await submitTick(this.rt);
    await listenTick(this.rt);
    await sweepTick(this.rt);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.running;
    this.running = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    await this.rt.books.close();
  }

  // ---------------------------------------------------------------- internals

  /** The latest block's timestamp, in seconds. */
  private async chainTime(): Promise<number> {
    return Number((await this.rt.client.getBlock()).timestamp);
  }

  private validate(flow: Flow): void {
    if (!isUetr(flow.uetr)) throw new FlowRejected("invalid-flow", `Not a UETR: "${flow.uetr}"`);
    try {
      flowValue(flow);
    } catch (error) {
      throw new FlowRejected("invalid-flow", (error as Error).message);
    }
    const { deployment } = this.rt;
    const isBank = (id: string) => deployment.participants[id]?.kind === "bank";
    const isCustomer = (bank: string, customer: string) => Boolean(deployment.customers[`${bank}/${customer}`]);

    let banks: string[];
    let customers: string[][] = [];
    if (isBondFlow(flow)) {
      let info;
      try {
        info = bondInfo(this.rt.scenario, flow.bond);
      } catch (error) {
        throw new FlowRejected("invalid-flow", (error as Error).message);
      }
      banks = [info.agent, ...bookersOf(flow, this.rt.flows)];
      const holders = flow.kind === "bond-trade" ? [flow.seller, flow.buyer] : approversOf(flow);
      if (holders.includes(info.agent)) {
        throw new FlowRejected("invalid-flow", "The paying agent cannot hold the bond it pays");
      }
      if (flow.kind === "bond-trade" && flow.seller === flow.buyer) {
        throw new FlowRejected("invalid-flow", "A trade needs two different banks");
      }
    } else if (isRepoFlow(flow)) {
      banks = [flow.lender, flow.borrower];
      if (flow.lender === flow.borrower) throw new FlowRejected("invalid-flow", "A repo needs two different banks");
      if (!this.rt.scenario.repo) throw new FlowRejected("invalid-flow", `${this.rt.scenario.id} has no repo`);
    } else if (flow.kind === "pvp") {
      banks = [flow.payerBank, flow.payeeBank, flow.quote.dealer];
      customers = [[flow.payerBank, flow.payer], [flow.payeeBank, flow.payee]];
    } else {
      banks = flow.kind === "interbank" ? [flow.payerBank, flow.payeeBank] : [flow.bank];
      if (flow.kind === "interbank" && flow.payerBank === flow.payeeBank) {
        throw new FlowRejected("invalid-flow", "An interbank payment needs two different banks");
      }
      if ((flow.kind === "fund" || flow.kind === "redeem") && !this.rt.scenario.participants.find((p) => p.id === flow.bank)?.reserves.includes(flow.currency)) {
        throw new FlowRejected("invalid-flow", `${flow.bank} holds no reserves in ${flow.currency}`);
      }
      if (flow.kind === "interbank") {
        const [payer, payee] = [depositOf(this.rt.scenario, flow.payerBank), depositOf(this.rt.scenario, flow.payeeBank)];
        if (payer.currency !== payee.currency) {
          throw new FlowRejected("invalid-flow", `${payer.symbol} is in ${payer.currency} and ${payee.symbol} in ${payee.currency}: a payment between currencies settles through a dealer`);
        }
      }
      customers =
        flow.kind === "tokenize" || flow.kind === "detokenize"
          ? [[flow.bank, flow.customer]]
          : flow.kind === "interbank"
            ? [[flow.payerBank, flow.payer], [flow.payeeBank, flow.payee]]
            : [];
    }
    for (const bank of banks) {
      if (!isBank(bank)) throw new FlowRejected("invalid-flow", `"${bank}" is not a bank`);
    }
    for (const [bank, customer] of customers) {
      if (!isCustomer(bank!, customer!)) {
        throw new FlowRejected("unknown-customer", `"${customer}" is not a customer of ${bank}`);
      }
    }
    if (!bookersOf(flow, this.rt.flows).includes(this.id)) {
      throw new FlowRejected("not-a-party", `${this.id} takes no part in this ${flow.kind}`);
    }
  }

  private async abandon(row: InstructionRow, reason: string): Promise<void> {
    await this.rt.lock.run(() =>
      this.rt.books.transaction(async (tx) => {
        const entry = await tx.entryByKey(row.entryKey);
        if (entry?.status === "pending") await tx.void(entry.id, { at: new Date() });
        await updateInstruction(tx.db, row.uetr, { status: "failed", lastError: reason });
        await appendAudit(tx.db, { actor: "runtime", action: "refused", subject: row.uetr, detail: { reason } });
      }),
    );
  }
}

/** What an initiation records of what the policy asked of it, so the log alone can prove invariant 12. */
function initiationDetail(flow: Flow, requirement: Requirement) {
  return {
    action: requirement.action,
    kind: flow.kind,
    value: flowValue(flow).toString(),
    rule: requirement.rule,
    required: requirement.required,
    roles: requirement.roles,
  };
}

/** What an audit entry records of a change: never a signature, which the change itself keeps. */
function changeSummary(request: ChangeRequest) {
  if (request.action === "bind-address") {
    return request.op === "holding"
      ? { op: "holding", participant: request.participant, wallet: request.wallet }
      : { participant: request.participant, oldKey: request.oldKey, newKey: request.newKey };
  }
  if (request.action === "claim") return { op: request.op, subject: request.subject };
  if (request.action === "recovery" && request.op === "recover") return { ...request };
  return {};
}
