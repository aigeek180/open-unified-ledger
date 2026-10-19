import { type ChainInstruction, type Deployment, addressOf, leg, tokenAddress, uetrToId } from "@oul/chain";
import {
  type BondTerms,
  type BusinessCalendar,
  bondPostings,
  custodyPostings,
  type CurrencyCode,
  detokenizeDeposit,
  fundWholesale,
  fxPayment,
  interbankTransfer,
  type Line,
  money,
  parseMoney,
  redeemWholesale,
  repoPostings,
  sum,
  tokenizeDeposit,
  weekdayNumbers,
} from "@oul/domain";
import { centralBankFor, depositOf, homeCurrency, type Scenario, wholesaleFor } from "@oul/scenario";
import type { Address, Hex } from "viem";

/**
 * The flows of SPEC.md §5, each in one place: its on-chain legs, who submits
 * it, who must co-sign it, and what each participant books. Every
 * participant builds the legs locally from the same flow, so an approver
 * signs what it computed itself, not what it was sent.
 *
 * Amounts and units travel as strings of minor units and whole units; never
 * a JavaScript number.
 */
interface Base {
  readonly uetr: string;
  readonly deadline: number;
}

export type CashFlow =
  /** §5.1 In any currency the bank holds reserves in, at that currency's central bank. */
  | (Base & { readonly kind: "fund" | "redeem"; readonly bank: string; readonly currency: CurrencyCode; readonly amount: string })
  | (Base & { readonly kind: "tokenize" | "detokenize"; readonly bank: string; readonly customer: string; readonly amount: string })
  | (Base & {
      readonly kind: "interbank";
      readonly payerBank: string;
      readonly payer: string;
      readonly payeeBank: string;
      readonly payee: string;
      readonly amount: string;
    });

/**
 * §15 Units a custodian bank holds for one of its clients at its omnibus
 * wallet: the client, and the wallet the units go to or come from.
 */
export interface Custody {
  readonly client: string;
  readonly wallet: Address;
}

export type BondFlow =
  /**
   * §5.4 The agent issues units to buyers against wholesale tokens, at `price`
   * per unit; a buyer's allocation may be for a custody client (§15), to its
   * omnibus wallet, and a bank may have several allocations.
   */
  | (Base & {
      readonly kind: "bond-issue";
      readonly bond: string;
      readonly price: string;
      readonly allocations: readonly { readonly bank: string; readonly units: string; readonly custody?: Custody }[];
    })
  /** §5.5 A bank sells units to another, delivery versus payment; either side may be a custody client's (§15). */
  | (Base & {
      readonly kind: "bond-trade";
      readonly bond: string;
      readonly seller: string;
      readonly buyer: string;
      readonly units: string;
      readonly price: string;
      readonly sellerCustody?: Custody;
      readonly buyerCustody?: Custody;
    })
  /**
   * §5.6 The agent pays one scheduled coupon to the holders at the record
   * block; a holding at a custodian's omnibus wallet (§15) is its own entry,
   * naming the wallet, and is paid to the custodian.
   */
  | (Base & {
      readonly kind: "bond-coupon";
      readonly bond: string;
      readonly period: number;
      readonly recordBlock: string;
      readonly issuerDebit: string;
      readonly payments: readonly { readonly bank: string; readonly units: string; readonly amount: string; readonly wallet?: Address }[];
    })
  /** §5.6 At maturity the agent cancels every unit, repaying face plus the final coupon. */
  | (Base & {
      readonly kind: "bond-redeem";
      readonly bond: string;
      readonly period: number;
      readonly recordBlock: string;
      readonly issuerDebit: string;
      readonly payments: readonly {
        readonly bank: string;
        readonly units: string;
        readonly principal: string;
        readonly coupon: string;
        readonly wallet?: Address;
      }[];
    });

/**
 * What a custodian books for the custody entries of a coupon or redemption
 * (§15): its clients' shares of what the omnibus received, by their positions
 * at the record block, each rounded once. Computed from its own books, so it
 * is passed in rather than read from the flow.
 */
export interface CustodyAllocation {
  readonly shares: readonly { readonly client: string; readonly units: bigint; readonly amount: bigint; readonly principal: bigint }[];
}

/**
 * The dealer's signed offer to exchange `sourceAmount` of `from` for
 * `targetAmount` of `to` at `rate` (target per unit of source), for the
 * `requester`'s payment, until `expiresAt` (block time, seconds). The target
 * amount is the source amount times the rate, rounded once, half-even
 * (invariant 11); the signature is the dealer's, over all of it.
 */
export interface Quote {
  readonly id: string;
  readonly dealer: string;
  readonly requester: string;
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly sourceAmount: string;
  readonly rate: string;
  readonly targetAmount: string;
  readonly expiresAt: number;
  readonly signature: Hex;
}

/**
 * §13 A customer of one bank pays a customer of another in another currency,
 * through the dealer, payment versus payment: one instruction burns the
 * payer's deposit, moves the source currency's wholesale from the payer's bank
 * to the dealer and the target currency's from the dealer to the payee's
 * bank, and mints the payee's deposit, at the dealer's quote.
 */
export type FxFlow = Base & {
  readonly kind: "pvp";
  readonly payerBank: string;
  readonly payer: string;
  readonly payeeBank: string;
  readonly payee: string;
  readonly quote: Quote;
};

/** Units of one bond as repo collateral, whole units as a string. */
export interface CollateralUnits {
  readonly bond: string;
  readonly units: string;
}

/** A mark both sides of a repo agreed: one unit of a bond's price, in minor units. */
export interface RepoMark {
  readonly bond: string;
  readonly price: string;
}

interface RepoParties {
  /** The bank that lends cash and holds the collateral. */
  readonly lender: string;
  /** The bank that borrows cash and pledges its bonds. */
  readonly borrower: string;
}

/**
 * §5.7–§5.10 Repo between two banks, each one instruction. A repo is named
 * by the UETR of the instruction that opened it (`repo`); its terms and its
 * collateral are each bank's own record, which every later flow is checked
 * against. Amounts are minor units, units whole units, marks minor units per
 * unit, dates YYYY-MM-DD.
 */
export type RepoFlow =
  /** §5.7 The borrower delivers units of a bond, the lender pays the purchase price, on the terms both affirmed. */
  | (Base &
      RepoParties & {
        readonly kind: "repo-open";
        readonly bond: string;
        readonly units: string;
        /** The bond's mark at the start, per unit: the collateral must cover the cash at it, after the haircut. */
        readonly mark: string;
        readonly cash: string;
        readonly rate: string;
        readonly haircut: string;
        readonly startDate: string;
        readonly endDate: string;
      })
  /**
   * §5.8 At marks both affirmed, as of a date in the repo: the borrower
   * delivers the units a shortfall calls for, or the lender returns the
   * units an excess allows.
   */
  | (Base &
      RepoParties & {
        readonly kind: "repo-margin";
        readonly repo: string;
        readonly direction: "deliver" | "return";
        readonly bond: string;
        readonly units: string;
        readonly marks: readonly RepoMark[];
        readonly asOf: string;
      })
  /** §5.9 The lender returns units of one bond and the borrower delivers units of another worth at least as much. */
  | (Base &
      RepoParties & {
        readonly kind: "repo-substitute";
        readonly repo: string;
        readonly outgoing: CollateralUnits;
        readonly incoming: CollateralUnits;
        readonly marks: readonly RepoMark[];
        readonly asOf: string;
      })
  /** §5.10 Every collateral unit back to the borrower, the purchase price plus interest to the lender. */
  | (Base &
      RepoParties & {
        readonly kind: "repo-close";
        readonly repo: string;
        readonly collateral: readonly CollateralUnits[];
        readonly cash: string;
        readonly interest: string;
      })
  /**
   * §5.10 The coupon the lender received on collateral units, passed on to
   * the borrower: the coupon on the units the repo's record shows at the
   * coupon's record block.
   */
  | (Base &
      RepoParties & {
        readonly kind: "repo-manufactured";
        readonly repo: string;
        readonly bond: string;
        readonly period: number;
        readonly recordBlock: string;
        readonly units: string;
        readonly amount: string;
      });

export type Flow = CashFlow | BondFlow | FxFlow | RepoFlow;
export type FlowKind = Flow["kind"];

/** `Omit` applied to each member of a union, keeping the union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a co-signer affirms before it signs: a buyer an issue or trade; for a
 * repo, the lender its opening and a substitution, and the side that receives
 * units a margin call. The flow, without a deadline.
 */
export type Affirmation = DistributiveOmit<
  Extract<Flow, { kind: "bond-issue" | "bond-trade" | "repo-open" | "repo-margin" | "repo-substitute" }>,
  "deadline"
>;

export interface FlowContext {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
}

const POSITIVE = /^[1-9]\d*$/;

function positive(value: string, what: string): bigint {
  if (!POSITIVE.test(value)) throw new RangeError(`${what} must be a positive whole number: "${value}"`);
  return BigInt(value);
}

/** A cash flow's amount, in minor units. */
export function flowAmount(flow: CashFlow): bigint {
  return positive(flow.amount, "Flow amount");
}

export function isBondFlow(flow: Flow): flow is BondFlow {
  return flow.kind.startsWith("bond-");
}

export function isRepoFlow(flow: Flow): flow is RepoFlow {
  return flow.kind.startsWith("repo-");
}

/** A repo flow's mark for `bond`, in minor units per unit. */
export function markOf(marks: readonly RepoMark[], bond: string): bigint {
  const mark = marks.find((m) => m.bond === bond);
  if (!mark) throw new RangeError(`No mark for ${bond}`);
  return positive(mark.price, "Mark");
}

/** The cash a flow moves on chain, in minor units. */
export function flowValue(flow: Flow): bigint {
  switch (flow.kind) {
    case "bond-issue":
      return flow.allocations.reduce((t, a) => t + positive(a.units, "Units") * positive(flow.price, "Price"), 0n);
    case "bond-trade":
      return positive(flow.units, "Units") * positive(flow.price, "Price");
    case "bond-coupon":
      return flow.payments.reduce((t, p) => t + positive(p.amount, "Coupon"), 0n);
    case "bond-redeem":
      return flow.payments.reduce((t, p) => t + positive(p.principal, "Principal") + BigInt(p.coupon), 0n);
    case "pvp":
      positive(flow.quote.targetAmount, "Target amount");
      return positive(flow.quote.sourceAmount, "Source amount");
    // Repo: the cash it moves, or for collateral moved alone, the units' value at the agreed mark.
    case "repo-open":
      positive(flow.units, "Units");
      positive(flow.mark, "Mark");
      return positive(flow.cash, "Purchase price");
    case "repo-margin":
      return positive(flow.units, "Units") * markOf(flow.marks, flow.bond);
    case "repo-substitute":
      positive(flow.incoming.units, "Units");
      markOf(flow.marks, flow.incoming.bond);
      return positive(flow.outgoing.units, "Units") * markOf(flow.marks, flow.outgoing.bond);
    case "repo-close":
      if (flow.collateral.length === 0) throw new RangeError("A close returns the collateral");
      for (const c of flow.collateral) positive(c.units, "Units");
      if (!/^(0|[1-9]\d*)$/.test(flow.interest)) throw new RangeError(`Interest must be whole minor units: "${flow.interest}"`);
      return positive(flow.cash, "Purchase price") + BigInt(flow.interest);
    case "repo-manufactured":
      positive(flow.units, "Units");
      return positive(flow.amount, "Manufactured payment");
    default:
      return flowAmount(flow);
  }
}

/**
 * The currency a flow's cash moves in: the one a bank funds or redeems, the
 * bank's own deposits' for tokenizing and for a payment between two banks'
 * deposits in it, a bond's for its flows, and the source currency of a
 * payment across currencies.
 */
export function flowCurrency(flow: Flow, scenario: Scenario): CurrencyCode {
  switch (flow.kind) {
    case "fund":
    case "redeem":
      return flow.currency;
    case "tokenize":
    case "detokenize":
      return homeCurrency(scenario, flow.bank);
    case "interbank":
      return depositOf(scenario, flow.payerBank).currency;
    case "pvp":
      return flow.quote.from;
    case "repo-open":
    case "repo-margin":
    case "repo-substitute":
    case "repo-close":
    case "repo-manufactured":
      // A repo is in its scenario's one currency, the bonds' (SPEC.md §1).
      return repoCurrency(scenario);
    default:
      return bondInfo(scenario, flow.bond).terms.face.currency;
  }
}

/** The currency repos settle in: the one currency of a scenario with bonds. */
export function repoCurrency(scenario: Scenario): CurrencyCode {
  const [bond] = scenario.instruments.bonds;
  if (!bond) throw new RangeError(`${scenario.id} has no bonds to lend against`);
  return bond.currency;
}

/** The central bank whose currency a flow moves, for the flows it takes part in. */
export function centralBankOf(flow: Flow, scenario: Scenario): string {
  return centralBankFor(scenario, flowCurrency(flow, scenario)).id;
}

export interface BondInfo {
  readonly symbol: string;
  readonly agent: string;
  /** The issuer's customer id at its agent: its deposit is debited and credited there. */
  readonly issuer: string;
  readonly totalUnits: bigint;
  readonly terms: BondTerms;
  readonly calendar: BusinessCalendar;
}

/** A scenario bond with its terms in the domain's form. */
export function bondInfo(scenario: Scenario, symbol: string): BondInfo {
  const spec = scenario.instruments.bonds.find((b) => b.symbol === symbol);
  if (!spec) throw new RangeError(`No bond "${symbol}" in ${scenario.id}`);
  return {
    symbol,
    agent: spec.agent,
    issuer: spec.issuer,
    totalUnits: spec.units,
    terms: {
      face: parseMoney(spec.currency, spec.face),
      couponRate: spec.couponRate,
      frequency: spec.frequency,
      dayCount: spec.dayCount,
      issueDate: spec.issueDate,
      maturityDate: spec.maturityDate,
      recordDays: spec.recordDays,
      rounding: spec.rounding,
    },
    calendar: { weekendDays: weekdayNumbers(scenario.calendar.weekend), holidays: scenario.calendar.holidays },
  };
}

const customerRef = (bank: string, customer: string) => `${bank}/${customer}`;

/** The participant that starts the flow: the bank asking for funding, otherwise the submitter. */
export function initiatorOf(flow: Flow, ctx: FlowContext): string {
  return flow.kind === "fund" ? flow.bank : submitterOf(flow, ctx);
}

/** The participant that submits the instruction to the engine. */
export function submitterOf(flow: Flow, ctx: FlowContext): string {
  switch (flow.kind) {
    case "fund":
      return centralBankOf(flow, ctx.scenario); // only a currency's central bank mints its wholesale
    case "redeem":
    case "tokenize":
    case "detokenize":
      return flow.bank;
    case "interbank":
    case "pvp":
      return flow.payerBank;
    case "bond-trade":
      return flow.seller;
    case "bond-issue":
    case "bond-coupon":
    case "bond-redeem":
      return bondInfo(ctx.scenario, flow.bond).agent;
    // Repo: whoever delivers units submits; the lender pays a manufactured payment.
    case "repo-open":
    case "repo-substitute":
    case "repo-close":
      return flow.borrower;
    case "repo-margin":
      return flow.direction === "deliver" ? flow.borrower : flow.lender;
    case "repo-manufactured":
      return flow.lender;
  }
}

/**
 * Participants whose signature the instruction needs besides the submitter's:
 * the payee's bank for a payment (the mint creates its liability), the dealer
 * as well for a payment across currencies (its wholesale leaves it), each buyer
 * for an issue or trade (it moves their wholesale tokens), and each holder for
 * a coupon or redemption (it checks its own amount; a redemption also burns
 * its units), and in a repo the side that does not submit (its units or its
 * cash move, and it checks every flow against its own record).
 */
export function approversOf(flow: Flow): string[] {
  switch (flow.kind) {
    case "repo-open":
    case "repo-substitute":
    case "repo-close":
      return [flow.lender];
    case "repo-margin":
      return [flow.direction === "deliver" ? flow.lender : flow.borrower];
    case "repo-manufactured":
      return [flow.borrower];
    case "interbank":
      return [flow.payeeBank];
    case "pvp":
      return [flow.quote.dealer, flow.payeeBank];
    case "bond-issue":
      return [...new Set(flow.allocations.map((a) => a.bank))];
    case "bond-trade":
      return [flow.buyer];
    case "bond-coupon":
    case "bond-redeem":
      return [...new Set(flow.payments.map((p) => p.bank))];
    default:
      return [];
  }
}

/** Participants that book a pending entry before the instruction settles. */
export function bookersOf(flow: Flow, ctx: FlowContext): string[] {
  switch (flow.kind) {
    case "fund":
      return [flow.bank, centralBankOf(flow, ctx.scenario)];
    case "redeem":
    case "tokenize":
    case "detokenize":
      return [flow.bank];
    case "interbank":
      return [flow.payerBank, flow.payeeBank];
    case "pvp":
      return [flow.payerBank, flow.quote.dealer, flow.payeeBank];
    case "bond-trade":
      return [flow.seller, flow.buyer];
    default:
      return [submitterOf(flow, ctx), ...approversOf(flow)];
  }
}

/** The legs the engine executes, with every party resolved to its address. */
export function legsOf(flow: Flow, ctx: FlowContext): ChainInstruction {
  const { scenario, deployment } = ctx;
  const wholesale = tokenAddress(deployment, wholesaleFor(scenario, flowCurrency(flow, scenario)).symbol);
  const party = (ref: string) => addressOf(deployment, ref);
  const deposit = (bank: string) => tokenAddress(deployment, depositOf(scenario, bank).symbol);
  let legs;
  switch (flow.kind) {
    case "fund":
      legs = [leg.mint(wholesale, party(flow.bank), flowAmount(flow))];
      break;
    case "redeem":
      legs = [leg.burn(wholesale, party(flow.bank), flowAmount(flow))];
      break;
    case "tokenize":
      legs = [leg.mint(deposit(flow.bank), party(customerRef(flow.bank, flow.customer)), flowAmount(flow))];
      break;
    case "detokenize":
      legs = [leg.burn(deposit(flow.bank), party(customerRef(flow.bank, flow.customer)), flowAmount(flow))];
      break;
    case "interbank": {
      const amount = flowAmount(flow);
      legs = [
        leg.burn(deposit(flow.payerBank), party(customerRef(flow.payerBank, flow.payer)), amount),
        leg.transfer(wholesale, party(flow.payerBank), party(flow.payeeBank), amount),
        leg.mint(deposit(flow.payeeBank), party(customerRef(flow.payeeBank, flow.payee)), amount),
      ];
      break;
    }
    case "pvp": {
      const { quote } = flow;
      const [source, target] = [positive(quote.sourceAmount, "Source amount"), positive(quote.targetAmount, "Target amount")];
      legs = [
        leg.burn(deposit(flow.payerBank), party(customerRef(flow.payerBank, flow.payer)), source),
        leg.transfer(wholesale, party(flow.payerBank), party(quote.dealer), source),
        leg.transfer(tokenAddress(deployment, wholesaleFor(scenario, quote.to).symbol), party(quote.dealer), party(flow.payeeBank), target),
        leg.mint(deposit(flow.payeeBank), party(customerRef(flow.payeeBank, flow.payee)), target),
      ];
      break;
    }
    case "bond-issue": {
      const bond = tokenAddress(deployment, flow.bond);
      const agent = party(bondInfo(scenario, flow.bond).agent);
      const price = positive(flow.price, "Price");
      legs = [
        ...flow.allocations.map((a) => leg.mint(bond, a.custody?.wallet ?? party(a.bank), positive(a.units, "Units"))),
        ...flow.allocations.map((a) => leg.transfer(wholesale, party(a.bank), agent, positive(a.units, "Units") * price)),
      ];
      break;
    }
    case "bond-trade": {
      const units = positive(flow.units, "Units");
      legs = [
        leg.transfer(
          tokenAddress(deployment, flow.bond),
          flow.sellerCustody?.wallet ?? party(flow.seller),
          flow.buyerCustody?.wallet ?? party(flow.buyer),
          units,
        ),
        leg.transfer(wholesale, party(flow.buyer), party(flow.seller), units * positive(flow.price, "Price")),
      ];
      break;
    }
    case "bond-coupon": {
      const agent = party(bondInfo(scenario, flow.bond).agent);
      legs = flow.payments.map((p) => leg.transfer(wholesale, agent, party(p.bank), positive(p.amount, "Coupon")));
      break;
    }
    case "bond-redeem": {
      const bond = tokenAddress(deployment, flow.bond);
      const agent = party(bondInfo(scenario, flow.bond).agent);
      legs = [
        ...flow.payments.map((p) => leg.burn(bond, p.wallet ?? party(p.bank), positive(p.units, "Units"))),
        ...flow.payments.map((p) => leg.transfer(wholesale, agent, party(p.bank), BigInt(p.principal) + BigInt(p.coupon))),
      ];
      break;
    }
    case "repo-open": {
      const bond = tokenAddress(deployment, flow.bond);
      legs = [
        leg.transfer(bond, party(flow.borrower), party(flow.lender), positive(flow.units, "Units")),
        leg.transfer(wholesale, party(flow.lender), party(flow.borrower), positive(flow.cash, "Purchase price")),
      ];
      break;
    }
    case "repo-margin": {
      const [from, to] = flow.direction === "deliver" ? [flow.borrower, flow.lender] : [flow.lender, flow.borrower];
      legs = [leg.transfer(tokenAddress(deployment, flow.bond), party(from), party(to), positive(flow.units, "Units"))];
      break;
    }
    case "repo-substitute":
      legs = [
        leg.transfer(tokenAddress(deployment, flow.outgoing.bond), party(flow.lender), party(flow.borrower), positive(flow.outgoing.units, "Units")),
        leg.transfer(tokenAddress(deployment, flow.incoming.bond), party(flow.borrower), party(flow.lender), positive(flow.incoming.units, "Units")),
      ];
      break;
    case "repo-close":
      legs = [
        ...flow.collateral.map((c) => leg.transfer(tokenAddress(deployment, c.bond), party(flow.lender), party(flow.borrower), positive(c.units, "Units"))),
        leg.transfer(wholesale, party(flow.borrower), party(flow.lender), positive(flow.cash, "Purchase price") + BigInt(flow.interest)),
      ];
      break;
    case "repo-manufactured":
      legs = [leg.transfer(wholesale, party(flow.lender), party(flow.borrower), positive(flow.amount, "Manufactured payment"))];
      break;
  }
  return { id: uetrToId(flow.uetr), legs, deadline: BigInt(flow.deadline) };
}

/**
 * What `participant` books for `flow`: one balanced entry, or none. A
 * custodian's coupon or redemption on its omnibus holding needs `custody`, its
 * clients' shares (§15), which it computes from its own books.
 */
export function linesFor(flow: Flow, participant: string, ctx: FlowContext, custody?: CustodyAllocation): Line[] {
  const currency = flowCurrency(flow, ctx.scenario);
  const cash = (minor: bigint | string) => money(currency, BigInt(minor));
  if (isRepoFlow(flow)) return repoLines(flow, participant, ctx, cash);
  const cb = centralBankOf(flow, ctx.scenario);
  switch (flow.kind) {
    case "fund": {
      const amount = cash(flowAmount(flow));
      if (participant === flow.bank) return fundWholesale.bank(amount);
      if (participant === cb) return fundWholesale.centralBank(flow.bank, amount);
      return [];
    }
    case "redeem": {
      const amount = cash(flowAmount(flow));
      if (participant === flow.bank) return redeemWholesale.bank(amount);
      if (participant === cb) return redeemWholesale.centralBank(flow.bank, amount);
      return [];
    }
    case "tokenize":
      return participant === flow.bank ? tokenizeDeposit(flow.customer, cash(flowAmount(flow))) : [];
    case "detokenize":
      return participant === flow.bank ? detokenizeDeposit(flow.customer, cash(flowAmount(flow))) : [];
    case "interbank": {
      const amount = cash(flowAmount(flow));
      if (participant === flow.payerBank) return interbankTransfer.payerBank(flow.payer, amount);
      if (participant === flow.payeeBank) return interbankTransfer.payeeBank(flow.payee, amount);
      if (participant === cb) return interbankTransfer.centralBank(flow.payerBank, flow.payeeBank, amount);
      return [];
    }
    case "pvp": {
      const source = cash(flow.quote.sourceAmount);
      const target = money(flow.quote.to, BigInt(flow.quote.targetAmount));
      if (participant === flow.payerBank) return fxPayment.payerBank(flow.payer, source);
      if (participant === flow.quote.dealer) return fxPayment.dealer(source, target);
      if (participant === flow.payeeBank) return fxPayment.payeeBank(flow.payee, target);
      return [];
    }
    case "bond-issue": {
      const info = bondInfo(ctx.scenario, flow.bond);
      const face = info.terms.face.minor;
      if (participant === info.agent) return bondPostings.agentIssue(info.issuer, cash(flowValue(flow)));
      return flow.allocations
        .filter((a) => a.bank === participant)
        .flatMap((a) => {
          const units = BigInt(a.units);
          const [faceValue, consideration] = [cash(units * face), cash(units * BigInt(flow.price))];
          return a.custody
            ? custodyPostings.buy(flow.bond, a.custody.client, faceValue, consideration)
            : bondPostings.buy(flow.bond, faceValue, consideration);
        });
    }
    case "bond-trade": {
      const face = bondInfo(ctx.scenario, flow.bond).terms.face.minor;
      const units = BigInt(flow.units);
      const consideration = cash(units * BigInt(flow.price));
      if (participant === flow.seller) {
        return flow.sellerCustody
          ? custodyPostings.sell(flow.bond, flow.sellerCustody.client, cash(units * face), consideration)
          : bondPostings.sell(flow.bond, cash(units * face), consideration);
      }
      if (participant === flow.buyer) {
        return flow.buyerCustody
          ? custodyPostings.buy(flow.bond, flow.buyerCustody.client, cash(units * face), consideration)
          : bondPostings.buy(flow.bond, cash(units * face), consideration);
      }
      return [];
    }
    case "bond-coupon": {
      const info = bondInfo(ctx.scenario, flow.bond);
      if (participant === info.agent) {
        const paid = sum(currency, flow.payments.map((p) => cash(p.amount)));
        return bondPostings.agentPay(info.issuer, cash(flow.issuerDebit), paid);
      }
      return flow.payments
        .filter((p) => p.bank === participant)
        .flatMap((p) =>
          p.wallet
            ? custodyPostings.allocate(cash(p.amount), sharesOf(custody, flow, participant).map((x) => ({ client: x.client, amount: cash(x.amount) })))
            : bondPostings.receiveCoupon(cash(p.amount)),
        );
    }
    case "bond-redeem": {
      const info = bondInfo(ctx.scenario, flow.bond);
      if (participant === info.agent) {
        const paid = sum(currency, flow.payments.map((p) => cash(BigInt(p.principal) + BigInt(p.coupon))));
        return bondPostings.agentPay(info.issuer, cash(flow.issuerDebit), paid);
      }
      return flow.payments
        .filter((p) => p.bank === participant)
        .flatMap((p) => {
          if (!p.wallet) return bondPostings.redeem(flow.bond, cash(p.principal), cash(p.coupon));
          const shares = sharesOf(custody, flow, participant);
          return [
            ...custodyPostings.allocate(
              cash(BigInt(p.principal) + BigInt(p.coupon)),
              shares.map((x) => ({ client: x.client, amount: cash(x.principal + x.amount) })),
            ),
            ...custodyPostings.cancel(flow.bond, shares.map((x) => ({ client: x.client, faceValue: cash(x.principal) }))),
          ];
        });
    }
  }
}

/** What the lender or the borrower books for a repo flow; nothing for anyone else. */
function repoLines(flow: RepoFlow, participant: string, ctx: FlowContext, cash: (minor: bigint | string) => ReturnType<typeof money>): Line[] {
  const lender = participant === flow.lender;
  if (!lender && participant !== flow.borrower) return [];
  const atFace = (bond: string, units: string) => cash(BigInt(units) * bondInfo(ctx.scenario, bond).terms.face.minor);
  const toLender = (bond: string, units: string) => (lender ? repoPostings.receive : repoPostings.pledge)(bond, atFace(bond, units));
  const toBorrower = (bond: string, units: string) => (lender ? repoPostings.giveBack : repoPostings.recover)(bond, atFace(bond, units));
  switch (flow.kind) {
    case "repo-open":
      return [...(lender ? repoPostings.lend(cash(flow.cash)) : repoPostings.borrow(cash(flow.cash))), ...toLender(flow.bond, flow.units)];
    case "repo-margin":
      return flow.direction === "deliver" ? toLender(flow.bond, flow.units) : toBorrower(flow.bond, flow.units);
    case "repo-substitute":
      return [...toBorrower(flow.outgoing.bond, flow.outgoing.units), ...toLender(flow.incoming.bond, flow.incoming.units)];
    case "repo-close":
      return [
        ...(lender ? repoPostings.repaid : repoPostings.repay)(cash(flow.cash), cash(flow.interest)),
        ...flow.collateral.flatMap((c) => toBorrower(c.bond, c.units)),
      ];
    case "repo-manufactured":
      return lender ? repoPostings.manufacture(cash(flow.amount)) : repoPostings.manufactured(cash(flow.amount));
  }
}

export function describeFlow(flow: Flow): string {
  switch (flow.kind) {
    case "fund":
      return `Fund ${flow.bank} with wholesale ${flow.currency}`;
    case "redeem":
      return `Redeem ${flow.bank}'s wholesale ${flow.currency}`;
    case "tokenize":
      return `Tokenize a deposit of ${flow.customer} at ${flow.bank}`;
    case "detokenize":
      return `Detokenize a deposit of ${flow.customer} at ${flow.bank}`;
    case "interbank":
      return `${flow.payer} at ${flow.payerBank} pays ${flow.payee} at ${flow.payeeBank}`;
    case "pvp":
      return `${flow.payer} at ${flow.payerBank} pays ${flow.payee} at ${flow.payeeBank} in ${flow.quote.to} through ${flow.quote.dealer}`;
    case "bond-issue":
      return `Issue ${flow.bond} to ${flow.allocations.map((a) => a.bank).join(", ")}`;
    case "bond-trade":
      return `${flow.seller} sells ${flow.units} ${flow.bond} to ${flow.buyer}`;
    case "bond-coupon":
      return `Coupon ${flow.period} on ${flow.bond}`;
    case "bond-redeem":
      return `Redemption of ${flow.bond} with coupon ${flow.period}`;
    case "repo-open":
      return `${flow.lender} lends to ${flow.borrower} against ${flow.units} ${flow.bond} (repo)`;
    case "repo-margin":
      return flow.direction === "deliver"
        ? `${flow.borrower} delivers ${flow.units} ${flow.bond} margin to ${flow.lender}`
        : `${flow.lender} returns ${flow.units} ${flow.bond} margin to ${flow.borrower}`;
    case "repo-substitute":
      return `${flow.borrower} substitutes ${flow.incoming.units} ${flow.incoming.bond} for ${flow.outgoing.units} ${flow.outgoing.bond}`;
    case "repo-close":
      return `${flow.borrower} repurchases its collateral from ${flow.lender} (repo close)`;
    case "repo-manufactured":
      return `${flow.lender} pays ${flow.borrower} coupon ${flow.period} on ${flow.units} ${flow.bond} held as collateral`;
  }
}

/** A custodian's clients' shares, which its coupon or redemption on custody units cannot be booked without. */
function sharesOf(custody: CustodyAllocation | undefined, flow: Flow, participant: string): CustodyAllocation["shares"] {
  if (!custody) throw new RangeError(`${participant}'s ${flow.kind} on its omnibus holding needs its clients' positions at the record block`);
  return custody.shares;
}

/** The idempotency key of the journal entry a participant books for an instruction. */
export const entryKey = (uetr: string) => `instruction:${uetr}`;
