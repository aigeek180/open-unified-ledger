import { addDays, type CurrencyCode, marginCall, parseMoney, repurchasePrice, substitutionUnits } from "@oul/domain";
import { centralBankFor, dealerOf, fxRate, type Scenario } from "@oul/scenario";
import type { Capabilities } from "./adapter.ts";
import { type FaultKind, type FaultStep, type FlowKind, type KitFlow, type KitRepo, kitMarks, type PaymentFlow, repoCurrency, type Step } from "./flows.ts";
import type { Model, Rng } from "./model.ts";
import { nearHalf } from "./rounding.ts";

/**
 * Seeded random sequences (SPEC.md §14): one step at a time, drawn from the
 * kit's model as it stands after the steps before, so every flow proposed
 * can settle, but for about one payment in twenty that asks for more than
 * the payer holds and must be refused. With a fault rate above zero, faults
 * the adapter declares are mixed in. The same seed proposes the same steps
 * against any engine that settles the same flows.
 */

/** Who must take part in a flow for it to go anywhere. */
export function partiesOf(flow: KitFlow, scenario: Scenario, repo: (id: string) => KitRepo | undefined = () => undefined): string[] {
  switch (flow.kind) {
    case "fund":
    case "redeem":
      return [flow.bank, centralBankFor(scenario, flow.currency).id];
    case "tokenize":
    case "detokenize":
      return [flow.bank];
    case "pay":
      return [flow.payerBank, flow.payeeBank];
    case "pay-fx":
      return [flow.payerBank, flow.payeeBank, dealerOf(scenario)!];
    case "bond-issue":
      return [agentOf(scenario, flow.bond), ...flow.allocations.map((a) => a.bank)];
    case "bond-trade":
      return [flow.seller, flow.buyer];
    case "bond-payment":
      return [agentOf(scenario, flow.bond), ...scenario.participants.filter((p) => p.kind === "bank").map((p) => p.id)];
    case "repo-open":
      return [flow.lender, flow.borrower];
    case "repo-margin":
    case "repo-substitute":
    case "repo-close": {
      // A repo's two banks, as the model knows them; every bank when it does not.
      const known = repo(flow.repo);
      return known ? [known.lender, known.borrower] : scenario.participants.filter((p) => p.kind === "bank").map((p) => p.id);
    }
  }
}

const agentOf = (scenario: Scenario, bond: string) => scenario.instruments.bonds.find((b) => b.symbol === bond)!.agent;

export interface Restriction {
  /** Participants that are down: no flow may need them. */
  readonly without?: readonly string[];
  readonly kinds?: readonly FlowKind[];
}

export class Generator {
  private readonly model: Model;
  private readonly rng: Rng;
  private readonly capabilities: Capabilities;
  private readonly faultRate: number;
  private readonly scenario: Scenario;

  constructor(model: Model, rng: Rng, capabilities: Capabilities, faultRate = 0) {
    this.model = model;
    this.rng = rng;
    this.capabilities = capabilities;
    this.faultRate = faultRate;
    this.scenario = model.scenario;
  }

  /** The next step: a fault, at the fault rate, if one can be staged now; otherwise a flow. */
  next(): Step {
    if (this.faultRate > 0 && this.capabilities.faults.length > 0 && this.rng.next() < this.faultRate) {
      const fault = this.fault(this.rng.pick(this.capabilities.faults));
      if (fault) return { fault };
    }
    return { flow: this.flow() };
  }

  /** A fault of this kind over the model as it stands, or undefined if there is nothing for it to act on yet. */
  fault(kind: FaultKind): FaultStep | undefined {
    if (kind === "participant-down") {
      const candidates = this.scenario.participants.filter((p) => p.kind !== "issuer").map((p) => p.id);
      const participant = this.rng.pick(candidates);
      const flows: KitFlow[] = [];
      for (let i = 0; i < 2; i++) {
        const flow = this.tryFlow({ without: [participant] });
        if (flow) flows.push(flow);
      }
      return { fault: kind, participant, flows };
    }
    // A coordinator's faults are staged on a payment of whatever kind the engine moves across its ledgers.
    // A fault's payment takes at most an eighth of what can be spent, so several in a row each have funds.
    const coordinator = kind === "coordinator-crash" || kind === "message-loss" || kind === "participant-offline" || kind === "late-commit";
    const flow = coordinator && !this.capabilities.flows.includes("pay") ? this.payFx(8n) : this.payment({ feasible: true, fraction: 8n });
    return flow ? ({ fault: kind, flow } as FaultStep) : undefined;
  }

  /** The payments the engine can make: its routes, or between any two banks. */
  private routes(sameCurrency: boolean): { payerBank: string; payer?: string; payeeBank: string; payee?: string }[] {
    const same = (a: string, b: string) => this.model.bank(a).currency === this.model.bank(b).currency;
    if (this.capabilities.routes) return this.capabilities.routes.filter((r) => same(r.payerBank, r.payeeBank) === sameCurrency);
    return this.banks().flatMap((a) => this.banks().filter((b) => b !== a && same(a, b) === sameCurrency).map((b) => ({ payerBank: a, payeeBank: b })));
  }

  /** A flow the model says can settle, or about one in twenty that must be refused. */
  flow(restriction: Restriction = {}): KitFlow {
    const flow = this.tryFlow(restriction);
    if (!flow) throw new Error("No flow is possible under these restrictions");
    return flow;
  }

  private tryFlow(restriction: Restriction): KitFlow | undefined {
    const kinds = this.capabilities.flows.filter((k) => !restriction.kinds || restriction.kinds.includes(k));
    const down = new Set(restriction.without ?? []);
    const ok = (flow: KitFlow | undefined) => flow && partiesOf(flow, this.scenario, (id) => this.model.repo(id)).every((p) => !down.has(p)) ? flow : undefined;
    for (let attempt = 0; attempt < 2000; attempt++) {
      const roll = this.rng.next();
      let flow: KitFlow | undefined;
      if (roll < 0.12) flow = this.has(kinds, "fund") ? this.fund() : undefined;
      else if (roll < 0.16) flow = this.has(kinds, "redeem") ? this.redeem() : undefined;
      else if (roll < 0.38) flow = this.has(kinds, "tokenize") ? this.tokenize() : undefined;
      else if (roll < 0.46) flow = this.has(kinds, "detokenize") ? this.detokenize() : undefined;
      else if (roll < 0.88) {
        // With a dealer, half the payments cross currencies.
        const fx = this.has(kinds, "pay-fx") && dealerOf(this.scenario) !== undefined && this.rng.next() < 0.5;
        flow = fx ? this.fxOrWhatItNeeds(kinds) : this.payment({ feasible: this.rng.next() >= 0.05, kinds });
      } else flow = this.scenario.repo && this.rng.next() < 0.6 ? this.repoFlow(kinds) : this.bondFlow(kinds);
      const allowed = ok(flow);
      if (allowed) return allowed;
    }
    return undefined;
  }

  private has(kinds: readonly FlowKind[], kind: FlowKind) {
    return kinds.includes(kind);
  }

  private banks(): string[] {
    return [...this.model.banks.keys()];
  }

  private reserveCurrency(bank: string): CurrencyCode {
    return this.rng.pick([...this.model.bank(bank).rtgs.keys()]);
  }

  private customerOf(bank: string): string {
    return this.rng.pick([...this.model.bank(bank).deposits.keys()]);
  }

  private fund(): KitFlow {
    const bank = this.rng.pick(this.banks());
    const currency = this.reserveCurrency(bank);
    return { kind: "fund", id: this.rng.uetr(), bank, currency, amount: this.rng.share(this.model.bank(bank).rtgs.get(currency)! / 20n) };
  }

  private redeem(): KitFlow | undefined {
    const bank = this.rng.pick(this.banks());
    const currency = this.reserveCurrency(bank);
    const held = this.model.wholesale(bank, currency);
    if (held === 0n) return undefined;
    return { kind: "redeem", id: this.rng.uetr(), bank, currency, amount: this.rng.share(held / 4n) };
  }

  private tokenize(): KitFlow {
    const bank = this.rng.pick(this.banks());
    const customer = this.customerOf(bank);
    return { kind: "tokenize", id: this.rng.uetr(), bank, customer, amount: this.rng.share(this.model.bank(bank).deposits.get(customer)! / 1000n) };
  }

  private detokenize(): KitFlow | undefined {
    const bank = this.rng.pick(this.banks());
    const customer = this.customerOf(bank);
    const held = this.model.bank(bank).tokenized.get(customer)!;
    if (held === 0n) return undefined;
    return { kind: "detokenize", id: this.rng.uetr(), bank, customer, amount: this.rng.share(held) };
  }

  /**
   * A payment between two banks in the same currency: within what the payer
   * holds and its bank's reserves when `feasible`, otherwise for more than
   * the payer holds, which must be refused.
   */
  payment(options: { feasible: boolean; kinds?: readonly FlowKind[]; fraction?: bigint }): PaymentFlow | undefined {
    if (options.kinds && !options.kinds.includes("pay")) return undefined;
    const pairs = this.routes(true);
    if (pairs.length === 0) return undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const route = this.rng.pick(pairs);
      const { payerBank, payeeBank } = route;
      const payer = route.payer ?? this.customerOf(payerBank);
      const payee = route.payee ?? this.customerOf(payeeBank);
      const held = this.model.bank(payerBank).tokenized.get(payer)!;
      const reserves = this.model.wholesale(payerBank);
      const spendable = held < reserves ? held : reserves;
      const base = { kind: "pay" as const, id: this.rng.uetr(), payerBank, payer, payeeBank, payee };
      if (!options.feasible) return { ...base, amount: held + BigInt(this.rng.int(1, 100_000)) };
      const cap = spendable / (options.fraction ?? 1n);
      if (cap > 0n) return { ...base, amount: this.rng.share(cap) };
    }
    return undefined;
  }

  /** A payment into another currency through the dealer, which must hold enough of the target. */
  /**
   * A payment across currencies, or, when none can settle yet, the flow it
   * waits for: the payer's bank funding its reserves, the payer tokenizing
   * a deposit, or the dealer funding the currency it delivers.
   */
  private fxOrWhatItNeeds(kinds: readonly FlowKind[]): KitFlow | undefined {
    const fx = this.payFx();
    if (fx) return fx;
    const dealer = dealerOf(this.scenario);
    const routes = this.routes(false).filter((r) => r.payerBank !== dealer && r.payeeBank !== dealer);
    if (!dealer || routes.length === 0) return undefined;
    const route = this.rng.pick(routes);
    const [from, to] = [this.model.bank(route.payerBank).currency, this.model.bank(route.payeeBank).currency];
    const payer = route.payer ?? this.customerOf(route.payerBank);
    const fund = (bank: string, currency: CurrencyCode): KitFlow => ({ kind: "fund", id: this.rng.uetr(), bank, currency, amount: this.rng.share(this.model.bank(bank).rtgs.get(currency)! / 20n) });
    if (this.model.wholesale(route.payerBank, from) === 0n && kinds.includes("fund")) return fund(route.payerBank, from);
    if (this.model.bank(route.payerBank).tokenized.get(payer) === 0n && kinds.includes("tokenize")) {
      return { kind: "tokenize", id: this.rng.uetr(), bank: route.payerBank, customer: payer, amount: this.rng.share(this.model.bank(route.payerBank).deposits.get(payer)! / 1000n) };
    }
    if (kinds.includes("fund")) return fund(dealer, to);
    return undefined;
  }

  payFx(fraction = 1n): Extract<KitFlow, { kind: "pay-fx" }> | undefined {
    const dealer = dealerOf(this.scenario);
    if (!dealer) return undefined;
    const routes = this.routes(false).filter((r) => r.payerBank !== dealer && r.payeeBank !== dealer);
    if (routes.length === 0) return undefined;
    const route = this.rng.pick(routes);
    const { payerBank, payeeBank } = route;
    const [from, to] = [this.model.bank(payerBank).currency, this.model.bank(payeeBank).currency];
    const payer = route.payer ?? this.customerOf(payerBank);
    const payee = route.payee ?? this.customerOf(payeeBank);
    const held = this.model.bank(payerBank).tokenized.get(payer)!;
    const reserves = this.model.wholesale(payerBank);
    const spendable = (held < reserves ? held : reserves) / fraction;
    if (spendable === 0n) return undefined;
    let amount = this.rng.share(spendable);
    // Half the time, the nearest amount above it whose conversion lands near half a minor unit, where
    // rounding by any rule but once, half-even, shows.
    const rate = fxRate(this.scenario, from, to);
    if (rate && this.rng.next() < 0.5) {
      for (let s = amount; s <= spendable && s < amount + 100_000n; s++) {
        if (nearHalf(from, to, rate, s)) {
          amount = s;
          break;
        }
      }
    }
    const target = this.model.target(from, to, amount);
    if (!target || target > this.model.wholesale(dealer, to)) return undefined;
    return { kind: "pay-fx", id: this.rng.uetr(), payerBank, payer, payeeBank, payee, amount };
  }

  /**
   * A repo flow between banks that may lend and borrow (no collateral bond's
   * agent): open one at a mark near face, cash a little under what the units
   * cover; or margin, substitute or close an open one, when it can settle.
   */
  repoFlow(kinds: readonly FlowKind[]): KitFlow | undefined {
    const spec = this.scenario.repo;
    if (!spec) return undefined;
    const currency = repoCurrency(this.scenario);
    const faceOf = (bond: string) => parseMoney(currency, this.scenario.instruments.bonds.find((b) => b.symbol === bond)!.face).minor;
    const markNear = (bond: string, spread: number) => (faceOf(bond) * BigInt(1000 + this.rng.int(-spread, spread))) / 1000n;
    const agents = new Set(this.scenario.instruments.bonds.filter((b) => spec.collateral.includes(b.symbol)).map((b) => b.agent));
    const parties = this.banks().filter((b) => !agents.has(b));
    const open = this.model.openRepos();
    const roll = this.rng.next();
    if (open.length === 0 || roll < 0.3) {
      if (!kinds.includes("repo-open") || parties.length < 2) return undefined;
      const borrower = this.rng.pick(parties);
      const lender = this.rng.pick(parties.filter((p) => p !== borrower));
      const bond = this.rng.pick(spec.collateral);
      const free = this.model.freeUnits(borrower, bond);
      if (free < 10n) return undefined;
      const units = this.rng.share(free / 2n) + 1n;
      const mark = markNear(bond, 10);
      let cash = (((units * mark * 98n) / 100n) * BigInt(this.rng.int(800, 1000))) / 1000n;
      const available = this.model.wholesale(lender, currency) / 2n;
      if (cash > available) cash = available;
      if (cash < 100n) return undefined;
      const startDate = "2027-04-26";
      return {
        kind: "repo-open",
        id: this.rng.uetr(),
        lender,
        borrower,
        bond,
        units,
        mark,
        cash,
        rate: `0.0${this.rng.int(2000, 4500)}`,
        haircut: "0.02",
        startDate,
        endDate: addDays(startDate, this.rng.int(1, 30)),
      };
    }
    const repo = this.rng.pick(open);
    const days = Math.round((Date.parse(repo.terms.endDate) - Date.parse(repo.terms.startDate)) / 86_400_000);
    const asOf = addDays(repo.terms.startDate, this.rng.int(0, days));
    const marks = spec.collateral.map((bond) => ({ bond, price: markNear(bond, 40) }));
    if (roll < 0.6) {
      if (!kinds.includes("repo-margin")) return undefined;
      const bond = this.rng.pick(repo.collateral).bond;
      const call = marginCall(repo.terms, repo.collateral, kitMarks(marks, currency), asOf, bond);
      if (call.direction === "none") return undefined;
      if (call.direction === "deliver" && this.model.freeUnits(repo.borrower, bond) < call.units) return undefined;
      return { kind: "repo-margin", id: this.rng.uetr(), repo: repo.id, marks, asOf, bond };
    }
    if (roll < 0.8) {
      if (!kinds.includes("repo-substitute")) return undefined;
      const outgoing = this.rng.pick(repo.collateral);
      const others = spec.collateral.filter((b) => b !== outgoing.bond);
      if (others.length === 0) return undefined;
      const incoming = this.rng.pick(others);
      const units = substitutionUnits(outgoing, incoming, kitMarks(marks, currency), currency);
      if (this.model.freeUnits(repo.borrower, incoming) < units) return undefined;
      return { kind: "repo-substitute", id: this.rng.uetr(), repo: repo.id, outgoing, incoming, marks, asOf };
    }
    if (!kinds.includes("repo-close")) return undefined;
    if (this.model.wholesale(repo.borrower, currency) < repurchasePrice(repo.terms).minor) return undefined;
    return { kind: "repo-close", id: this.rng.uetr(), repo: repo.id };
  }

  private bondFlow(kinds: readonly FlowKind[]): KitFlow | undefined {
    const bonds = this.scenario.instruments.bonds;
    if (bonds.length === 0) return undefined;
    const spec = this.rng.pick(bonds);
    const face = parseMoney(spec.currency, spec.face).minor;
    const holders = this.banks().filter((b) => b !== spec.agent);
    const roll = this.rng.next();
    const price = (face * BigInt(this.rng.int(985, 1015))) / 1000n;
    if (roll < 0.4 && kinds.includes("bond-issue")) {
      // Issued until redeemed, within the issue size; never to its own agent.
      const left = spec.units - this.model.outstanding(spec.symbol);
      if (left <= 1n || this.model.redeemed(spec.symbol)) return undefined;
      const buyers = holders.filter((b) => this.model.wholesale(b, spec.currency) >= price);
      if (buyers.length === 0) return undefined;
      const chosen = buyers.filter(() => this.rng.next() < 0.6);
      const allocations = (chosen.length > 0 ? chosen : [this.rng.pick(buyers)]).map((bank) => {
        const affordable = this.model.wholesale(bank, spec.currency) / price;
        const cap = affordable < left / 2n ? affordable : left / 2n;
        return { bank, units: cap > 0n ? this.rng.share(cap) : 1n };
      });
      return { kind: "bond-issue", id: this.rng.uetr(), bond: spec.symbol, price, allocations };
    }
    if (roll < 0.75 && kinds.includes("bond-trade")) {
      // What a seller owns: not what it holds as a repo lender's collateral.
      const sellers = holders.filter((b) => this.model.freeUnits(b, spec.symbol) > 0n);
      if (sellers.length === 0) return undefined;
      const seller = this.rng.pick(sellers);
      const buyers = holders.filter((b) => b !== seller && this.model.wholesale(b, spec.currency) >= price);
      if (buyers.length === 0) return undefined;
      const buyer = this.rng.pick(buyers);
      const held = this.model.freeUnits(seller, spec.symbol);
      const affordable = this.model.wholesale(buyer, spec.currency) / price;
      const units = this.rng.share(held < affordable ? held : affordable);
      return { kind: "bond-trade", id: this.rng.uetr(), bond: spec.symbol, seller, buyer, units, price };
    }
    if (kinds.includes("bond-payment")) {
      const next = this.model.nextBondPayment(spec.symbol);
      if (!next) return undefined;
      // A bond held as repo collateral is not redeemed until its repos close (SPEC.md §5.10).
      if (next.final && this.model.openRepos().some((r) => r.collateral.some((c) => c.bond === spec.symbol))) return undefined;
      const due = next.payments.reduce((t, p) => t + p.amount, 0n);
      if (this.model.wholesale(spec.agent, spec.currency) < due) {
        // The agent pays from its own wholesale: fund it first.
        const rtgs = this.model.bank(spec.agent).rtgs.get(spec.currency)!;
        const amount = due * 2n < rtgs ? due * 2n : rtgs;
        return kinds.includes("fund") && amount > 0n ? { kind: "fund", id: this.rng.uetr(), bank: spec.agent, currency: spec.currency, amount } : undefined;
      }
      return { kind: "bond-payment", id: this.rng.uetr(), bond: spec.symbol };
    }
    return undefined;
  }
}
