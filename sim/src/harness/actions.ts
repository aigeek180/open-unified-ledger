import {
  type Approval,
  type ChainInstruction,
  contracts,
  type Deployment,
  devKeys,
  type Network,
  rpcUrlFor,
  sandboxChain,
  ZERO_FEES,
} from "@oul/chain";
import { bankAccounts, formatMoney, money, parseMoney } from "@oul/domain";
import type { CurrencyCode } from "@oul/domain";
import { centralBanks, depositOf, operatorToken, registryOperator, type Scenario } from "@oul/scenario";
import { serviceUrl } from "@oul/service";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  type Hex,
  http,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import type { Services } from "../launch.ts";
import type { Action, Model, Rng } from "./model.ts";

/** What every harness step works with: the services, the model, the chain. */
export class Harness {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
  readonly network: Network;
  readonly services: Services;
  readonly model: Model;
  readonly rng: Rng;
  /** The central bank that operates the registry; the chain is read through its node. */
  readonly cb: string;
  /** Every central bank, one per currency. */
  readonly centralBanks: string[];
  readonly banks: string[];
  readonly client: PublicClient;

  constructor(init: { scenario: Scenario; deployment: Deployment; network: Network; services: Services; model: Model; rng: Rng }) {
    this.scenario = init.scenario;
    this.deployment = init.deployment;
    this.network = init.network;
    this.services = init.services;
    this.model = init.model;
    this.rng = init.rng;
    this.cb = registryOperator(init.scenario).id;
    this.centralBanks = centralBanks(init.scenario).map((p) => p.id);
    this.banks = [...init.model.banks.keys()];
    this.client = this.clientFor(this.cb);
  }

  clientFor(participant: string): PublicClient {
    return createPublicClient({
      chain: sandboxChain(this.network.chainId, rpcUrlFor(this.network, participant)),
      transport: http(),
      cacheTime: 0,
    }) as PublicClient;
  }

  /** The currency of a bank's own deposits. */
  currencyOf(bank: string): CurrencyCode {
    return depositOf(this.scenario, bank).currency;
  }

  /** An amount in major units, in a currency or in a bank's own. */
  amount(minor: bigint, currency: CurrencyCode): string {
    return formatMoney(money(currency, minor));
  }

  /**
   * A request to a participant's service. A POST outside `/peer/*` comes from
   * one of its operators (SPEC.md §15): its first operator allowed to start
   * flows unless one is named.
   */
  async api(participant: string, method: "GET" | "POST", route: string, body?: unknown, operator?: string) {
    const by = method === "POST" && !route.startsWith("/peer/") ? (operator ?? this.starter(participant)) : undefined;
    const response = await fetch(`${serviceUrl(this.scenario, participant)}${route}`, {
      method,
      headers: {
        ...(by ? { authorization: `Bearer ${operatorToken(participant, by)}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: response.status, body: json };
  }

  /** The operator that starts flows at `participant`: its first holding the operator role. */
  starter(participant: string): string {
    const operators = this.scenario.operators[participant]?.operators ?? [];
    return (operators.find((o) => o.roles.includes("operator")) ?? operators[0])!.id;
  }

  /**
   * Approve what waits for `participant`'s policy under `subject`, as its
   * approvers would: each operator other than the initiator holding a role the
   * policy names, one after another, until it is met. A proposal another
   * request already settled is left as it is.
   */
  async approvePending(participant: string, subject: string): Promise<number> {
    let given = 0;
    for (let round = 0; round < 6; round++) {
      const proposal = await this.api(participant, "GET", `/proposals/${subject}`);
      if (proposal.status !== 200 || proposal.body["status"] !== "open") return given;
      const decided = new Set((proposal.body["decisions"] as { operator: string }[]).map((d) => d.operator));
      const roles = proposal.body["roles"] as string[];
      const next = (this.scenario.operators[participant]?.operators ?? []).find(
        (o) => `operator:${o.id}` !== proposal.body["initiator"] && !decided.has(o.id) && o.roles.some((r) => roles.includes(r)),
      );
      if (!next) throw new Error(`no operator of ${participant} is left to approve ${subject}`);
      const answer = await this.api(participant, "POST", `/proposals/${subject}/decisions`, { decision: "approve" }, next.id);
      if (answer.status === 200) given++;
      else if (answer.status !== 409) throw new Error(`approving ${subject} at ${participant}: ${answer.status} ${answer.body["detail"] ?? answer.body["title"]}`);
    }
    return given;
  }

  /** Wait until the instruction reaches one of `statuses` at every participant listed. */
  async waitFor(uetr: string, participants: readonly string[], statuses: readonly string[], timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last: string[] = [];
    while (Date.now() < deadline) {
      const views = await Promise.all(participants.map((p) => this.api(p, "GET", `/instructions/${uetr}`).catch(() => undefined)));
      last = views.map((v) => String(v?.body["status"] ?? "unreachable"));
      if (last.every((s) => statuses.includes(s))) return views.map((v) => v!.body);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`${uetr} is ${last.join("/")} at ${participants.join("/")}, not ${statuses.join(" or ")}`);
  }

  /** Wait until it settled everywhere listed; a failure or expiry is an error. Returns its block. */
  async settled(uetr: string, participants: readonly string[]): Promise<string> {
    const views = await this.waitFor(uetr, participants, ["settled", "failed", "expired"]);
    const bad = views.find((v) => v["status"] !== "settled");
    if (bad) throw new Error(`${uetr} ${bad["status"]}: ${bad["error"]}`);
    return String(views[0]!["settledBlock"]);
  }

  /**
   * Re-read every bank's balances from its own service: in serve mode an
   * operator may start flows from the console, which the model would not
   * otherwise know of. Available balances, since that is what a flow can
   * spend. Served runs are interactive, so their seed fixes the choices but
   * not the balances they start from.
   */
  async syncModel(): Promise<void> {
    for (const bank of this.banks) {
      const minor = (amount: string, currency = this.currencyOf(bank)) => parseMoney(currency, amount).minor;
      const accounts = (await this.api(bank, "GET", "/accounts")).body["accounts"] as { account: string; posted: string; available: string }[];
      const customers = (await this.api(bank, "GET", "/customers")).body["customers"] as {
        customer: string;
        deposit: { available: string };
        tokenized: { available: string };
      }[];
      const state = this.model.banks.get(bank)!;
      for (const currency of state.rtgs.keys()) {
        state.rtgs.set(currency, minor(accounts.find((a) => a.account === bankAccounts.rtgsReserves(currency))?.available ?? "0", currency));
        state.wholesale.set(currency, minor(accounts.find((a) => a.account === bankAccounts.wholesaleReserves(currency))?.available ?? "0", currency));
      }
      for (const c of customers) {
        state.deposits.set(c.customer, minor(c.deposit.available));
        state.tokenized.set(c.customer, minor(c.tokenized.available));
      }
      // With repo: the units of each collateral bond it may pledge, and the repos it lends under.
      for (const [bond, held] of this.model.bonds) {
        const face = parseMoney(this.currencyOf(bank), this.scenario.instruments.bonds.find((b) => b.symbol === bond)!.face).minor;
        const of = (code: string, field: "posted" | "available") => minor(accounts.find((a) => a.account === code)?.[field] ?? "0");
        held.set(bank, (of(bankAccounts.bondHolding(bond), "available") - of(bankAccounts.collateralPledgedIn(bond), "posted")) / face);
      }
    }
    if (this.scenario.repo) {
      this.model.repos.length = 0;
      for (const bank of this.banks) {
        const repos = (await this.api(bank, "GET", "/repos")).body["repos"] as {
          id: string;
          role: string;
          status: string;
          counterparty: string;
          terms: { amount: string; rate: string; haircut: string; startDate: string; endDate: string };
          collateral: { bond: string; units: string }[];
        }[];
        for (const r of repos.filter((x) => x.role === "lender" && x.status === "open")) {
          const currency = this.currencyOf(bank);
          this.model.repos.push({
            id: r.id,
            lender: bank,
            borrower: r.counterparty,
            terms: { cash: parseMoney(currency, r.terms.amount), rate: r.terms.rate, haircut: r.terms.haircut, startDate: r.terms.startDate, endDate: r.terms.endDate, dayCount: "ACT/365F" },
            collateral: r.collateral.map((c) => ({ bond: c.bond, units: BigInt(c.units) })),
          });
        }
      }
    }
  }

  describe(action: Action): string {
    switch (action.kind) {
      case "fund":
      case "redeem":
        return `${action.kind} ${action.bank} ${this.amount(action.amount, action.currency)} ${action.currency}`;
      case "tokenize":
      case "detokenize":
        return `${action.kind} ${action.bank}/${action.customer} ${this.amount(action.amount, this.currencyOf(action.bank))}`;
      case "pay":
        return `pay ${action.payerBank}/${action.payer} → ${action.payeeBank}/${action.payee} ${this.amount(action.amount, this.currencyOf(action.payerBank))}${action.overspend ? " (more than held)" : ""}`;
      case "pvp": {
        const [from, to] = [this.currencyOf(action.payerBank), this.currencyOf(action.payeeBank)];
        return `pay ${action.payerBank}/${action.payer} → ${action.payeeBank}/${action.payee} ${this.amount(action.amount, from)} ${from} → ${this.amount(action.target, to)} ${to} through ${action.dealer}`;
      }
      case "bond-issue":
        return `issue ${action.bond} to ${action.allocations.map((a) => `${a.bank} ${a.units}`).join(", ")}`;
      case "repo-open":
        return `repo ${action.borrower} borrows ${formatMoney(action.terms.cash)} from ${action.lender} against ${action.units} ${action.bond} at ${action.terms.rate} to ${action.terms.endDate}`;
      case "repo-margin": {
        const repo = this.model.repo(action.repo);
        return action.direction === "deliver"
          ? `repo margin ${repo.borrower} delivers ${action.units} ${action.bond} on ${repo.lender}'s call (${action.asOf})`
          : `repo margin ${repo.lender} returns ${action.units} ${action.bond} on ${repo.borrower}'s call (${action.asOf})`;
      }
      case "repo-substitute":
        return `repo substitution ${action.incoming.units} ${action.incoming.bond} for ${action.outgoing.units} ${action.outgoing.bond}`;
      case "repo-close":
        return `repo close ${this.model.repo(action.repo).borrower} repays ${this.amount(action.repay, this.model.repo(action.repo).terms.cash.currency)}`;
    }
  }

  /** A mark over HTTP: major units per unit. */
  private marks(marks: readonly { bond: string; price: { currency: CurrencyCode; minor: bigint } }[]) {
    return marks.map((m) => ({ bond: m.bond, price: this.amount(m.price.minor, m.price.currency) }));
  }

  /** Start a repo flow or the prelude's issue, through the API as each side's operators would. */
  private async startBondOrRepo(action: Extract<Action, { kind: "bond-issue" | `repo-${string}` }>, uetr?: string) {
    const ok = async (participant: string, route: string, body: unknown, status = 201) => {
      const answer = await this.api(participant, "POST", route, body);
      if (answer.status !== status) throw new Error(`${route} at ${participant}: ${answer.status} ${answer.body["detail"] ?? answer.body["title"]}`);
      return answer.body;
    };
    switch (action.kind) {
      case "bond-issue": {
        const id = uetr ?? randomUUID();
        const face = this.scenario.instruments.bonds.find((b) => b.symbol === action.bond)!.face;
        for (const a of action.allocations) {
          await ok(a.bank, `/bonds/${action.bond}/affirmations`, { kind: "issue", uetr: id, units: a.units.toString(), price: face });
          await this.approvePending(a.bank, id);
        }
        return this.api(action.agent, "POST", `/bonds/${action.bond}/issue`, { uetr: id, price: face, allocations: action.allocations.map((a) => ({ bank: a.bank, units: a.units.toString() })) });
      }
      case "repo-open": {
        const currency = action.terms.cash.currency;
        const terms = {
          uetr: action.id,
          bond: action.bond,
          units: action.units.toString(),
          mark: this.amount(action.mark, currency),
          cash: formatMoney(action.terms.cash),
          rate: action.terms.rate,
          haircut: action.terms.haircut,
          startDate: action.terms.startDate,
          endDate: action.terms.endDate,
        };
        await ok(action.lender, "/repos/affirmations", { ...terms, borrower: action.borrower });
        await this.approvePending(action.lender, action.id);
        return this.api(action.borrower, "POST", "/repos", { ...terms, lender: action.lender });
      }
      case "repo-margin": {
        const repo = this.model.repo(action.repo);
        const [caller, deliverer] = action.direction === "deliver" ? [repo.lender, repo.borrower] : [repo.borrower, repo.lender];
        const call = await ok(caller, `/repos/${action.repo}/margin-calls`, { marks: this.marks(action.marks), asOf: action.asOf, bond: action.bond });
        // Invariant 14 from outside: the caller's service calls exactly the margin the marks give.
        if (call["direction"] !== action.direction || call["units"] !== action.units.toString()) {
          throw new Error(`the margin call is to ${call["direction"]} ${call["units"]}, the model's to ${action.direction} ${action.units}`);
        }
        await this.approvePending(caller, String(call["call"]));
        return this.api(deliverer, "POST", `/repos/${action.repo}/margin`, { call: call["call"] });
      }
      case "repo-substitute": {
        const repo = this.model.repo(action.repo);
        const id = uetr ?? randomUUID();
        const body = { uetr: id, outgoing: { bond: action.outgoing.bond, units: action.outgoing.units.toString() }, incoming: action.incoming.bond, marks: this.marks(action.marks), asOf: action.asOf };
        const affirmed = await ok(repo.lender, `/repos/${action.repo}/substitutions/affirmations`, body);
        if (affirmed["incoming"]?.["units"] !== action.incoming.units.toString()) {
          throw new Error(`the substitution brings in ${affirmed["incoming"]?.["units"]} units, the model's ${action.incoming.units}`);
        }
        await this.approvePending(repo.lender, id);
        return this.api(repo.borrower, "POST", `/repos/${action.repo}/substitutions`, body);
      }
      case "repo-close": {
        const repo = this.model.repo(action.repo);
        const closed = await this.api(repo.borrower, "POST", `/repos/${action.repo}/close`, uetr ? { uetr } : {});
        // Principal plus interest, ACT/365F, rounded once, half-even: what the model computes too.
        if (closed.status === 202 && parseMoney(repo.terms.cash.currency, String(closed.body["amount"])).minor !== action.repay) {
          throw new Error(`the close repays ${closed.body["amount"]}, the model ${this.amount(action.repay, repo.terms.cash.currency)}`);
        }
        return closed;
      }
    }
  }

  /** Start an action through the API; returns its UETR, or undefined for an expected refusal. */
  async start(action: Action, uetr?: string): Promise<string | undefined> {
    const extra = uetr ? { uetr } : {};
    let response;
    switch (action.kind) {
      case "bond-issue":
      case "repo-open":
      case "repo-margin":
      case "repo-substitute":
      case "repo-close":
        response = await this.startBondOrRepo(action, uetr);
        break;
      case "fund":
      case "redeem":
        response = await this.api(action.bank, "POST", `/wholesale/${action.kind}`, {
          amount: this.amount(action.amount, action.currency),
          currency: action.currency,
          ...extra,
        });
        break;
      case "tokenize":
      case "detokenize":
        response = await this.api(action.bank, "POST", `/customers/${action.customer}/${action.kind}`, {
          amount: this.amount(action.amount, this.currencyOf(action.bank)),
          ...extra,
        });
        break;
      case "pvp": {
        // Ask the dealer for a quote through the payer's bank: it must price the amount exactly as the
        // model does from the scenario's rate (invariant 11, from outside), then pay at it.
        const to = this.currencyOf(action.payeeBank);
        const quote = await this.api(action.payerBank, "POST", "/fx/quotes", { to, amount: this.amount(action.amount, this.currencyOf(action.payerBank)) });
        if (quote.status !== 201) throw new Error(`quote: ${quote.status} ${quote.body["detail"] ?? quote.body["title"]}`);
        const target = parseMoney(to, String(quote.body["target"]["amount"])).minor;
        if (target !== action.target) throw new Error(`the dealer quoted ${target} for ${action.target} (invariant 11)`);
        response = await this.api(action.payerBank, "POST", "/payments", {
          payer: action.payer,
          payeeBank: action.payeeBank,
          payee: action.payee,
          quote: quote.body["id"],
          ...extra,
        });
        break;
      }
      case "pay":
        response = await this.api(action.payerBank, "POST", "/payments", {
          payer: action.payer,
          payeeBank: action.payeeBank,
          payee: action.payee,
          amount: this.amount(action.amount, this.currencyOf(action.payerBank)),
          ...extra,
        });
        if (action.overspend) {
          if (response.status !== 422) throw new Error(`an overspend was answered ${response.status}, not 422`);
          return undefined;
        }
        break;
    }
    if (response.status !== 202) throw new Error(`${action.kind}: ${response.status} ${response.body["detail"] ?? response.body["title"]}`);
    const started = String(response.body["uetr"]);
    // Above a policy's threshold the initiator holds it until an approver approves; funding may then wait at
    // the central bank too, under its own policy for minting.
    for (const participant of this.bookers(action)) await this.approvePending(participant, started);
    return started;
  }

  /** The participants that book an action, whose status says it settled. */
  bookers(action: Action): string[] {
    switch (action.kind) {
      case "fund":
        return [action.bank, centralBanks(this.scenario).find((p) => p.currency === action.currency)!.id];
      case "redeem":
      case "tokenize":
      case "detokenize":
        return [action.bank];
      case "pay":
        return [action.payerBank, action.payeeBank];
      case "pvp":
        return [action.payerBank, action.dealer, action.payeeBank];
      case "bond-issue":
        return [action.agent, ...action.allocations.map((a) => a.bank)];
      case "repo-open":
        return [action.lender, action.borrower];
      case "repo-margin":
      case "repo-substitute":
      case "repo-close": {
        const repo = this.model.repo(action.repo);
        return [repo.lender, repo.borrower];
      }
    }
  }

  /** Perform an action to its outcome, keeping the model in step. */
  async perform(action: Action): Promise<string> {
    const uetr = await this.start(action);
    if (!uetr) return "refused: insufficient funds";
    const block = await this.settled(uetr, this.bookers(action));
    this.model.apply(action);
    return `settled in block ${block}`;
  }

  // ---------------------------------------------------------------- raw chain access, for faults

  wallet(participant: string) {
    return createWalletClient({
      account: privateKeyToAccount(devKeys.participant(participant)),
      chain: sandboxChain(this.network.chainId, rpcUrlFor(this.network, this.cb)),
      transport: http(),
    });
  }

  async chainTime(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }

  /** Call a token's admin function with a participant's own key, and wait for it to be mined. */
  async tokenCall(participant: string, token: Address, functionName: string, args: readonly unknown[]): Promise<void> {
    const hash = await this.wallet(participant).writeContract({
      address: token,
      abi: contracts.DepositToken.abi,
      functionName,
      args,
      ...ZERO_FEES,
    } as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  }

  /**
   * Submit an instruction to the engine directly, behind the services' backs,
   * as a buggy or malicious participant could. Returns the engine's refusal,
   * having also mined the transaction to show it reverts on chain.
   */
  async rawSettle(submitter: string, instruction: ChainInstruction, approvals: readonly Approval[]): Promise<string> {
    const args = [{ ...instruction, legs: [...instruction.legs] }, [...approvals]] as const;
    const engine = this.deployment.contracts.engine;
    let reason = "accepted";
    try {
      await this.client.simulateContract({
        address: engine,
        abi: contracts.SettlementEngine.abi,
        functionName: "settle",
        args,
        account: this.wallet(submitter).account,
      });
    } catch (error) {
      reason = revertName(error) ?? String(error);
    }
    if (reason === "accepted") return reason;
    const hash = await this.wallet(submitter).writeContract({
      address: engine,
      abi: contracts.SettlementEngine.abi,
      functionName: "settle",
      args,
      gas: 1_000_000n,
      ...ZERO_FEES,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "reverted") return "accepted";
    return reason;
  }
}

const ALL_ERRORS = Object.values(contracts).flatMap((c) => c.abi.filter((item) => item.type === "error"));

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
