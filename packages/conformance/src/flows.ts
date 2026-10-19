import { type CollateralLine, type CurrencyCode, formatMoney, marginCall, type Mark, money, type RepoTerms } from "@oul/domain";
import { dealerOf, depositOf, type Scenario, wholesaleFor } from "@oul/scenario";
import type { BondPayment } from "./model.ts";

/**
 * The flows the kit asks an engine for, in the kit's own terms (SPEC.md
 * §14): who pays whom and how much, never how the engine settles it. Each
 * carries the id the engine settles it under: a UETR, as the sandbox's
 * engine uses, and as an ISO 20022 payment would carry.
 *
 * For each flow, `legsOf` states what it must move on a ledger: the kit's
 * account of SPEC.md §5, which the atomicity check holds every settlement to.
 */

interface Base {
  readonly id: string;
}

export type KitFlow =
  /** §5.1 A bank funds or redeems wholesale tokens in a currency it holds reserves in. */
  | (Base & { readonly kind: "fund" | "redeem"; readonly bank: string; readonly currency: CurrencyCode; readonly amount: bigint })
  /** §5.2 A bank tokenizes a customer's deposit, or returns it. */
  | (Base & { readonly kind: "tokenize" | "detokenize"; readonly bank: string; readonly customer: string; readonly amount: bigint })
  /** §5.3 A customer pays a customer of another bank in the same currency. */
  | (Base & PaymentParties & { readonly kind: "pay"; readonly amount: bigint })
  /** §13 A customer pays a customer of another bank in another currency, through the dealer; `amount` is in the payer's. */
  | (Base & PaymentParties & { readonly kind: "pay-fx"; readonly amount: bigint })
  /** §5.4 A bond's agent issues units to banks at a price per unit, in minor units. */
  | (Base & { readonly kind: "bond-issue"; readonly bond: string; readonly price: bigint; readonly allocations: readonly { readonly bank: string; readonly units: bigint }[] })
  /** §5.5 A bank sells bond units to another, delivery versus payment. */
  | (Base & { readonly kind: "bond-trade"; readonly bond: string; readonly seller: string; readonly buyer: string; readonly units: bigint; readonly price: bigint })
  /** §5.6 The agent pays the bond's next scheduled payment: a coupon, or at the last, redemption. */
  | (Base & { readonly kind: "bond-payment"; readonly bond: string })
  /**
   * §5.7 A repo, on terms the lender affirmed: the borrower's units of a bond
   * against the purchase price, both in minor units, at a mark per unit. Its
   * `id` names the repo in the flows after it.
   */
  | (Base &
      RepoParties & {
        readonly kind: "repo-open";
        readonly bond: string;
        readonly units: bigint;
        readonly mark: bigint;
        readonly cash: bigint;
        readonly rate: string;
        readonly haircut: string;
        readonly startDate: string;
        readonly endDate: string;
      })
  /** §5.8 The margin marks give on a date, in units of `bond`: whatever the engine computes, the check judges. */
  | (Base & { readonly kind: "repo-margin"; readonly repo: string; readonly marks: readonly KitMark[]; readonly asOf: string; readonly bond: string })
  /** §5.9 Units of one bond back to the borrower, units of another to the lender, at marks. */
  | (Base & { readonly kind: "repo-substitute"; readonly repo: string; readonly outgoing: CollateralLine; readonly incoming: string; readonly marks: readonly KitMark[]; readonly asOf: string })
  /** §5.10 Every collateral unit back against the purchase price plus interest. */
  | (Base & { readonly kind: "repo-close"; readonly repo: string });

interface RepoParties {
  readonly lender: string;
  readonly borrower: string;
}

/** A bond's mark per unit, in minor units. */
export interface KitMark {
  readonly bond: string;
  readonly price: bigint;
}

/** A repo as the kit knows it from the flows it asked for: its parties, its terms and the collateral its flows moved. */
export interface KitRepo {
  readonly id: string;
  readonly lender: string;
  readonly borrower: string;
  readonly terms: RepoTerms;
  readonly collateral: readonly CollateralLine[];
}

export interface PaymentParties {
  readonly payerBank: string;
  readonly payer: string;
  readonly payeeBank: string;
  readonly payee: string;
}

export type FlowKind = KitFlow["kind"];
export type PaymentFlow = Extract<KitFlow, { kind: "pay" }>;

/** The faults the kit can ask an engine to stage, each declared by the adapter or not. */
export type FaultStep =
  /** A participant goes down while `flows` run among the others, then comes back and catches up. */
  | { readonly fault: "participant-down"; readonly participant: string; readonly flows: readonly KitFlow[] }
  /** The same payment asked for three times at once, then sent to the engine again once it settled. */
  | { readonly fault: "duplicate-submission"; readonly flow: PaymentFlow }
  /** A payment sent to the engine with a co-signature over other legs, and one past its deadline. */
  | { readonly fault: "stale-approval"; readonly flow: PaymentFlow }
  /** A payment sent to the engine without the payee's bank's co-signature. */
  | { readonly fault: "missing-approval"; readonly flow: PaymentFlow }
  /** The payer's bank freezes its customer's tokens on the ledger, behind its own books, before the payment. */
  | { readonly fault: "frozen-payer"; readonly flow: PaymentFlow }
  /** The payee's bank takes its customer off the token's allowlist on the ledger, behind its own books, before the payment. */
  | { readonly fault: "ineligible-payee"; readonly flow: PaymentFlow }
  /** One of interop mode's faults (SPEC.md §7) while a coordinator moves the payment across ledgers. */
  | { readonly fault: CoordinatorFault; readonly flow: Extract<KitFlow, { kind: "pay" | "pay-fx" }> };

/**
 * Interop mode's faults (SPEC.md §7): the coordinator crashes between its
 * phases, a message between parties is lost, a participant is offline past a
 * timeout, a commit or claim lands after its timeout.
 */
export type CoordinatorFault = "coordinator-crash" | "message-loss" | "participant-offline" | "late-commit";

export type FaultKind = FaultStep["fault"];

export const FAULT_KINDS: readonly FaultKind[] = [
  "participant-down",
  "duplicate-submission",
  "stale-approval",
  "missing-approval",
  "frozen-payer",
  "ineligible-payee",
  "coordinator-crash",
  "message-loss",
  "participant-offline",
  "late-commit",
];

/** One step of a run: a flow, or a fault. */
export type Step = { readonly flow: KitFlow } | { readonly fault: FaultStep };

/** A party to a leg: a participant id, or a customer as `<bank>/<customer>`. */
export type Party = string;

/**
 * One leg a flow must move: a token by symbol (on whichever ledger the
 * engine settles it), from and to a party (null for a mint's source or a
 * burn's destination), and its amount: exact, or `target`, which the
 * engine's dealer sets for a payment across currencies and which must be
 * the same on every leg that names it.
 */
export interface Leg {
  readonly symbol: string;
  readonly from: Party | null;
  readonly to: Party | null;
  readonly amount: bigint | "target";
}

/** What the kit knows of the run so far, which some flows' legs depend on. */
export interface LegContext {
  /** A bond's next payment, computed from its terms and the units each bank holds before the flow. */
  readonly bondPayment: (bond: string) => BondPayment | undefined;
  /** A repo the kit opened, as the flows before this one left it. */
  readonly repo: (id: string) => KitRepo | undefined;
}

const customer = (bank: string, id: string): Party => `${bank}/${id}`;

/** The legs `flow` must move (SPEC.md §5), all in one transaction on a ledger. */
export function legsOf(flow: KitFlow, scenario: Scenario, ctx: LegContext): Leg[] {
  const wholesale = (currency: CurrencyCode) => wholesaleFor(scenario, currency).symbol;
  const deposit = (bank: string) => depositOf(scenario, bank).symbol;
  switch (flow.kind) {
    case "fund":
      return [{ symbol: wholesale(flow.currency), from: null, to: flow.bank, amount: flow.amount }];
    case "redeem":
      return [{ symbol: wholesale(flow.currency), from: flow.bank, to: null, amount: flow.amount }];
    case "tokenize":
      return [{ symbol: deposit(flow.bank), from: null, to: customer(flow.bank, flow.customer), amount: flow.amount }];
    case "detokenize":
      return [{ symbol: deposit(flow.bank), from: customer(flow.bank, flow.customer), to: null, amount: flow.amount }];
    case "pay": {
      const currency = depositOf(scenario, flow.payerBank).currency;
      return [
        { symbol: deposit(flow.payerBank), from: customer(flow.payerBank, flow.payer), to: null, amount: flow.amount },
        { symbol: wholesale(currency), from: flow.payerBank, to: flow.payeeBank, amount: flow.amount },
        { symbol: deposit(flow.payeeBank), from: null, to: customer(flow.payeeBank, flow.payee), amount: flow.amount },
      ];
    }
    case "pay-fx": {
      const dealer = dealerOf(scenario);
      if (!dealer) throw new RangeError(`${scenario.id} has no FX dealer`);
      const [from, to] = [depositOf(scenario, flow.payerBank).currency, depositOf(scenario, flow.payeeBank).currency];
      return [
        { symbol: deposit(flow.payerBank), from: customer(flow.payerBank, flow.payer), to: null, amount: flow.amount },
        { symbol: wholesale(from), from: flow.payerBank, to: dealer, amount: flow.amount },
        { symbol: wholesale(to), from: dealer, to: flow.payeeBank, amount: "target" },
        { symbol: deposit(flow.payeeBank), from: null, to: customer(flow.payeeBank, flow.payee), amount: "target" },
      ];
    }
    case "bond-issue": {
      const spec = bondSpec(scenario, flow.bond);
      return [
        ...flow.allocations.map((a): Leg => ({ symbol: flow.bond, from: null, to: a.bank, amount: a.units })),
        ...flow.allocations.map((a): Leg => ({ symbol: wholesale(spec.currency), from: a.bank, to: spec.agent, amount: a.units * flow.price })),
      ];
    }
    case "bond-trade": {
      const spec = bondSpec(scenario, flow.bond);
      return [
        { symbol: flow.bond, from: flow.seller, to: flow.buyer, amount: flow.units },
        { symbol: wholesale(spec.currency), from: flow.buyer, to: flow.seller, amount: flow.units * flow.price },
      ];
    }
    case "bond-payment": {
      const spec = bondSpec(scenario, flow.bond);
      const next = ctx.bondPayment(flow.bond);
      if (!next) return [];
      return [
        ...(next.final ? next.payments.map((p): Leg => ({ symbol: flow.bond, from: p.bank, to: null, amount: p.units })) : []),
        ...next.payments.map((p): Leg => ({ symbol: wholesale(spec.currency), from: spec.agent, to: p.bank, amount: p.amount })),
      ];
    }
    // Repo: what the terms fix exactly, the kit states; what follows from marks and interest (a margin's
    // units, a substitution's incoming units, a close's repayment) is the engine's to compute and the
    // repo-collateral check's to judge, as a payment's target amount is fx-consistency's.
    case "repo-open":
      return [
        { symbol: flow.bond, from: flow.borrower, to: flow.lender, amount: flow.units },
        { symbol: wholesale(repoCurrency(scenario)), from: flow.lender, to: flow.borrower, amount: flow.cash },
      ];
    case "repo-margin": {
      const repo = ctx.repo(flow.repo);
      if (!repo) return [];
      // Which way is the marks' to say: the borrower delivers a shortfall, the lender returns an excess.
      const call = marginCall(repo.terms, repo.collateral, kitMarks(flow.marks, repoCurrency(scenario)), flow.asOf, flow.bond);
      if (call.direction === "none") return [];
      const [from, to] = call.direction === "deliver" ? [repo.borrower, repo.lender] : [repo.lender, repo.borrower];
      return [{ symbol: flow.bond, from, to, amount: "target" }];
    }
    case "repo-substitute": {
      const repo = ctx.repo(flow.repo);
      if (!repo) return [];
      return [
        { symbol: flow.outgoing.bond, from: repo.lender, to: repo.borrower, amount: flow.outgoing.units },
        { symbol: flow.incoming, from: repo.borrower, to: repo.lender, amount: "target" },
      ];
    }
    case "repo-close": {
      const repo = ctx.repo(flow.repo);
      if (!repo) return [];
      return [
        ...repo.collateral.map((c): Leg => ({ symbol: c.bond, from: repo.lender, to: repo.borrower, amount: c.units })),
        { symbol: wholesale(repoCurrency(scenario)), from: repo.borrower, to: repo.lender, amount: "target" },
      ];
    }
  }
}

/** A flow's marks in the domain's form. */
export function kitMarks(marks: readonly KitMark[], currency: CurrencyCode): Mark[] {
  return marks.map((m) => ({ bond: m.bond, price: money(currency, m.price) }));
}

/** The currency a scenario's repos settle in: its bonds'. */
export function repoCurrency(scenario: Scenario): CurrencyCode {
  const [bond] = scenario.instruments.bonds;
  if (!bond) throw new RangeError(`${scenario.id} has no bonds to lend against`);
  return bond.currency;
}

function bondSpec(scenario: Scenario, symbol: string) {
  const spec = scenario.instruments.bonds.find((b) => b.symbol === symbol);
  if (!spec) throw new RangeError(`No bond "${symbol}" in ${scenario.id}`);
  return spec;
}

/** The currency a flow's amount is in. */
export function flowCurrency(flow: KitFlow, scenario: Scenario): CurrencyCode {
  switch (flow.kind) {
    case "fund":
    case "redeem":
      return flow.currency;
    case "tokenize":
    case "detokenize":
      return depositOf(scenario, flow.bank).currency;
    case "pay":
    case "pay-fx":
      return depositOf(scenario, flow.payerBank).currency;
    case "repo-open":
    case "repo-margin":
    case "repo-substitute":
    case "repo-close":
      return repoCurrency(scenario);
    default:
      return bondSpec(scenario, flow.bond).currency;
  }
}

/** One line for a report: what the flow asks for. */
export function describeFlow(flow: KitFlow, scenario: Scenario): string {
  const cash = (minor: bigint) => `${formatMoney(money(flowCurrency(flow, scenario), minor))} ${flowCurrency(flow, scenario)}`;
  switch (flow.kind) {
    case "fund":
      return `${flow.bank} funds ${cash(flow.amount)} wholesale`;
    case "redeem":
      return `${flow.bank} redeems ${cash(flow.amount)} wholesale`;
    case "tokenize":
      return `${flow.bank} tokenizes ${cash(flow.amount)} for ${flow.customer}`;
    case "detokenize":
      return `${flow.bank} detokenizes ${cash(flow.amount)} for ${flow.customer}`;
    case "pay":
      return `${flow.payer}@${flow.payerBank} pays ${flow.payee}@${flow.payeeBank} ${cash(flow.amount)}`;
    case "pay-fx":
      return `${flow.payer}@${flow.payerBank} pays ${flow.payee}@${flow.payeeBank} ${cash(flow.amount)} into ${depositOf(scenario, flow.payeeBank).currency}`;
    case "bond-issue":
      return `${flow.bond} issued to ${flow.allocations.map((a) => `${a.bank} ${a.units}`).join(", ")} at ${cash(flow.price)}`;
    case "bond-trade":
      return `${flow.seller} sells ${flow.units} ${flow.bond} to ${flow.buyer} at ${cash(flow.price)}`;
    case "bond-payment":
      return `${flow.bond}'s next payment`;
    case "repo-open":
      return `${flow.lender} lends ${cash(flow.cash)} to ${flow.borrower} against ${flow.units} ${flow.bond} to ${flow.endDate}`;
    case "repo-margin":
      return `margin on repo ${flow.repo.slice(0, 8)} at marks of ${flow.asOf}, in ${flow.bond}`;
    case "repo-substitute":
      return `substitute ${flow.incoming} for ${flow.outgoing.units} ${flow.outgoing.bond} under repo ${flow.repo.slice(0, 8)}`;
    case "repo-close":
      return `close repo ${flow.repo.slice(0, 8)}`;
  }
}

/** One line for a report: what the step does. */
export function describeStep(step: Step, scenario: Scenario): string {
  if ("flow" in step) return describeFlow(step.flow, scenario);
  const f = step.fault;
  if (f.fault === "participant-down") {
    return `${f.participant} down while: ${f.flows.map((flow) => describeFlow(flow, scenario)).join("; ") || "nothing"}`;
  }
  return `${f.fault}: ${describeFlow(f.flow, scenario)}`;
}
