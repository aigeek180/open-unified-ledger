import {
  type BondTerms,
  type BusinessCalendar,
  type CollateralLine,
  bankAccounts,
  marginCall,
  moveCollateral,
  repurchasePrice,
  substitutionUnits,
  convert,
  couponPayment,
  couponSchedule,
  type CurrencyCode,
  money,
  parseMoney,
  principal,
  weekdayNumbers,
} from "@oul/domain";
import { dealerOf, depositOf, fxRate, type Scenario, type ScenarioBond } from "@oul/scenario";
import { type KitFlow, type KitRepo, kitMarks, repoCurrency } from "./flows.ts";
import type { Directory, Outcome } from "./adapter.ts";

/**
 * What the kit expects every balance to be, from the flows it asked for and
 * their outcomes, so its generator only proposes flows that can settle (and,
 * on purpose, a few that must be refused). The model never reads the engine:
 * the same seed proposes the same flows against any engine that settles the
 * same ones. Checks do not use it; they judge what the engine reports.
 */

/** mulberry32: a small, fast, well-distributed 32-bit generator. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Nothing to pick from");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Between 1 and `max`, as a fraction of `max` in thousandths. */
  share(max: bigint): bigint {
    if (max <= 0n) return 0n;
    const amount = (max * BigInt(this.int(1, 1000))) / 1000n;
    return amount > 0n ? amount : 1n;
  }

  /** A version 4 UETR drawn from this generator, so a seed reproduces its ids too. */
  uetr(): string {
    const hex = Array.from({ length: 32 }, () => this.int(0, 15).toString(16));
    hex[12] = "4";
    hex[16] = "89ab"[this.int(0, 3)]!;
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

interface BankState {
  readonly currency: CurrencyCode;
  readonly rtgs: Map<CurrencyCode, bigint>;
  readonly wholesale: Map<CurrencyCode, bigint>;
  readonly deposits: Map<string, bigint>;
  readonly tokenized: Map<string, bigint>;
  readonly bonds: Map<string, bigint>;
}

/** A bond's next scheduled payment, as the kit computes it from the terms. */
export interface BondPayment {
  readonly final: boolean;
  readonly payments: readonly { readonly bank: string; readonly units: bigint; readonly amount: bigint }[];
  /** What the agent debits the issuer's deposit: the coupon on every unit, rounded once, and at the last, face. */
  readonly issuerDebit: bigint;
}

export class Model {
  readonly scenario: Scenario;
  readonly banks = new Map<string, BankState>();
  /** Payments made on each bond so far. */
  private readonly bondPaid = new Map<string, number>();
  /** Repos open, by the id of the flow that opened them, with the collateral their flows moved. */
  private readonly repos = new Map<string, KitRepo>();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    for (const ledger of scenario.ledgers) {
      const meta = scenario.participants.find((p) => p.id === ledger.participant);
      if (meta?.kind !== "bank") continue;
      const opening = (code: string) =>
        ledger.opening.filter((l) => l.account === code).reduce((t, l) => t + (l.side === "credit" ? l.amount.minor : -l.amount.minor), 0n);
      this.banks.set(ledger.participant, {
        currency: depositOf(scenario, ledger.participant).currency,
        rtgs: new Map(meta.reserves.map((c) => [c, -opening(bankAccounts.rtgsReserves(c))])),
        wholesale: new Map(meta.reserves.map((c) => [c, 0n])),
        deposits: new Map(ledger.customers.map((c) => [c.id, opening(bankAccounts.customerDeposit(c.id))])),
        tokenized: new Map(ledger.customers.map((c) => [c.id, 0n])),
        bonds: new Map(scenario.instruments.bonds.map((b) => [b.symbol, 0n])),
      });
    }
  }

  /** Start from what an engine's own setup funded, on top of the scenario's opening balances. */
  seed(funded: NonNullable<Directory["funded"]>): void {
    for (const w of funded.wholesale) this.bank(w.bank).wholesale.set(w.currency, w.amount);
    for (const t of funded.tokenized) this.bank(t.bank).tokenized.set(t.customer, t.amount);
  }

  bank(id: string): BankState {
    const state = this.banks.get(id);
    if (!state) throw new RangeError(`"${id}" is not a bank in ${this.scenario.id}`);
    return state;
  }

  /** A bank's wholesale in a currency: its own unless named. */
  wholesale(id: string, currency?: CurrencyCode): bigint {
    const state = this.bank(id);
    return state.wholesale.get(currency ?? state.currency) ?? 0n;
  }

  /** Every bank's units of a bond. */
  bondUnits(bond: string): ReadonlyMap<string, bigint> {
    return new Map([...this.banks].map(([id, s]) => [id, s.bonds.get(bond) ?? 0n]));
  }

  outstanding(bond: string): bigint {
    return [...this.bondUnits(bond).values()].reduce((t, u) => t + u, 0n);
  }

  /** The bond's next payment, or undefined once it is redeemed or before anything is outstanding. */
  nextBondPayment(bond: string): BondPayment | undefined {
    const spec = this.bondSpec(bond);
    const terms = bondTerms(spec);
    const schedule = couponSchedule(terms, calendarOf(this.scenario));
    const period = schedule[this.bondPaid.get(bond) ?? 0];
    if (!period) return undefined;
    const holdings = [...this.bondUnits(bond)].filter(([, u]) => u > 0n).map(([holder, units]) => ({ holder, units }));
    if (holdings.length === 0) return undefined;
    const coupon = couponPayment(terms, period, holdings);
    const outstanding = holdings.reduce((t, h) => t + h.units, 0n);
    return {
      final: period.final,
      issuerDebit: coupon.issuerDebit.minor + (period.final ? principal(terms, outstanding).minor : 0n),
      payments: coupon.payments.map((p) => ({
        bank: p.holder,
        units: p.units,
        amount: p.amount.minor + (period.final ? principal(terms, p.units).minor : 0n),
      })),
    };
  }

  repo(id: string): KitRepo | undefined {
    return this.repos.get(id);
  }

  openRepos(): KitRepo[] {
    return [...this.repos.values()];
  }

  /** A bank's units of a bond it owns: on its address, less what it holds there as a lender's collateral. */
  freeUnits(bank: string, bond: string): bigint {
    const held = this.openRepos()
      .filter((r) => r.lender === bank)
      .flatMap((r) => r.collateral)
      .filter((c) => c.bond === bond)
      .reduce((t, c) => t + c.units, 0n);
    return (this.bank(bank).bonds.get(bond) ?? 0n) - held;
  }

  /** Whether a bond's last scheduled payment, its redemption, has been made. */
  redeemed(bond: string): boolean {
    const schedule = couponSchedule(bondTerms(this.bondSpec(bond)), calendarOf(this.scenario));
    return (this.bondPaid.get(bond) ?? 0) >= schedule.length;
  }

  /** What the dealer's rate makes of `amount` from one currency into another, or undefined if it quotes none. */
  target(from: CurrencyCode, to: CurrencyCode, amount: bigint): bigint | undefined {
    const rate = fxRate(this.scenario, from, to);
    return rate ? convert(money(from, amount), rate, to).minor : undefined;
  }

  private bondSpec(bond: string): ScenarioBond {
    const spec = this.scenario.instruments.bonds.find((b) => b.symbol === bond);
    if (!spec) throw new RangeError(`No bond "${bond}" in ${this.scenario.id}`);
    return spec;
  }

  private move(map: Map<string, bigint>, key: string, by: bigint) {
    map.set(key, (map.get(key) ?? 0n) + by);
  }

  /**
   * Count a payment's payer side as spent, and nothing else: what a script
   * does with a fault's payment, which the engine may settle or refuse, so
   * no later step counts on money that may never have arrived.
   */
  spend(flow: KitFlow): void {
    if (flow.kind !== "pay" && flow.kind !== "pay-fx") return;
    const payer = this.bank(flow.payerBank);
    this.move(payer.tokenized, flow.payer, -flow.amount);
    this.move(payer.wholesale, payer.currency, -flow.amount);
  }

  /** Apply a flow the engine settled. */
  apply(flow: KitFlow, outcome: Outcome): void {
    if (outcome.status !== "settled") return;
    switch (flow.kind) {
      case "fund":
      case "redeem": {
        const sign = flow.kind === "fund" ? 1n : -1n;
        const b = this.bank(flow.bank);
        this.move(b.rtgs, flow.currency, -sign * flow.amount);
        this.move(b.wholesale, flow.currency, sign * flow.amount);
        return;
      }
      case "tokenize":
      case "detokenize": {
        const sign = flow.kind === "tokenize" ? 1n : -1n;
        const b = this.bank(flow.bank);
        this.move(b.deposits, flow.customer, -sign * flow.amount);
        this.move(b.tokenized, flow.customer, sign * flow.amount);
        return;
      }
      case "pay":
      case "pay-fx": {
        const from = this.bank(flow.payerBank);
        const to = this.bank(flow.payeeBank);
        const target = flow.kind === "pay" ? flow.amount : (outcome.quote?.target ?? this.target(from.currency, to.currency, flow.amount) ?? 0n);
        this.move(from.tokenized, flow.payer, -flow.amount);
        this.move(to.tokenized, flow.payee, target);
        if (flow.kind === "pay") {
          this.move(from.wholesale, from.currency, -flow.amount);
          this.move(to.wholesale, to.currency, flow.amount);
        } else {
          const dealer = this.bank(dealerOf(this.scenario)!);
          this.move(from.wholesale, from.currency, -flow.amount);
          this.move(dealer.wholesale, from.currency, flow.amount);
          this.move(dealer.wholesale, to.currency, -target);
          this.move(to.wholesale, to.currency, target);
        }
        return;
      }
      case "bond-issue": {
        const spec = this.bondSpec(flow.bond);
        const agent = this.bank(spec.agent);
        for (const a of flow.allocations) {
          const buyer = this.bank(a.bank);
          this.move(buyer.bonds, flow.bond, a.units);
          this.move(buyer.wholesale, spec.currency, -a.units * flow.price);
          this.move(agent.wholesale, spec.currency, a.units * flow.price);
        }
        return;
      }
      case "bond-trade": {
        const spec = this.bondSpec(flow.bond);
        const [seller, buyer] = [this.bank(flow.seller), this.bank(flow.buyer)];
        this.move(seller.bonds, flow.bond, -flow.units);
        this.move(buyer.bonds, flow.bond, flow.units);
        this.move(seller.wholesale, spec.currency, flow.units * flow.price);
        this.move(buyer.wholesale, spec.currency, -flow.units * flow.price);
        return;
      }
      case "repo-open": {
        const currency = repoCurrency(this.scenario);
        const [lender, borrower] = [this.bank(flow.lender), this.bank(flow.borrower)];
        this.move(borrower.bonds, flow.bond, -flow.units);
        this.move(lender.bonds, flow.bond, flow.units);
        this.move(lender.wholesale, currency, -flow.cash);
        this.move(borrower.wholesale, currency, flow.cash);
        this.repos.set(flow.id, {
          id: flow.id,
          lender: flow.lender,
          borrower: flow.borrower,
          terms: { cash: money(currency, flow.cash), rate: flow.rate, haircut: flow.haircut, startDate: flow.startDate, endDate: flow.endDate, dayCount: "ACT/365F" },
          collateral: [{ bond: flow.bond, units: flow.units }],
        });
        return;
      }
      case "repo-margin":
      case "repo-substitute": {
        const repo = this.repos.get(flow.repo);
        if (!repo) return;
        const marks = kitMarks(flow.marks, repoCurrency(this.scenario));
        // What a margin or substitution must move, the kit computes as the engine must.
        const moves: CollateralLine[] = [];
        if (flow.kind === "repo-margin") {
          const call = marginCall(repo.terms, repo.collateral, marks, flow.asOf, flow.bond);
          if (call.direction === "none") return;
          moves.push({ bond: flow.bond, units: call.direction === "deliver" ? call.units : -call.units });
        } else {
          moves.push({ bond: flow.outgoing.bond, units: -flow.outgoing.units });
          moves.push({ bond: flow.incoming, units: substitutionUnits(flow.outgoing, flow.incoming, marks, repo.terms.cash.currency) });
        }
        let collateral = [...repo.collateral];
        for (const m of moves) {
          this.move(this.bank(repo.borrower).bonds, m.bond, -m.units);
          this.move(this.bank(repo.lender).bonds, m.bond, m.units);
          collateral = moveCollateral(collateral, m.bond, m.units);
        }
        this.repos.set(repo.id, { ...repo, collateral });
        return;
      }
      case "repo-close": {
        const repo = this.repos.get(flow.repo);
        if (!repo) return;
        for (const c of repo.collateral) {
          this.move(this.bank(repo.lender).bonds, c.bond, -c.units);
          this.move(this.bank(repo.borrower).bonds, c.bond, c.units);
        }
        const repay = repurchasePrice(repo.terms).minor;
        this.move(this.bank(repo.borrower).wholesale, repo.terms.cash.currency, -repay);
        this.move(this.bank(repo.lender).wholesale, repo.terms.cash.currency, repay);
        this.repos.delete(repo.id);
        return;
      }
      case "bond-payment": {
        const next = this.nextBondPayment(flow.bond);
        if (!next) return;
        const spec = this.bondSpec(flow.bond);
        const agent = this.bank(spec.agent);
        for (const p of next.payments) {
          const holder = this.bank(p.bank);
          this.move(holder.wholesale, spec.currency, p.amount);
          this.move(agent.wholesale, spec.currency, -p.amount);
          if (next.final) this.move(holder.bonds, flow.bond, -p.units);
        }
        this.bondPaid.set(flow.bond, (this.bondPaid.get(flow.bond) ?? 0) + 1);
        return;
      }
    }
  }
}

/** A scenario bond's terms in the domain's form. */
export function bondTerms(spec: ScenarioBond): BondTerms {
  return {
    face: parseMoney(spec.currency, spec.face),
    couponRate: spec.couponRate,
    frequency: spec.frequency,
    dayCount: spec.dayCount,
    issueDate: spec.issueDate,
    maturityDate: spec.maturityDate,
    recordDays: spec.recordDays,
    rounding: spec.rounding,
  };
}

export function calendarOf(scenario: Scenario): BusinessCalendar {
  return { weekendDays: weekdayNumbers(scenario.calendar.weekend), holidays: scenario.calendar.holidays };
}
