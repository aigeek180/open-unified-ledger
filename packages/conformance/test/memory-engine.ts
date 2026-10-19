import { Decimal, convert, type CurrencyCode, minorUnit, money, parseRate, toDecimal } from "@oul/domain";
import { centralBankFor, dealerOf, depositOf, fxRate, type Scenario, wholesaleFor } from "@oul/scenario";
import type {
  Books,
  Capabilities,
  Directory,
  EngineAdapter,
  FaultReport,
  HolderStatus,
  Movement,
  Observation,
  Outcome,
  Settlement,
} from "../src/adapter.ts";
import { FaultNotApplicable } from "../src/adapter.ts";
import type { FaultStep, KitFlow, PaymentFlow } from "../src/flows.ts";

/**
 * A settlement engine in memory, for the kit's own tests: one ledger as
 * maps, every participant's books as maps, and the rules of SPEC.md §4.2
 * (all legs or none, once per id, each leg's authority, eligible receivers,
 * frozen balances). Each defect breaks one rule the way a broken engine of
 * SPEC.md §14 does, so the kit's checks can be shown to catch it without a
 * chain. The sandbox's real engine is tested in sandbox.test.ts.
 */

export type Defect = "split-legs" | "no-once" | "lax-mint" | "open-deposit" | "book-refused" | "round-twice";

interface Leg {
  readonly token: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly amount: bigint;
}

class Refused extends Error {}

const ALL_FAULTS: FaultStep["fault"][] = [
  "participant-down",
  "duplicate-submission",
  "stale-approval",
  "missing-approval",
  "frozen-payer",
  "ineligible-payee",
];

export class MemoryEngine implements EngineAdapter {
  readonly name: string;
  readonly capabilities: Capabilities = {
    flows: ["fund", "redeem", "tokenize", "detokenize", "pay", "pay-fx"],
    faults: ALL_FAULTS,
    books: true,
  };
  private readonly defects: ReadonlySet<Defect>;
  private scenario!: Scenario;
  private directory!: Directory;
  private blocks: Observation[] = [];
  private balances = new Map<string, bigint>();
  private frozen = new Map<string, bigint>();
  private admitted = new Set<string>();
  private settled = new Set<string>();
  private ledgers = new Map<string, BookState>();
  private bookHistory: Map<string, Books>[] = [];
  private pending: Settlement[] = [];

  constructor(defects: readonly Defect[] = []) {
    this.defects = new Set(defects);
    this.name = defects.length ? `memory (${defects.join(", ")})` : "memory";
  }

  async reset(scenario: Scenario): Promise<Directory> {
    this.scenario = scenario;
    const addr = (label: string) => `0x${Buffer.from(label).toString("hex").padEnd(40, "0").slice(0, 40)}`;
    const participants: Record<string, { address: string; kind: "central-bank" | "bank" }> = {};
    for (const p of scenario.participants) if (p.kind !== "issuer") participants[p.id] = { address: addr(`p:${p.id}`), kind: p.kind };
    const customers: Record<string, { address: string; bank: string }> = {};
    for (const l of scenario.ledgers) for (const c of l.customers) customers[`${l.participant}/${c.id}`] = { address: addr(`c:${l.participant}/${c.id}`), bank: l.participant };
    const tokens: Directory["tokens"] = Object.fromEntries([
      ...scenario.instruments.wholesale.map((t) => [t.symbol, { symbol: t.symbol, ledger: "memory", address: addr(`t:${t.symbol}`), kind: "wholesale" as const, issuer: t.issuer, currency: t.currency }]),
      ...scenario.instruments.deposits.map((t) => [t.symbol, { symbol: t.symbol, ledger: "memory", address: addr(`t:${t.symbol}`), kind: "deposit" as const, issuer: t.issuer, currency: t.currency }]),
    ]);
    this.directory = { ledgers: ["memory"], startBlocks: { memory: 0n }, participants, customers, tokens };
    this.balances = new Map();
    this.frozen = new Map();
    this.settled = new Set();
    this.admitted = new Set();
    for (const t of scenario.instruments.wholesale) {
      for (const b of scenario.participants.filter((p) => p.reserves.includes(t.currency))) this.admitted.add(`${t.symbol}|${participants[b.id]!.address}`);
    }
    for (const [ref, c] of Object.entries(customers)) this.admitted.add(`${depositOf(scenario, c.bank).symbol}|${customers[ref]!.address}`);
    this.ledgers = new Map();
    for (const l of scenario.ledgers) {
      const deposits = l.opening.filter((line) => line.account.startsWith("customer-deposits/")).reduce((t, line) => t + line.amount.minor, 0n);
      this.ledgers.set(l.participant, { holdings: new Map(), issued: new Map(), deposits, imbalance: 0n });
    }
    // Every mirrored balance and every issued token opens at zero in its keeper's books.
    for (const t of [...scenario.instruments.wholesale, ...scenario.instruments.deposits]) this.ledgers.get(t.issuer)!.issued.set(t.symbol, 0n);
    for (const t of scenario.instruments.wholesale) {
      for (const b of scenario.participants.filter((p) => p.reserves.includes(t.currency))) {
        const k = this.key(t.symbol, participants[b.id]!.address);
        this.ledgers.get(t.issuer)!.holdings.set(k, 0n);
        this.ledgers.get(b.id)!.holdings.set(k, 0n);
      }
    }
    for (const c of Object.values(customers)) this.ledgers.get(c.bank)!.holdings.set(this.key(depositOf(scenario, c.bank).symbol, c.address), 0n);
    this.blocks = [];
    this.bookHistory = [];
    this.mine();
    return this.directory;
  }

  // ------------------------------------------------------------------ the ledger

  private key(token: string, holder: string) {
    return `${token}|${holder}`;
  }

  private address(party: string) {
    return (this.directory.participants[party] ?? this.directory.customers[party])!.address;
  }

  private mine() {
    const block = BigInt(this.blocks.length);
    const tokens = Object.keys(this.directory.tokens);
    const holders = [...Object.values(this.directory.participants), ...Object.values(this.directory.customers)].map((p) => p.address);
    const balances = tokens.flatMap((token) => holders.map((holder) => ({ token, holder, amount: this.balances.get(this.key(token, holder)) ?? 0n })));
    const statuses: HolderStatus[] = tokens.flatMap((token) =>
      holders.map((holder) => ({ token, holder, admitted: this.admitted.has(this.key(token, holder)), frozen: this.frozen.get(this.key(token, holder)) ?? 0n })),
    );
    const supplies = Object.fromEntries(tokens.map((t) => [t, balances.filter((b) => b.token === t).reduce((s, b) => s + b.amount, 0n)]));
    this.blocks.push({ ledger: "memory", block, time: 1_800_000_000n + block, settlements: this.pending.map((s) => ({ ...s, block })), balances, supplies, holders: statuses });
    this.pending = [];
    this.bookHistory.push(new Map([...this.ledgers].map(([id, b]) => [id, this.snapshot(id, b)])));
  }

  private snapshot(participant: string, b: BookState): Books {
    const currency = this.scenario.ledgers.find((l) => l.participant === participant) ? this.currencyOf(participant) : "CAD";
    return {
      imbalance: { [currency]: b.imbalance },
      holdings: [...b.holdings].map(([k, amount]) => {
        const [token, holder] = k.split("|") as [string, string];
        return { token, holder, amount };
      }),
      issued: [...b.issued].map(([token, amount]) => ({ token, amount })),
      ...(this.directory.participants[participant]?.kind === "bank" ? { deposits: b.deposits } : {}),
    };
  }

  private currencyOf(participant: string): CurrencyCode {
    const p = this.scenario.participants.find((x) => x.id === participant)!;
    return p.kind === "central-bank" ? p.currency! : depositOf(this.scenario, participant).currency;
  }

  /** Apply legs in one transaction (one block), or each in its own with split-legs; refuse on the first that fails. */
  private settle(id: string, legs: readonly Leg[], approvers: readonly string[]): void {
    if (this.settled.has(id) && !this.defects.has("no-once")) throw new Refused("AlreadySettled");
    for (const leg of legs) this.authorize(leg, approvers);
    if (this.defects.has("split-legs")) {
      this.settled.add(id);
      for (const leg of legs) {
        this.check([leg]);
        this.apply([leg], id, approvers);
        this.mine();
      }
      return;
    }
    this.check(legs);
    this.settled.add(id);
    this.apply(legs, id, approvers);
    this.mine();
  }

  private authorize(leg: Leg, approvers: readonly string[]) {
    const issuer = this.directory.tokens[leg.token]!.issuer;
    const holder = leg.from && Object.entries(this.directory.participants).find(([, p]) => p.address === leg.from)?.[0];
    const needed = leg.from === null ? issuer : (holder ?? issuer);
    if (leg.from === null && this.defects.has("lax-mint")) return;
    if (!approvers.includes(needed)) throw new Refused(`MissingApproval(${needed})`);
  }

  private check(legs: readonly Leg[]) {
    const after = new Map(this.balances);
    for (const leg of legs) {
      if (leg.from) {
        const k = this.key(leg.token, leg.from);
        const held = after.get(k) ?? 0n;
        if (held - (this.frozen.get(k) ?? 0n) < leg.amount) throw new Refused("ERC20InsufficientUnfrozenBalance");
        after.set(k, held - leg.amount);
      }
      if (leg.to) {
        const token = this.directory.tokens[leg.token]!;
        const open = this.defects.has("open-deposit") && token.kind === "deposit";
        if (!open && !this.admitted.has(this.key(leg.token, leg.to))) throw new Refused("ERC20UserRestricted");
        after.set(this.key(leg.token, leg.to), (after.get(this.key(leg.token, leg.to)) ?? 0n) + leg.amount);
      }
    }
  }

  private apply(legs: readonly Leg[], id: string, approvers: readonly string[]) {
    for (const leg of legs) {
      if (leg.from) this.balances.set(this.key(leg.token, leg.from), (this.balances.get(this.key(leg.token, leg.from)) ?? 0n) - leg.amount);
      if (leg.to) this.balances.set(this.key(leg.token, leg.to), (this.balances.get(this.key(leg.token, leg.to)) ?? 0n) + leg.amount);
    }
    const movements: Movement[] = legs.map((l) => ({ token: l.token, from: l.from, to: l.to, amount: l.amount }));
    this.pending.push({ ledger: "memory", block: 0n, tx: `0x${id.replaceAll("-", "")}${this.pending.length}`, index: this.pending.length, id, approvers, movements });
  }

  // ------------------------------------------------------------------ flows

  private target(flow: Extract<KitFlow, { kind: "pay-fx" }>): bigint {
    const [from, to] = [depositOf(this.scenario, flow.payerBank).currency, depositOf(this.scenario, flow.payeeBank).currency];
    const rate = fxRate(this.scenario, from, to)!;
    if (!this.defects.has("round-twice")) return convert(money(from, flow.amount), rate, to).minor;
    const exact = toDecimal(money(from, flow.amount)).times(parseRate(rate)).times(new Decimal(10).toPower(minorUnit(to)));
    return BigInt(exact.toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
  }

  private legs(flow: KitFlow): { legs: Leg[]; submitter: string; cosigners: string[]; target?: bigint } {
    const s = this.scenario;
    const w = (c: CurrencyCode) => wholesaleFor(s, c).symbol;
    const d = (bank: string) => depositOf(s, bank).symbol;
    const a = (party: string) => this.address(party);
    switch (flow.kind) {
      case "fund":
        return { legs: [{ token: w(flow.currency), from: null, to: a(flow.bank), amount: flow.amount }], submitter: centralBankFor(s, flow.currency).id, cosigners: [] };
      case "redeem":
        return { legs: [{ token: w(flow.currency), from: a(flow.bank), to: null, amount: flow.amount }], submitter: flow.bank, cosigners: [] };
      case "tokenize":
        return { legs: [{ token: d(flow.bank), from: null, to: a(`${flow.bank}/${flow.customer}`), amount: flow.amount }], submitter: flow.bank, cosigners: [] };
      case "detokenize":
        return { legs: [{ token: d(flow.bank), from: a(`${flow.bank}/${flow.customer}`), to: null, amount: flow.amount }], submitter: flow.bank, cosigners: [] };
      case "pay": {
        const c = depositOf(s, flow.payerBank).currency;
        return {
          legs: [
            { token: d(flow.payerBank), from: a(`${flow.payerBank}/${flow.payer}`), to: null, amount: flow.amount },
            { token: w(c), from: a(flow.payerBank), to: a(flow.payeeBank), amount: flow.amount },
            { token: d(flow.payeeBank), from: null, to: a(`${flow.payeeBank}/${flow.payee}`), amount: flow.amount },
          ],
          submitter: flow.payerBank,
          cosigners: [flow.payeeBank],
        };
      }
      case "pay-fx": {
        const dealer = dealerOf(s)!;
        const [from, to] = [depositOf(s, flow.payerBank).currency, depositOf(s, flow.payeeBank).currency];
        const target = this.target(flow);
        return {
          legs: [
            { token: d(flow.payerBank), from: a(`${flow.payerBank}/${flow.payer}`), to: null, amount: flow.amount },
            { token: w(from), from: a(flow.payerBank), to: a(dealer), amount: flow.amount },
            { token: w(to), from: a(dealer), to: a(flow.payeeBank), amount: target },
            { token: d(flow.payeeBank), from: null, to: a(`${flow.payeeBank}/${flow.payee}`), amount: target },
          ],
          submitter: flow.payerBank,
          cosigners: [dealer, flow.payeeBank],
          target,
        };
      }
      default:
        throw new Refused(`the memory engine settles no ${flow.kind}`);
    }
  }

  /** What each participant books for a flow, applied when it settles (or, with book-refused, when refused too). */
  private book(flow: KitFlow, legs: readonly Leg[]) {
    for (const leg of legs) {
      const token = this.directory.tokens[leg.token]!;
      const issuerBooks = this.ledgers.get(token.issuer)!;
      const delta = (leg.to ? leg.amount : 0n) - (leg.from ? leg.amount : 0n);
      if (!leg.from || !leg.to) issuerBooks.issued.set(leg.token, (issuerBooks.issued.get(leg.token) ?? 0n) + delta);
      for (const [holder, sign] of [[leg.from, -1n], [leg.to, 1n]] as const) {
        if (!holder) continue;
        const keeper = token.kind === "wholesale" ? [token.issuer, this.participantAt(holder)] : [token.issuer];
        for (const k of keeper) {
          if (!k) continue;
          const b = this.ledgers.get(k)!;
          b.holdings.set(this.key(leg.token, holder), (b.holdings.get(this.key(leg.token, holder)) ?? 0n) + sign * leg.amount);
        }
      }
    }
    if (flow.kind === "pay" || flow.kind === "pay-fx") {
      const payer = this.ledgers.get(flow.payerBank)!;
      const payee = this.ledgers.get(flow.payeeBank)!;
      payer.deposits -= legs[0]!.amount;
      payee.deposits += legs.at(-1)!.amount;
    }
  }

  private participantAt(address: string) {
    return Object.entries(this.directory.participants).find(([, p]) => p.address === address)?.[0];
  }

  async submit(flow: KitFlow): Promise<Outcome> {
    let plan;
    try {
      plan = this.legs(flow);
    } catch (error) {
      return { status: "refused", reason: (error as Error).message };
    }
    const quote = plan.target === undefined ? undefined : { rate: fxRate(this.scenario, depositOf(this.scenario, (flow as PaymentFlow).payerBank).currency, depositOf(this.scenario, (flow as PaymentFlow).payeeBank).currency)!, source: (flow as PaymentFlow).amount, target: plan.target };
    if (this.settled.has(flow.id)) return { status: "settled", ...(quote ? { quote } : {}) };
    try {
      this.settle(flow.id, plan.legs, [plan.submitter, ...plan.cosigners]);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (this.defects.has("book-refused") && flow.kind === "pay") {
        this.book(flow, plan.legs);
        this.mine();
      }
      return { status: "refused", reason: error.message, ...(quote ? { quote } : {}) };
    }
    this.book(flow, plan.legs);
    this.bookHistory[this.bookHistory.length - 1] = new Map([...this.ledgers].map(([id, b]) => [id, this.snapshot(id, b)]));
    return { status: "settled", ...(quote ? { quote } : {}) };
  }

  async fault(step: FaultStep): Promise<FaultReport> {
    switch (step.fault) {
      case "participant-down": {
        const submitted = [];
        for (const flow of step.flows) submitted.push({ flow, outcome: await this.submit(flow) });
        return { submitted, attempts: [], note: `${step.participant} down for ${step.flows.length} flows` };
      }
      case "duplicate-submission": {
        const outcomes = await Promise.all([0, 1, 2].map(() => this.submit(step.flow)));
        const plan = this.legs(step.flow);
        const again = this.attempt(step.flow, plan.legs, [plan.submitter, ...plan.cosigners]);
        return { submitted: [{ flow: step.flow, outcome: outcomes[0]! }], attempts: [{ flow: step.flow, carried: plan.cosigners, outcome: again }], note: `resubmitted: ${again.reason ?? again.status}` };
      }
      case "stale-approval":
        return { submitted: [], attempts: [{ flow: step.flow, carried: [], outcome: { status: "refused", reason: "InvalidApproval" } }], note: "InvalidApproval" };
      case "missing-approval": {
        const plan = this.legs(step.flow);
        const outcome = this.attempt(step.flow, plan.legs, [plan.submitter]);
        return { submitted: [], attempts: [{ flow: step.flow, carried: [], outcome }], note: outcome.reason ?? outcome.status };
      }
      case "frozen-payer": {
        const k = this.key(depositOf(this.scenario, step.flow.payerBank).symbol, this.address(`${step.flow.payerBank}/${step.flow.payer}`));
        this.frozen.set(k, this.balances.get(k) ?? 0n);
        this.mine();
        const outcome = await this.submit(step.flow);
        this.frozen.delete(k);
        this.mine();
        return { submitted: [{ flow: step.flow, outcome }], attempts: [], note: outcome.reason ?? outcome.status };
      }
      case "ineligible-payee": {
        const k = this.key(depositOf(this.scenario, step.flow.payeeBank).symbol, this.address(`${step.flow.payeeBank}/${step.flow.payee}`));
        this.admitted.delete(k);
        this.mine();
        const outcome = await this.submit(step.flow);
        this.admitted.add(k);
        this.mine();
        return { submitted: [{ flow: step.flow, outcome }], attempts: [], note: outcome.reason ?? outcome.status };
      }
      default:
        throw new FaultNotApplicable(`the memory engine stages no ${step.fault}`);
    }
  }

  /** Straight to the engine, around the participants: nothing is booked. */
  private attempt(flow: KitFlow, legs: readonly Leg[], approvers: readonly string[]): Outcome {
    try {
      this.settle(flow.id, legs, approvers);
      return { status: "settled" };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return { status: "refused", reason: error.message };
    }
  }

  async head(): Promise<bigint> {
    return BigInt(this.blocks.length - 1);
  }

  async observe(_ledger: string, block: bigint): Promise<Observation> {
    return this.blocks[Number(block)]!;
  }

  async books(participant: string, block: bigint): Promise<Books> {
    return this.bookHistory[Number(block)]!.get(participant)!;
  }

  async quiesce(): Promise<void> {}

  async close(): Promise<void> {}
}

interface BookState {
  holdings: Map<string, bigint>;
  issued: Map<string, bigint>;
  deposits: bigint;
  imbalance: bigint;
}
