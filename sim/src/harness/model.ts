import {
  addDays,
  bankAccounts,
  type CollateralLine,
  convert,
  type CurrencyCode,
  marginCall,
  type Mark,
  money,
  moveCollateral,
  parseMoney,
  repurchasePrice,
  type RepoTerms,
  substitutionUnits,
} from "@oul/domain";
import { dealerOf, depositOf, fxRate, type Scenario } from "@oul/scenario";

/**
 * A seeded random sequence of flows and the balances they leave, so a run
 * is reproducible from its seed (SPEC.md §9). Actions run one at a time and
 * each waits for its outcome, so this model knows every balance exactly and
 * the generator never needs to read live state, which depends on timing.
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
    return items[this.int(0, items.length - 1)]!;
  }

  /** A version 4 UETR drawn from this generator, so a seed reproduces its ids too. */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(0, 15).toString(16));
    hex[12] = "4";
    hex[16] = "89ab"[this.int(0, 3)]!;
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** Between 1 and `max` minor units, as a fraction of `max` in thousandths. */
  share(max: bigint): bigint {
    if (max <= 0n) return 0n;
    const amount = (max * BigInt(this.int(1, 1000))) / 1000n;
    return amount > 0n ? amount : 1n;
  }
}

export type ActionKind =
  | "fund"
  | "redeem"
  | "tokenize"
  | "detokenize"
  | "pay"
  | "overspend"
  | "pvp"
  | "bond-issue"
  | "repo-open"
  | "repo-margin"
  | "repo-substitute"
  | "repo-close";

/** A repo the model knows open: its parties, terms and the collateral the lender holds. */
export interface RepoState {
  readonly id: string;
  readonly lender: string;
  readonly borrower: string;
  readonly terms: RepoTerms;
  collateral: CollateralLine[];
}

export type Action =
  | { readonly kind: "fund" | "redeem"; readonly bank: string; readonly currency: CurrencyCode; readonly amount: bigint }
  | { readonly kind: "tokenize" | "detokenize"; readonly bank: string; readonly customer: string; readonly amount: bigint }
  | {
      readonly kind: "pay";
      readonly payerBank: string;
      readonly payer: string;
      readonly payeeBank: string;
      readonly payee: string;
      readonly amount: bigint;
      /** True when the amount is more than the payer has: it must be refused. */
      readonly overspend: boolean;
    }
  | {
      /** A payment into another currency through the dealer, at its quote (SPEC.md §13). */
      readonly kind: "pvp";
      readonly payerBank: string;
      readonly payer: string;
      readonly payeeBank: string;
      readonly payee: string;
      readonly dealer: string;
      /** Minor units of the payer's currency. */
      readonly amount: bigint;
      /** Minor units of the payee's currency: what the dealer's rate must turn `amount` into. */
      readonly target: bigint;
    }
  /** A bond's agent issues units to banks at par: the repo scenario's prelude, so banks hold collateral. */
  | { readonly kind: "bond-issue"; readonly bond: string; readonly agent: string; readonly allocations: readonly { readonly bank: string; readonly units: bigint }[] }
  /** §5.7 The lender affirms, the borrower opens: units of a bond against cash, at a mark, under terms. */
  | {
      readonly kind: "repo-open";
      readonly id: string;
      readonly lender: string;
      readonly borrower: string;
      readonly bond: string;
      readonly units: bigint;
      /** Minor units per unit. */
      readonly mark: bigint;
      readonly terms: RepoTerms;
    }
  /** §5.8 The side receiving units calls the margin marks give on a date; the other side delivers it. */
  | {
      readonly kind: "repo-margin";
      readonly repo: string;
      readonly marks: readonly Mark[];
      readonly asOf: string;
      readonly bond: string;
      readonly direction: "deliver" | "return";
      readonly units: bigint;
    }
  /** §5.9 The lender affirms, the borrower substitutes: every unit of one bond for the other, at marks. */
  | {
      readonly kind: "repo-substitute";
      readonly repo: string;
      readonly marks: readonly Mark[];
      readonly asOf: string;
      readonly outgoing: CollateralLine;
      readonly incoming: CollateralLine;
    }
  /** §5.10 The borrower closes at the end date: every unit back, principal plus interest. */
  | { readonly kind: "repo-close"; readonly repo: string; readonly repay: bigint };

/** A bank's balances: reserves in each currency it holds, deposits in its own. */
interface BankState {
  readonly currency: CurrencyCode;
  readonly rtgs: Map<CurrencyCode, bigint>;
  readonly wholesale: Map<CurrencyCode, bigint>;
  readonly deposits: Map<string, bigint>;
  readonly tokenized: Map<string, bigint>;
}

export class Model {
  readonly banks = new Map<string, BankState>();
  /** With repo: the units of each collateral bond each bank owns and has not pledged, and the repos open. */
  readonly bonds = new Map<string, Map<string, bigint>>();
  readonly repos: RepoState[] = [];
  private readonly scenario: Scenario;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    for (const symbol of scenario.repo?.collateral ?? []) this.bonds.set(symbol, new Map());
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
      });
    }
  }

  private bank(id: string): BankState {
    return this.banks.get(id)!;
  }

  /** A bank's wholesale reserves in a currency: its own unless named. */
  wholesale(id: string, currency?: CurrencyCode): bigint {
    const state = this.bank(id);
    return state.wholesale.get(currency ?? state.currency) ?? 0n;
  }

  private move(map: Map<CurrencyCode, bigint>, currency: CurrencyCode, by: bigint) {
    map.set(currency, (map.get(currency) ?? 0n) + by);
  }

  /** The units of `bond` a bank owns and has not pledged. */
  freeUnits(bank: string, bond: string): bigint {
    return this.bonds.get(bond)?.get(bank) ?? 0n;
  }

  private moveUnits(bank: string, bond: string, by: bigint) {
    const held = this.bonds.get(bond)!;
    held.set(bank, (held.get(bank) ?? 0n) + by);
  }

  repo(id: string): RepoState {
    const found = this.repos.find((r) => r.id === id);
    if (!found) throw new Error(`The model knows no repo ${id}`);
    return found;
  }

  /** Apply an action that settled. */
  apply(action: Action): void {
    switch (action.kind) {
      case "bond-issue": {
        for (const a of action.allocations) {
          this.moveUnits(a.bank, action.bond, a.units);
          const face = parseMoney(this.bank(a.bank).currency, this.scenario.instruments.bonds.find((b) => b.symbol === action.bond)!.face).minor;
          this.move(this.bank(a.bank).wholesale, this.bank(a.bank).currency, -a.units * face);
          this.move(this.bank(action.agent).wholesale, this.bank(action.agent).currency, a.units * face);
        }
        break;
      }
      case "repo-open": {
        const currency = action.terms.cash.currency;
        this.moveUnits(action.borrower, action.bond, -action.units);
        this.move(this.bank(action.lender).wholesale, currency, -action.terms.cash.minor);
        this.move(this.bank(action.borrower).wholesale, currency, action.terms.cash.minor);
        this.repos.push({ id: action.id, lender: action.lender, borrower: action.borrower, terms: action.terms, collateral: [{ bond: action.bond, units: action.units }] });
        break;
      }
      case "repo-margin": {
        const repo = this.repo(action.repo);
        const delta = action.direction === "deliver" ? action.units : -action.units;
        this.moveUnits(repo.borrower, action.bond, -delta);
        repo.collateral = moveCollateral(repo.collateral, action.bond, delta);
        break;
      }
      case "repo-substitute": {
        const repo = this.repo(action.repo);
        this.moveUnits(repo.borrower, action.outgoing.bond, action.outgoing.units);
        this.moveUnits(repo.borrower, action.incoming.bond, -action.incoming.units);
        repo.collateral = moveCollateral(moveCollateral(repo.collateral, action.outgoing.bond, -action.outgoing.units), action.incoming.bond, action.incoming.units);
        break;
      }
      case "repo-close": {
        const repo = this.repo(action.repo);
        const currency = repo.terms.cash.currency;
        for (const line of repo.collateral) this.moveUnits(repo.borrower, line.bond, line.units);
        this.move(this.bank(repo.borrower).wholesale, currency, -action.repay);
        this.move(this.bank(repo.lender).wholesale, currency, action.repay);
        this.repos.splice(this.repos.indexOf(repo), 1);
        break;
      }
      case "fund":
      case "redeem": {
        const sign = action.kind === "fund" ? 1n : -1n;
        this.move(this.bank(action.bank).rtgs, action.currency, -sign * action.amount);
        this.move(this.bank(action.bank).wholesale, action.currency, sign * action.amount);
        break;
      }
      case "tokenize":
      case "detokenize": {
        const b = this.bank(action.bank);
        const sign = action.kind === "tokenize" ? 1n : -1n;
        b.deposits.set(action.customer, b.deposits.get(action.customer)! - sign * action.amount);
        b.tokenized.set(action.customer, b.tokenized.get(action.customer)! + sign * action.amount);
        break;
      }
      case "pay": {
        const from = this.bank(action.payerBank);
        const to = this.bank(action.payeeBank);
        from.tokenized.set(action.payer, from.tokenized.get(action.payer)! - action.amount);
        this.move(from.wholesale, from.currency, -action.amount);
        this.move(to.wholesale, to.currency, action.amount);
        to.tokenized.set(action.payee, to.tokenized.get(action.payee)! + action.amount);
        break;
      }
      case "pvp": {
        const from = this.bank(action.payerBank);
        const to = this.bank(action.payeeBank);
        const dealer = this.bank(action.dealer);
        from.tokenized.set(action.payer, from.tokenized.get(action.payer)! - action.amount);
        this.move(from.wholesale, from.currency, -action.amount);
        this.move(dealer.wholesale, from.currency, action.amount);
        this.move(dealer.wholesale, to.currency, -action.target);
        this.move(to.wholesale, to.currency, action.target);
        to.tokenized.set(action.payee, to.tokenized.get(action.payee)! + action.target);
        break;
      }
    }
  }

  /**
   * A feasible repo flow between banks that may lend and borrow (none is a
   * collateral bond's agent): open one, margin or substitute an open one at
   * marks near face, or close it; or nothing, when the choice is not feasible.
   */
  private nextRepo(rng: Rng, kinds: readonly ActionKind[], banks: readonly string[]): Action | undefined {
    const spec = this.scenario.repo!;
    const agents = new Set(this.scenario.instruments.bonds.filter((b) => spec.collateral.includes(b.symbol)).map((b) => b.agent));
    const parties = banks.filter((b) => !agents.has(b));
    // With no repo open there is only one to open; with some, any flow on them, or another.
    const live = this.repos.filter((r) => banks.includes(r.lender) && banks.includes(r.borrower));
    const kind = live.length === 0 ? "repo-open" : rng.pick(kinds);
    if (!kinds.includes(kind)) return undefined;
    const currency = this.scenario.instruments.bonds[0]!.currency;
    const faceOf = (bond: string) => parseMoney(currency, this.scenario.instruments.bonds.find((b) => b.symbol === bond)!.face).minor;
    const markNear = (bond: string, spread: number): Mark => ({ bond, price: money(currency, (faceOf(bond) * BigInt(1000 + rng.int(-spread, spread))) / 1000n) });
    if (kind === "repo-open") {
      if (parties.length < 2) return undefined;
      const borrower = rng.pick(parties);
      const lender = rng.pick(parties.filter((p) => p !== borrower));
      const bond = rng.pick(spec.collateral);
      const free = this.freeUnits(borrower, bond);
      if (free < 10n) return undefined;
      const units = rng.share(free / 2n) + 1n;
      const mark = markNear(bond, 10).price;
      // Cash a little under what the units cover after a 2% haircut, and within what the lender holds.
      const covered = (units * mark.minor * 98n) / 100n;
      let cash = (covered * BigInt(rng.int(800, 1000))) / 1000n;
      const available = this.wholesale(lender, currency) / 2n;
      if (cash > available) cash = available;
      if (cash < 100n) return undefined;
      const startDate = "2027-04-26";
      const terms: RepoTerms = {
        cash: money(currency, cash),
        rate: `0.0${rng.int(2000, 4500)}`,
        haircut: "0.02",
        startDate,
        endDate: addDays(startDate, rng.int(1, 30)),
        dayCount: "ACT/365F",
      };
      return { kind: "repo-open", id: rng.uuid(), lender, borrower, bond, units, mark: mark.minor, terms };
    }
    if (live.length === 0) return undefined;
    const repo = rng.pick(live);
    const days = Number((BigInt(Date.parse(`${repo.terms.endDate}T00:00:00Z`)) - BigInt(Date.parse(`${repo.terms.startDate}T00:00:00Z`))) / 86_400_000n);
    const asOf = addDays(repo.terms.startDate, rng.int(0, days));
    const marks = spec.collateral.map((bond) => markNear(bond, 40));
    if (kind === "repo-margin") {
      const bond = rng.pick(repo.collateral).bond;
      const call = marginCall(repo.terms, repo.collateral, marks, asOf, bond);
      if (call.direction === "none") return undefined;
      if (call.direction === "deliver" && this.freeUnits(repo.borrower, bond) < call.units) return undefined;
      return { kind: "repo-margin", repo: repo.id, marks, asOf, bond, direction: call.direction, units: call.units };
    }
    if (kind === "repo-substitute") {
      const outgoing = rng.pick(repo.collateral);
      const others = spec.collateral.filter((b) => b !== outgoing.bond);
      if (others.length === 0) return undefined;
      const bond = rng.pick(others);
      const units = substitutionUnits(outgoing, bond, marks, repo.terms.cash.currency);
      if (this.freeUnits(repo.borrower, bond) < units) return undefined;
      return { kind: "repo-substitute", repo: repo.id, marks, asOf, outgoing, incoming: { bond, units } };
    }
    const repay = repurchasePrice(repo.terms).minor;
    if (this.wholesale(repo.borrower, repo.terms.cash.currency) < repay) return undefined;
    return { kind: "repo-close", repo: repo.id, repay };
  }

  /**
   * The next action: feasible, or, about one time in ten, a payment that must
   * be refused. A payment to a bank in another currency goes through the
   * dealer at its rate. `only` restricts it to some banks or kinds, for faults
   * that take a participant offline.
   */
  next(rng: Rng, only: { banks?: readonly string[]; kinds?: readonly ActionKind[] } = {}): Action {
    const banks = only.banks ? [...only.banks] : [...this.banks.keys()];
    const allowed = (kind: ActionKind) => !only.kinds || only.kinds.includes(kind);
    const dealer = dealerOf(this.scenario);
    const repoKinds = (["repo-open", "repo-margin", "repo-substitute", "repo-close"] as const).filter(allowed);
    for (let attempt = 0; ; attempt++) {
      if (attempt > 10_000) throw new Error("No feasible action under these restrictions");
      // With repo, about two actions in five are repo flows; other scenarios draw exactly as before.
      if (this.scenario.repo && repoKinds.length > 0 && rng.next() < 0.4) {
        const repo = this.nextRepo(rng, repoKinds, banks);
        if (repo) return repo;
        continue;
      }
      const roll = rng.next();
      const bank = rng.pick(banks);
      const state = this.bank(bank);
      const customers = [...state.deposits.keys()];
      const customer = rng.pick(customers);
      if (roll < 0.17) {
        // Funding or redeeming, in one of the currencies the bank holds reserves in.
        const reserves = [...state.rtgs.keys()];
        const currency = reserves.length === 1 ? reserves[0]! : rng.pick(reserves);
        if (roll < 0.12) {
          if (!allowed("fund")) continue;
          return { kind: "fund", bank, currency, amount: rng.share(state.rtgs.get(currency)! / 10n) };
        }
        const held = state.wholesale.get(currency)!;
        if (!allowed("redeem") || held === 0n) continue;
        return { kind: "redeem", bank, currency, amount: rng.share(held / 4n) };
      }
      if (roll < 0.42) {
        if (!allowed("tokenize")) continue;
        return { kind: "tokenize", bank, customer, amount: rng.share(state.deposits.get(customer)! / 1000n) };
      }
      if (roll < 0.52) {
        const held = state.tokenized.get(customer)!;
        if (!allowed("detokenize") || held === 0n) continue;
        return { kind: "detokenize", bank, customer, amount: rng.share(held) };
      }
      const payees = banks.filter((b) => b !== bank);
      if (payees.length === 0) continue;
      const payeeBank = rng.pick(payees);
      const payee = rng.pick([...this.bank(payeeBank).deposits.keys()]);
      const held = state.tokenized.get(customer)!;
      const reserves = this.wholesale(bank);
      const spendable = held < reserves ? held : reserves;
      const to = this.bank(payeeBank).currency;
      if (to !== state.currency) {
        // Across currencies: through a dealer that is neither party and holds enough of the target currency.
        if (!allowed("pvp") || !dealer || !banks.includes(dealer) || dealer === bank || dealer === payeeBank || spendable === 0n) continue;
        const rate = fxRate(this.scenario, state.currency, to);
        if (!rate) continue;
        const amount = rng.share(spendable);
        const target = convert(money(state.currency, amount), rate, to).minor;
        if (target === 0n || target > this.wholesale(dealer, to)) continue;
        return { kind: "pvp", payerBank: bank, payer: customer, payeeBank, payee, dealer, amount, target };
      }
      if (roll < 0.9) {
        if (!allowed("pay") || spendable === 0n) continue;
        return { kind: "pay", payerBank: bank, payer: customer, payeeBank, payee, amount: rng.share(spendable), overspend: false };
      }
      if (!allowed("overspend")) continue;
      // More than the payer holds in tokens: refused before anything is booked.
      return {
        kind: "pay",
        payerBank: bank,
        payer: customer,
        payeeBank,
        payee,
        amount: held + BigInt(rng.int(1, 100_000)),
        overspend: true,
      };
    }
  }
}

export interface RepoChoices {
  readonly lender: string;
  readonly borrower: string;
}

/** Whether a feasible payment in one currency exists among these banks right now. */
export function canPay(model: Model, banks: readonly string[]): boolean {
  return banks.some((b) => {
    const state = model.banks.get(b)!;
    const peers = banks.filter((o) => o !== b && model.banks.get(o)!.currency === state.currency);
    return model.wholesale(b) > 0n && [...state.tokenized.values()].some((t) => t > 0n) && peers.length > 0;
  });
}
