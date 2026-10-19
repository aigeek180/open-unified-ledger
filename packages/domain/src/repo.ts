import { daysBetween } from "./bond.ts";
import { Decimal, parseDecimal } from "./decimal.ts";
import { fromDecimal, type Money, money, toDecimal } from "./money.ts";

/**
 * Repurchase agreements (SPEC.md §5.7–§5.10): a lender buys bond units from
 * a borrower for cash and sells them back at the end date for the cash plus
 * repo interest. Title to the collateral moves on chain; the economics stay
 * with the borrower.
 *
 * Interest is the purchase price times the repo rate times the days held
 * over 365 (ACT/365F, the money-market convention), rounded once, half-even,
 * to the minor unit. Collateral is valued at a mark both sides agreed, after
 * the haircut: units times the mark times (1 − haircut). It covers the repo
 * when that value is at least the cash lent plus the interest accrued to the
 * mark's date (invariant 14). Every comparison is exact: no value is rounded
 * before it is compared.
 */

export type RepoDayCount = "ACT/365F";

export interface RepoTerms {
  /** The purchase price: the cash the lender pays at the start. */
  readonly cash: Money;
  /** Annual repo rate as a decimal string, e.g. "0.0275". */
  readonly rate: string;
  /** The haircut as a fraction, e.g. "0.02": collateral counts at 98% of its mark. */
  readonly haircut: string;
  /** Calendar dates (YYYY-MM-DD) in the scenario's time zone. */
  readonly startDate: string;
  readonly endDate: string;
  readonly dayCount: RepoDayCount;
}

/** Units of one bond held as collateral. */
export interface CollateralLine {
  readonly bond: string;
  readonly units: bigint;
}

/** What one unit of a bond is worth at a mark both sides agreed, in the repo's currency. */
export interface Mark {
  readonly bond: string;
  readonly price: Money;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A rate or haircut: a plain decimal fraction in [0, 1). */
export function parseFraction(value: string, what: string): Decimal {
  const fraction = parseDecimal(value);
  if (fraction.isNegative() || fraction.greaterThanOrEqualTo(1)) throw new RangeError(`${what} is a fraction in [0, 1), e.g. "0.02": "${value}"`);
  return fraction;
}

/** Refuse terms no repo could have: a non-positive purchase price, an end before the start, a rate or haircut out of range. */
export function assertRepoTerms(terms: RepoTerms): void {
  if (terms.cash.minor <= 0n) throw new RangeError("A repo's purchase price must be positive");
  if (!ISO_DATE.test(terms.startDate) || !ISO_DATE.test(terms.endDate)) throw new RangeError("A repo's dates are YYYY-MM-DD");
  if (daysBetween(terms.startDate, terms.endDate) <= 0) throw new RangeError("A repo ends after it starts");
  if (terms.dayCount !== "ACT/365F") throw new RangeError(`A repo accrues ACT/365F, not ${terms.dayCount}`);
  parseFraction(terms.rate, "The repo rate");
  parseFraction(terms.haircut, "The haircut");
}

/** Days the cash has been held on `asOf`, which must lie between the start and the end dates. */
export function daysHeld(terms: RepoTerms, asOf: string): number {
  const days = daysBetween(terms.startDate, asOf);
  if (days < 0 || daysBetween(asOf, terms.endDate) < 0) {
    throw new RangeError(`${asOf} is outside the repo, ${terms.startDate} to ${terms.endDate}`);
  }
  return days;
}

/** Repo interest accrued to `asOf`: purchase price × rate × days / 365, rounded once, half-even. */
export function repoInterest(terms: RepoTerms, asOf: string): Money {
  const days = daysHeld(terms, asOf);
  const exact = toDecimal(terms.cash).times(parseDecimal(terms.rate)).times(days).dividedBy(365);
  return fromDecimal(terms.cash.currency, exact, "half-even");
}

/** What the lender is owed on `asOf`: the cash lent plus interest accrued so far. */
export function repoExposure(terms: RepoTerms, asOf: string): Money {
  return money(terms.cash.currency, terms.cash.minor + repoInterest(terms, asOf).minor);
}

/** What the borrower pays back at the end date: the purchase price plus interest over every day held. */
export function repurchasePrice(terms: RepoTerms): Money {
  return repoExposure(terms, terms.endDate);
}

function markOf(marks: readonly Mark[], bond: string, currency: Money["currency"]): Money {
  const mark = marks.find((m) => m.bond === bond);
  if (!mark) throw new RangeError(`No mark for ${bond}`);
  if (mark.price.currency !== currency) throw new RangeError(`${bond} is marked in ${mark.price.currency}, the repo is in ${currency}`);
  if (mark.price.minor <= 0n) throw new RangeError(`${bond}'s mark must be positive`);
  return mark.price;
}

/** One unit's value after the haircut, in minor units, exactly. */
function unitValue(terms: RepoTerms, marks: readonly Mark[], bond: string): Decimal {
  const price = markOf(marks, bond, terms.cash.currency);
  return new Decimal(price.minor.toString()).times(new Decimal(1).minus(parseFraction(terms.haircut, "The haircut")));
}

/** The collateral's value at the marks, after the haircut, in minor units, exactly (never rounded). */
export function collateralValue(terms: RepoTerms, collateral: readonly CollateralLine[], marks: readonly Mark[]): Decimal {
  return collateral.reduce((total, line) => total.plus(unitValue(terms, marks, line.bond).times(line.units.toString())), new Decimal(0));
}

/** Whether the collateral, at the marks after the haircut, covers the cash lent plus interest accrued to `asOf`. */
export function isCovered(terms: RepoTerms, collateral: readonly CollateralLine[], marks: readonly Mark[], asOf: string): boolean {
  return collateralValue(terms, collateral, marks).greaterThanOrEqualTo(repoExposure(terms, asOf).minor.toString());
}

export type MarginCall =
  | { readonly direction: "none" }
  /** The borrower delivers `units` more of `bond`: the fewest that cover the exposure again. */
  | { readonly direction: "deliver"; readonly bond: string; readonly units: bigint }
  /** The lender returns `units` of `bond`: the most it can while the rest still covers the exposure. */
  | { readonly direction: "return"; readonly bond: string; readonly units: bigint };

/**
 * The margin a mark calls for, settled in units of `bond` (SPEC.md §5.8): if
 * the collateral at the marks, after the haircut, falls short of the cash
 * lent plus interest accrued to `asOf`, the fewest units of `bond` that cover
 * it again; if it exceeds it by at least one unit of `bond`, the most units
 * of `bond` the lender can return while the rest still covers it (no more
 * than it holds of `bond`). Otherwise nothing moves.
 */
export function marginCall(
  terms: RepoTerms,
  collateral: readonly CollateralLine[],
  marks: readonly Mark[],
  asOf: string,
  bond: string,
): MarginCall {
  const exposure = new Decimal(repoExposure(terms, asOf).minor.toString());
  const value = collateralValue(terms, collateral, marks);
  const perUnit = unitValue(terms, marks, bond);
  if (perUnit.isZero()) throw new RangeError(`${bond} is worth nothing after a 100% haircut`);
  if (value.lessThan(exposure)) {
    const units = BigInt(exposure.minus(value).dividedBy(perUnit).ceil().toFixed(0));
    return { direction: "deliver", bond, units };
  }
  const held = collateral.filter((c) => c.bond === bond).reduce((t, c) => t + c.units, 0n);
  const spare = BigInt(value.minus(exposure).dividedBy(perUnit).floor().toFixed(0));
  const units = spare < held ? spare : held;
  return units > 0n ? { direction: "return", bond, units } : { direction: "none" };
}

/**
 * How many units of the incoming bond replace `out` in a substitution at the
 * marks (SPEC.md §5.9): the fewest whose value is at least the outgoing
 * units' value, so the lender is never left with less collateral than it had.
 * The haircut is the repo's, the same for every bond it accepts.
 */
export function substitutionUnits(out: CollateralLine, incoming: string, marks: readonly Mark[], currency: Money["currency"]): bigint {
  if (out.units <= 0n) throw new RangeError("A substitution returns at least one unit");
  if (out.bond === incoming) throw new RangeError("A substitution swaps one bond for another");
  const [priceOut, priceIn] = [markOf(marks, out.bond, currency), markOf(marks, incoming, currency)];
  const value = priceOut.minor * out.units;
  return (value + priceIn.minor - 1n) / priceIn.minor;
}

/** The collateral after units move: `delta` positive to the lender, negative back to the borrower. Lines that reach zero go. */
export function moveCollateral(collateral: readonly CollateralLine[], bond: string, delta: bigint): CollateralLine[] {
  const held = collateral.find((c) => c.bond === bond)?.units ?? 0n;
  if (held + delta < 0n) throw new RangeError(`The lender holds ${held} units of ${bond} as collateral, not ${-delta}`);
  const next = collateral.filter((c) => c.bond !== bond).map((c) => ({ ...c }));
  if (held + delta > 0n) next.push({ bond, units: held + delta });
  return next.sort((a, b) => (a.bond < b.bond ? -1 : a.bond > b.bond ? 1 : 0));
}
