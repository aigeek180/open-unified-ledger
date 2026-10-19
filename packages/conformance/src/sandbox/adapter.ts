import { randomBytes, randomUUID } from "node:crypto";
import {
  type Approval,
  approve,
  type ChainInstruction,
  contracts,
  type Deployment,
  deployScenario,
  devKeys,
  instructionDigest,
  type Network,
  rpcUrlFor,
  sandboxChain,
  ZERO_FEES,
} from "@oul/chain";
import { type Anvil, localNetwork, startAnvil } from "@oul/chain/testing";
import { bankAccounts, centralBankAccounts, parseMoney } from "@oul/domain";
import {
  act,
  affirmAs,
  type Flow,
  FlowRejected,
  type FlowRequest,
  legsOf,
  Participant,
  PeerUnavailable,
  type Peers,
  payNextAs,
  planClose,
  planMargin,
  planSubstitution,
  recordsAt,
  submitterOf,
} from "@oul/participant";
import { centralBanks, depositOf, registryOperator, type Scenario, wholesaleFor } from "@oul/scenario";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionData,
  type Hex,
  http,
  type PublicClient,
  recoverAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type Attempt,
  type Books,
  type Capabilities,
  type Directory,
  type EngineAdapter,
  FaultNotApplicable,
  type FaultReport,
  type Observation,
  type Outcome,
} from "../adapter.ts";
import type { FaultStep, KitFlow, PaymentFlow } from "../flows.ts";
import { type BrokenEngine, type BrokenEngineName, brokenEngine } from "./broken.ts";
import { ChainObserver, engineId, kitId } from "./observer.ts";

/**
 * The conformance kit's adapter for this sandbox's own engine (SPEC.md
 * §14): the real contracts deployed afresh for each run, on a fresh Anvil or
 * on a running network (Besu), and every central bank's and bank's real
 * participant runtime, each with its own books in its own Postgres schema,
 * run in this process and reaching each other directly, as the runtime's
 * tests run them. The services wrap the same runtime in HTTP; nothing here
 * goes around it except what a fault sends to the engine on purpose.
 */

const DEFAULT_DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const LEDGER = "shared";

export interface SandboxOptions {
  /** Where to run: a fresh Anvil for each run (the default), or a running network. */
  readonly chain?: { readonly kind: "anvil" } | { readonly kind: "network"; readonly network: Network };
  readonly databaseUrl?: string;
  /** How long an instruction may wait to settle; refused instructions expire after it. */
  readonly deadlineSeconds?: number;
  readonly name?: string;
  readonly log?: (line: string) => void;
  /** Run one of the kit's deliberately broken engines (broken.ts) instead of the real one. */
  readonly broken?: BrokenEngineName;
}

const ALL_ERRORS = Object.values(contracts).flatMap((c) => c.abi.filter((item) => item.type === "error"));

/** A contract revert's error name, or undefined if `error` is not one. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  if (revert.data?.errorName) return revert.data.errorName;
  if (revert.raw) {
    try {
      return decodeErrorResult({ abi: ALL_ERRORS, data: revert.raw as Hex }).errorName;
    } catch {
      // Not one of ours.
    }
  }
  return revert.reason ?? "reverted";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SandboxAdapter implements EngineAdapter {
  readonly name: string;
  readonly capabilities: Capabilities = {
    flows: [
      "fund",
      "redeem",
      "tokenize",
      "detokenize",
      "pay",
      "pay-fx",
      "bond-issue",
      "bond-trade",
      "bond-payment",
      "repo-open",
      "repo-margin",
      "repo-substitute",
      "repo-close",
    ],
    faults: ["participant-down", "duplicate-submission", "stale-approval", "missing-approval", "frozen-payer", "ineligible-payee"],
    books: true,
  };
  private readonly options: SandboxOptions;
  private readonly databaseUrl: string;
  private anvil: Anvil | undefined;
  private scenario!: Scenario;
  private network!: Network;
  private deployment!: Deployment;
  private client!: PublicClient;
  private directory!: Directory;
  private observer!: ChainObserver;
  private readonly participants = new Map<string, Participant>();
  private readonly down = new Set<string>();
  private readonly schemas: string[] = [];
  private readonly broken: BrokenEngine | undefined;
  /** Each repo this run opened, by id: its two banks. */
  private readonly opened = new Map<string, { lender: string; borrower: string }>();

  constructor(options: SandboxOptions = {}) {
    this.options = options;
    this.broken = options.broken ? brokenEngine(options.broken) : undefined;
    this.name = options.name ?? (this.broken ? `broken engine "${this.broken.name}"` : "sandbox");
    this.databaseUrl = options.databaseUrl ?? DEFAULT_DATABASE_URL;
  }

  /** The engine's ABI, for reading what a transaction settled: a broken engine's may add to it. */
  private engineAbi(): Abi {
    return this.broken?.replace?.engine?.abi ?? (contracts.SettlementEngine.abi as Abi);
  }

  /** Deploy the scenario, with a broken engine's contracts in place of the real ones. */
  private deploy(scenario: Scenario, network: Network, readyAtBlock: bigint): Promise<{ deployment: Deployment }> {
    return deployScenario(scenario, network, { force: true, readyAtBlock, ...(this.broken?.replace ? { replace: this.broken.replace } : {}) });
  }

  /** Open a participant's runtime, with a broken engine's defects. */
  private openParticipant(id: string, schema: string, peers: Peers): Promise<Participant> {
    return Participant.open({
      scenario: this.scenario,
      deployment: this.deployment,
      network: this.network,
      participant: id,
      databaseUrl: this.databaseUrl,
      schema,
      peers,
      deadlineSeconds: this.options.deadlineSeconds ?? 600,
      // The kit ticks one participant at a time: two connections each are plenty, and several engines fit at once.
      maxConnections: 2,
      ...(this.broken?.defects ? { defects: new Set(this.broken.defects) } : {}),
    });
  }

  async reset(scenario: Scenario): Promise<Directory> {
    await this.teardown();
    this.scenario = scenario;
    let readyAtBlock = 1n;
    if (this.options.chain?.kind === "network") {
      this.network = this.options.chain.network;
    } else {
      this.anvil = startAnvil();
      this.network = localNetwork(scenario, this.anvil.rpcUrl);
      readyAtBlock = 0n;
    }
    ({ deployment: this.deployment } = await this.deploy(scenario, this.network, readyAtBlock));
    const rpc = rpcUrlFor(this.network, registryOperator(scenario).id);
    this.client = createPublicClient({ chain: sandboxChain(this.network.chainId, rpc), transport: http(rpc, { batch: { batchSize: 256 } }), cacheTime: 0 }) as PublicClient;

    const tag = randomBytes(4).toString("hex");
    for (const p of [...centralBanks(scenario), ...scenario.participants.filter((p) => p.kind === "bank")]) {
      const schema = `cf_${tag}_${p.id.replaceAll("-", "_")}`;
      this.schemas.push(schema);
      this.participants.set(p.id, await this.openParticipant(p.id, schema, this.peers()));
    }

    const lower = (a: string) => a.toLowerCase();
    const d = this.deployment;
    this.directory = {
      ledgers: [LEDGER],
      startBlocks: { [LEDGER]: await this.client.getBlockNumber() },
      participants: Object.fromEntries(Object.entries(d.participants).map(([id, p]) => [id, { address: lower(p.address), kind: p.kind }])),
      customers: Object.fromEntries(Object.entries(d.customers).map(([ref, c]) => [ref, { address: lower(c.address), bank: c.bank }])),
      tokens: Object.fromEntries(
        Object.entries(d.tokens).map(([symbol, t]) => [symbol, { symbol, ledger: LEDGER, address: lower(t.address), kind: t.kind, issuer: t.issuer, currency: t.currency }]),
      ),
    };
    this.observer = new ChainObserver({
      ledger: LEDGER,
      client: this.client,
      directory: this.directory,
      registry: d.contracts.registry,
      settlers: [d.contracts.engine],
      settlerAbi: this.engineAbi(),
      identify: (tx) => this.identify(tx.hash, tx.logs),
    });
    this.options.log?.(`  deployed ${scenario.id} afresh from block ${this.directory.startBlocks[LEDGER]}`);
    return this.directory;
  }

  private peers(): Peers {
    return {
      approve: (participant, flow) => this.live(participant).approve(flow),
      requestFunding: async (cb, flow) => {
        await this.live(cb).receiveFunding(flow);
      },
      quote: (dealer, request) => this.live(dealer).quote(request),
      requestChange: async (participant, request) => {
        await this.live(participant).receiveChange(request);
      },
      custodyWallet: (bank) => this.live(bank).custodyWallet(),
      marginCall: async (participant, call) => {
        await this.live(participant).receiveMarginCall(call);
      },
    };
  }

  private live(id: string): Participant {
    const p = this.participants.get(id);
    if (!p || this.down.has(id)) throw new PeerUnavailable(id, new Error("down"));
    return p;
  }

  // ---------------------------------------------------------------- flows

  async submit(flow: KitFlow): Promise<Outcome> {
    if (flow.kind === "repo-open") this.opened.set(flow.id, { lender: flow.lender, borrower: flow.borrower });
    const started = await this.start(flow);
    if ("status" in started) return started;
    return this.finish(started.request, started.submitter, started.quote);
  }

  /** Ask the participant that starts `flow` to start it; a refusal before anything was sent is an outcome. */
  private async start(flow: KitFlow): Promise<{ request: FlowRequest; submitter: string; quote?: Outcome["quote"] } | Outcome> {
    try {
      const amount = (v: bigint) => v.toString();
      let request: FlowRequest;
      let initiator: string;
      let quote: Outcome["quote"];
      switch (flow.kind) {
        case "fund":
        case "redeem":
          request = { kind: flow.kind, uetr: flow.id, bank: flow.bank, currency: flow.currency, amount: amount(flow.amount) };
          initiator = flow.bank;
          break;
        case "tokenize":
        case "detokenize":
          request = { kind: flow.kind, uetr: flow.id, bank: flow.bank, customer: flow.customer, amount: amount(flow.amount) };
          initiator = flow.bank;
          break;
        case "pay":
          request = { kind: "interbank", uetr: flow.id, payerBank: flow.payerBank, payer: flow.payer, payeeBank: flow.payeeBank, payee: flow.payee, amount: amount(flow.amount) };
          initiator = flow.payerBank;
          break;
        case "pay-fx": {
          const to = depositOf(this.scenario, flow.payeeBank).currency;
          const q = await this.live(flow.payerBank).requestQuote(to, amount(flow.amount));
          quote = { rate: q.rate, source: BigInt(q.sourceAmount), target: BigInt(q.targetAmount) };
          request = { kind: "pvp", uetr: flow.id, payerBank: flow.payerBank, payer: flow.payer, payeeBank: flow.payeeBank, payee: flow.payee, quote: q };
          initiator = flow.payerBank;
          break;
        }
        case "bond-issue": {
          const allocations = flow.allocations.map((a) => ({ bank: a.bank, units: amount(a.units) }));
          const affirmed = { kind: "bond-issue" as const, uetr: flow.id, bond: flow.bond, price: amount(flow.price), allocations };
          for (const a of flow.allocations) await affirmAs(this.live(a.bank), affirmed);
          request = affirmed;
          initiator = this.agentOf(flow.bond);
          break;
        }
        case "bond-trade": {
          const trade = { kind: "bond-trade" as const, uetr: flow.id, bond: flow.bond, seller: flow.seller, buyer: flow.buyer, units: amount(flow.units), price: amount(flow.price) };
          await affirmAs(this.live(flow.buyer), trade);
          request = trade;
          initiator = flow.seller;
          break;
        }
        case "bond-payment": {
          const agent = this.agentOf(flow.bond);
          const row = await payNextAs(this.live(agent), flow.bond, flow.id);
          return { request: { ...row.flow, uetr: row.uetr } as FlowRequest, submitter: agent };
        }
        // Repo (SPEC.md §5.7–§5.10): the side that does not submit affirms first, or calls the margin; the other
        // side starts it under the same id. What follows from marks and terms, each bank computes itself.
        case "repo-open": {
          const open = {
            kind: "repo-open" as const,
            uetr: flow.id,
            lender: flow.lender,
            borrower: flow.borrower,
            bond: flow.bond,
            units: amount(flow.units),
            mark: amount(flow.mark),
            cash: amount(flow.cash),
            rate: flow.rate,
            haircut: flow.haircut,
            startDate: flow.startDate,
            endDate: flow.endDate,
          };
          await affirmAs(this.live(flow.lender), open);
          request = open;
          initiator = flow.borrower;
          break;
        }
        case "repo-margin": {
          const marks = flow.marks.map((m) => ({ bond: m.bond, price: amount(m.price) }));
          const plan = await planMargin(this.anyParty(flow.repo).rt, flow.repo, marks, flow.asOf, flow.bond);
          const call = { ...plan, uetr: flow.id };
          const [caller, deliverer] = plan.direction === "deliver" ? [plan.lender, plan.borrower] : [plan.borrower, plan.lender];
          await affirmAs(this.live(caller), call);
          request = call;
          initiator = deliverer;
          break;
        }
        case "repo-substitute": {
          const marks = flow.marks.map((m) => ({ bond: m.bond, price: amount(m.price) }));
          const outgoing = { bond: flow.outgoing.bond, units: amount(flow.outgoing.units) };
          const plan = await planSubstitution(this.anyParty(flow.repo).rt, flow.repo, outgoing, flow.incoming, marks, flow.asOf);
          const swap = { ...plan, uetr: flow.id };
          await affirmAs(this.live(plan.lender), swap);
          request = swap;
          initiator = plan.borrower;
          break;
        }
        case "repo-close": {
          const borrower = this.repoParties(flow.repo).borrower;
          request = { ...(await planClose(this.live(borrower).rt, flow.repo)), uetr: flow.id };
          initiator = borrower;
          break;
        }
      }
      // As the initiator's operators would: one starts it, others approve it as its policy asks.
      const row = await act(this.live(initiator), request, (id) => (this.down.has(id) ? undefined : this.participants.get(id)));
      return { request: { ...request, uetr: row.uetr } as FlowRequest, submitter: submitterOf(row.flow, this.flowContext()), ...(quote ? { quote } : {}) };
    } catch (error) {
      if (error instanceof FlowRejected) return { status: "refused", reason: `${error.reason}: ${error.message}` };
      if (error instanceof PeerUnavailable) return { status: "refused", reason: `peer-unavailable: ${error.message}` };
      throw error;
    }
  }

  /** A repo's lender and borrower, from the books of whichever bank holds its record. */
  private repoParties(id: string): { lender: string; borrower: string } {
    const flow = this.opened.get(id);
    if (!flow) throw new FlowRejected("not-found", `No repo ${id} was opened in this run`);
    return flow;
  }

  /** The repo's lender, or its borrower when the lender is down: either keeps the record. */
  private anyParty(id: string): Participant {
    const { lender, borrower } = this.repoParties(id);
    return this.down.has(lender) ? this.live(borrower) : this.live(lender);
  }

  private agentOf(bond: string): string {
    return this.scenario.instruments.bonds.find((b) => b.symbol === bond)!.agent;
  }

  /** Drive every participant until the submitter's instruction settles or fails, and everyone has seen it. */
  private async finish(request: FlowRequest, submitter: string, quote?: Outcome["quote"]): Promise<Outcome> {
    const uetr = request.uetr!;
    let row = await this.live(submitter).instruction(uetr);
    let mined: bigint | undefined;
    await this.until(async () => {
      row = await this.live(submitter).instruction(uetr);
      if (row?.status === "settled" || row?.status === "failed" || row?.status === "expired") return true;
      // The engine accepted what was sent, whether or not the submitter's books ever post it: a broken
      // engine's settlement may never match what was booked.
      if (row?.status === "submitted" && row.txHash) {
        const receipt = await this.client.getTransactionReceipt({ hash: row.txHash as Hex }).catch(() => undefined);
        if (receipt?.status === "success") mined = receipt.blockNumber;
      }
      return mined !== undefined;
    }, `${request.kind} ${uetr} to settle or fail at ${submitter}`);
    const extra = quote ? { quote } : {};
    if (row?.status !== "settled" && mined === undefined) return { status: "refused", reason: row?.lastError ?? row?.status ?? "unknown", ...extra };
    await this.caughtUp(row?.status === "settled" ? BigInt(row.settledBlock!) : mined!);
    return { status: "settled", ...extra };
  }

  /** Tick every live participant until `done`, a block at a time on a chain that mines on demand. */
  private async until(done: () => Promise<boolean>, what: string): Promise<void> {
    const onAnvil = this.options.chain?.kind !== "network";
    const deadline = Date.now() + (onAnvil ? 60_000 : ((this.options.deadlineSeconds ?? 600) + 60) * 1000);
    for (;;) {
      for (const [id, p] of this.participants) if (!this.down.has(id)) await p.tick();
      if (await done()) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      if (!onAnvil) await sleep(500);
    }
  }

  private async cursor(p: Participant): Promise<bigint> {
    const rows = (await p.rt.books.database.execute(sql`SELECT last_block::text AS b FROM chain_cursor`)).rows;
    return rows[0] ? BigInt(String(rows[0]["b"])) : -1n;
  }

  /** Wait until every live participant's listener has processed `block`. */
  private async caughtUp(block: bigint, only?: string): Promise<void> {
    await this.until(async () => {
      for (const [id, p] of this.participants) {
        if (this.down.has(id) || (only && id !== only)) continue;
        if ((await this.cursor(p)) < block) return false;
      }
      return true;
    }, `every participant to process block ${block}`);
  }

  async quiesce(): Promise<void> {
    await this.caughtUp(await this.client.getBlockNumber());
  }

  head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  observe(_ledger: string, block: bigint): Promise<Observation> {
    return this.observer.observe(block);
  }

  /** Who sent a transaction, the instruction it settled, and every co-signature valid over what it settled. */
  private async identify(hash: Hex, logs: Parameters<typeof engineId>[0]): Promise<{ id: string | null; approvers: string[] }> {
    const tx = await this.client.getTransaction({ hash });
    const participantAt = (a: string) => Object.entries(this.deployment.participants).find(([, p]) => p.address.toLowerCase() === a.toLowerCase())?.[0];
    const sender = participantAt(tx.from);
    const approvers = sender ? [sender] : [];
    const id = engineId(logs, this.deployment.contracts.engine);
    if (!id) return { id: null, approvers };
    try {
      const { args } = decodeFunctionData({ abi: this.engineAbi(), data: tx.input });
      const [instruction, approvals] = args as unknown as [ChainInstruction, readonly Approval[]];
      const digest = instructionDigest(this.network.chainId, this.deployment.contracts.engine, instruction);
      for (const approval of approvals) {
        const signer = await recoverAddress({ hash: digest, signature: approval.signature }).catch(() => undefined);
        const participant = signer && signer.toLowerCase() === approval.signer.toLowerCase() ? participantAt(signer) : undefined;
        if (participant && !approvers.includes(participant)) approvers.push(participant);
      }
    } catch {
      // Not a call the engine's ABI describes: only its sender approved it.
    }
    return { id: kitId(id), approvers };
  }

  async books(participant: string, block: bigint): Promise<Books> {
    const p = this.participants.get(participant)!;
    const trial = await p.rt.books.trialBalanceAtBlock(block);
    const balance = (code: string) => trial.accounts.find((a) => a.code === code)?.posted.minor ?? 0n;
    const under = (control: string) => trial.accounts.filter((a) => a.code.startsWith(`${control}/`)).reduce((t, a) => t + a.posted.minor, 0n);
    const d = this.deployment;
    const meta = this.scenario.participants.find((x) => x.id === participant)!;
    const addr = (party: string) => (d.participants[party]?.address ?? d.customers[party]!.address).toLowerCase();
    const imbalance = Object.fromEntries([...trial.totals].map(([currency, total]) => [currency, total]));
    if (meta.kind === "central-bank") {
      const symbol = wholesaleFor(this.scenario, meta.currency!).symbol;
      return {
        imbalance,
        holdings: this.scenario.participants
          .filter((b) => b.kind === "bank" && b.reserves.includes(meta.currency!))
          .map((b) => ({ token: symbol, holder: addr(b.id), amount: balance(centralBankAccounts.wholesaleLine(b.id)) })),
        issued: [{ token: symbol, amount: under(centralBankAccounts.wholesaleOutstanding) }],
      };
    }
    const deposit = depositOf(this.scenario, participant).symbol;
    const customers = Object.entries(d.customers).filter(([, c]) => c.bank === participant).map(([ref]) => ref);
    return {
      imbalance,
      holdings: [
        ...meta.reserves.map((c) => ({ token: wholesaleFor(this.scenario, c).symbol, holder: addr(participant), amount: balance(bankAccounts.wholesaleReserves(c)) })),
        ...customers.map((ref) => ({ token: deposit, holder: addr(ref), amount: balance(bankAccounts.tokenizedDeposit(ref.slice(participant.length + 1))) })),
        // Its own units, plus collateral it received and less collateral it pledged in repos (SPEC.md §5.7).
        ...this.scenario.instruments.bonds.map((b) => ({
          token: b.symbol,
          holder: addr(participant),
          amount:
            (balance(bankAccounts.bondHolding(b.symbol)) +
              (this.scenario.repo ? balance(bankAccounts.collateralReceivedIn(b.symbol)) - balance(bankAccounts.collateralPledgedIn(b.symbol)) : 0n)) /
            parseMoney(b.currency, b.face).minor,
        })),
        // A custodian's omnibus wallet as deployed (SPEC.md §15): what it holds for clients, off its balance sheet.
        ...(d.custody?.[participant]
          ? this.scenario.instruments.bonds.map((b) => ({
              token: b.symbol,
              holder: d.custody![participant]!.wallet.toLowerCase(),
              amount: balance(bankAccounts.custodyHolding(b.symbol)) / parseMoney(b.currency, b.face).minor,
            }))
          : []),
      ],
      issued: [{ token: deposit, amount: under(bankAccounts.tokenizedDeposits) }],
      deposits: under(bankAccounts.customerDeposits) + under(bankAccounts.tokenizedDeposits),
      ...(this.scenario.repo
        ? {
            repos: (await recordsAt(p.rt.books.database, block)).map((r) => ({
              repo: r.repo,
              role: r.role,
              collateral: r.collateral.map((c) => ({ bond: c.bond, units: BigInt(c.units) })),
            })),
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------- faults

  async fault(step: FaultStep): Promise<FaultReport> {
    switch (step.fault) {
      case "participant-down":
        return this.participantDown(step.participant, step.flows);
      case "duplicate-submission":
        return this.duplicateSubmission(step.flow);
      case "stale-approval":
        return this.staleApproval(step.flow);
      case "missing-approval":
        return this.missingApproval(step.flow);
      case "frozen-payer":
        return this.frozenPayer(step.flow);
      case "ineligible-payee":
        return this.ineligiblePayee(step.flow);
      default:
        throw new FaultNotApplicable("the sandbox's engine stages its own faults, not interop mode's");
    }
  }

  /** Close a participant's runtime while flows among the others settle, then reopen it from its schema. */
  private async participantDown(id: string, flows: readonly KitFlow[]): Promise<FaultReport> {
    const p = this.participants.get(id)!;
    const schema = p.rt.books.schema;
    await p.close();
    this.down.add(id);
    const submitted = [];
    try {
      for (const flow of flows) submitted.push({ flow, outcome: await this.submit(flow) });
    } finally {
      this.down.delete(id);
      this.participants.set(id, await this.openParticipant(id, schema, this.peers()));
    }
    const head = await this.client.getBlockNumber();
    await this.caughtUp(head, id);
    return { submitted, attempts: [], note: `${id} down while ${submitted.length} flows ran; back, caught up to block ${head}` };
  }

  /** The same payment asked for three times at once, then sent to the engine again once settled. */
  private async duplicateSubmission(flow: PaymentFlow): Promise<FaultReport> {
    const answers = await Promise.all([0, 1, 2].map(() => this.start(flow)));
    const first = answers[0]!;
    const outcome = "status" in first ? first : await this.finish(first.request, first.submitter);
    if (outcome.status !== "settled") return { submitted: [{ flow, outcome }], attempts: [], note: `the payment itself was refused: ${outcome.reason}` };
    const row = (await this.live(flow.payerBank).instruction(flow.id))!;
    const again = await this.rawSettle(flow.payerBank, legsOf(row.flow, this.flowContext()), row.approvals);
    return {
      submitted: [{ flow, outcome }],
      attempts: [{ flow, carried: [flow.payeeBank], outcome: again }],
      note: `3 requests, one instruction; resubmitted on chain: ${again.status === "settled" ? "settled again" : again.reason}`,
    };
  }

  /** A co-signature over other legs (the amount one more), and one past its deadline. */
  private async staleApproval(flow: PaymentFlow): Promise<FaultReport> {
    const now = Number((await this.client.getBlock()).timestamp);
    const base = this.interbank(flow, now + 600);
    const payee = privateKeyToAccount(devKeys.participant(flow.payeeBank));
    const engine = this.deployment.contracts.engine;
    const signed = await approve(payee, this.network.chainId, engine, legsOf(base, this.flowContext()));
    const altered = { ...flow, amount: flow.amount + 1n };
    const first = await this.rawSettle(flow.payerBank, legsOf(this.interbank(altered, now + 600), this.flowContext()), [signed]);
    const late = { ...flow, id: randomUUID() };
    const lateFlow = this.interbank(late, now - 10);
    const second = await this.rawSettle(flow.payerBank, legsOf(lateFlow, this.flowContext()), [await approve(payee, this.network.chainId, engine, legsOf(lateFlow, this.flowContext()))]);
    const attempts: Attempt[] = [
      { flow: altered, carried: [flow.payeeBank], outcome: first },
      { flow: late, carried: [flow.payeeBank], outcome: second },
    ];
    return { submitted: [], attempts, note: `approval for other legs: ${first.reason ?? first.status}; past its deadline: ${second.reason ?? second.status}` };
  }

  /** The payer's bank sends the payment to the engine itself, without asking the payee's bank. */
  private async missingApproval(flow: PaymentFlow): Promise<FaultReport> {
    const now = Number((await this.client.getBlock()).timestamp);
    const outcome = await this.rawSettle(flow.payerBank, legsOf(this.interbank(flow, now + 600), this.flowContext()), []);
    return { submitted: [], attempts: [{ flow, carried: [], outcome }], note: `without ${flow.payeeBank}'s signature: ${outcome.reason ?? outcome.status}` };
  }

  /** The payer's bank freezes its customer's whole balance on chain, then the payment runs as any. */
  private async frozenPayer(flow: PaymentFlow): Promise<FaultReport> {
    const token = this.deployment.tokens[depositOf(this.scenario, flow.payerBank).symbol]!.address;
    const holder = this.deployment.customers[`${flow.payerBank}/${flow.payer}`]!.address;
    const held = (await this.client.readContract({ address: token, abi: contracts.DepositToken.abi, functionName: "balanceOf", args: [holder] })) as bigint;
    if (held === 0n) throw new FaultNotApplicable(`${flow.payer} holds no ${depositOf(this.scenario, flow.payerBank).symbol} to freeze`);
    await this.tokenCall(flow.payerBank, token, "setFrozenTokens", [holder, held]);
    let outcome: Outcome;
    try {
      outcome = await this.submit(flow);
    } finally {
      await this.tokenCall(flow.payerBank, token, "setFrozenTokens", [holder, 0n]);
    }
    return { submitted: [{ flow, outcome }], attempts: [], note: `${flow.payer}'s ${held} frozen: ${outcome.reason ?? outcome.status}` };
  }

  /** The payee's bank takes its customer off the allowlist on chain, then the payment runs as any. */
  private async ineligiblePayee(flow: PaymentFlow): Promise<FaultReport> {
    const token = this.deployment.tokens[depositOf(this.scenario, flow.payeeBank).symbol]!.address;
    const holder = this.deployment.customers[`${flow.payeeBank}/${flow.payee}`]!.address;
    await this.tokenCall(flow.payeeBank, token, "resetHolder", [holder]);
    let outcome: Outcome;
    try {
      outcome = await this.submit(flow);
    } finally {
      await this.tokenCall(flow.payeeBank, token, "allowHolder", [holder]);
    }
    return { submitted: [{ flow, outcome }], attempts: [], note: `${flow.payee} off ${flow.payeeBank}'s allowlist: ${outcome.reason ?? outcome.status}` };
  }

  private flowContext() {
    return { scenario: this.scenario, deployment: this.deployment };
  }

  private interbank(flow: PaymentFlow, deadline: number): Flow {
    return { kind: "interbank", uetr: flow.id, deadline, payerBank: flow.payerBank, payer: flow.payer, payeeBank: flow.payeeBank, payee: flow.payee, amount: flow.amount.toString() };
  }

  private wallet(participant: string) {
    return createWalletClient({
      account: privateKeyToAccount(devKeys.participant(participant)),
      chain: sandboxChain(this.network.chainId, rpcUrlFor(this.network, participant)),
      transport: http(),
    });
  }

  /** Send an instruction straight to the engine as `submitter`: refused with the engine's reason, or mined. */
  private async rawSettle(submitter: string, instruction: ChainInstruction, approvals: readonly Approval[]): Promise<Outcome> {
    const wallet = this.wallet(submitter);
    const call = {
      address: this.deployment.contracts.engine,
      abi: contracts.SettlementEngine.abi,
      functionName: "settle",
      args: [{ ...instruction, legs: [...instruction.legs] }, [...approvals]],
      account: wallet.account,
    } as const;
    try {
      await this.client.simulateContract(call);
    } catch (error) {
      return { status: "refused", reason: revertName(error) ?? (error as Error).message.split("\n")[0]! };
    }
    const hash = await wallet.writeContract({ ...call, chain: wallet.chain, ...ZERO_FEES });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { status: "refused", reason: `reverted in block ${receipt.blockNumber}` };
    await this.caughtUp(receipt.blockNumber);
    return { status: "settled" };
  }

  private async tokenCall(participant: string, token: Address, functionName: string, args: readonly unknown[]): Promise<void> {
    const wallet = this.wallet(participant);
    const hash = await wallet.writeContract({ address: token, abi: contracts.DepositToken.abi, functionName, args, account: wallet.account, chain: wallet.chain, ...ZERO_FEES } as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} on ${token} reverted`);
  }

  // ---------------------------------------------------------------- lifecycle

  private async teardown(): Promise<void> {
    for (const p of this.participants.values()) await p.close().catch(() => {});
    this.participants.clear();
    this.down.clear();
    if (this.schemas.length > 0) {
      const pool = new pg.Pool({ connectionString: this.databaseUrl, max: 1 });
      for (const schema of this.schemas.splice(0)) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
    this.anvil?.stop();
    this.anvil = undefined;
  }

  close(): Promise<void> {
    return this.teardown();
  }
}
