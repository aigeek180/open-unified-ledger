import type { CurrencyCode } from "./currency.ts";
import { Decimal, parseDecimal, type Rounding } from "./decimal.ts";
import { fromDecimal, type Money, money, sum, toDecimal } from "./money.ts";

/**
 * A fixed-rate bond's schedule and payments (SPEC.md §5.4–§5.6): coupon
 * periods rolled back from maturity, payment dates moved to the following
 * business day, record dates a number of business days earlier, the coupon
 * per period by the bond's day count, and each holder's share rounded once.
 *
 * Dates are ISO calendar dates (YYYY-MM-DD) in the scenario's time zone;
 * arithmetic on them is done in UTC so no clock change can shift a day.
 */

export type Frequency = "annual" | "semiannual" | "quarterly";
export type DayCount = "ACT/365F" | "ACT/ACT-ICMA" | "30/360";

export interface BondTerms {
  readonly face: Money;
  /** Annual rate as a decimal string, e.g. "0.0325". */
  readonly couponRate: string;
  readonly frequency: Frequency;
  readonly dayCount: DayCount;
  readonly issueDate: string;
  readonly maturityDate: string;
  /** Business days between the record date and the payment date. */
  readonly recordDays: number;
  readonly rounding: Rounding;
}

export interface BusinessCalendar {
  /** Weekdays that are not business days, 0 = Sunday … 6 = Saturday. */
  readonly weekendDays: readonly number[];
  readonly holidays: readonly string[];
}

export interface CouponPeriod {
  /** 1-based position in the schedule. */
  readonly number: number;
  /** Accrual start and end, unadjusted. */
  readonly start: string;
  readonly end: string;
  /** The end moved to the following business day. */
  readonly paymentDate: string;
  readonly recordDate: string;
  readonly final: boolean;
}

const MONTHS: Record<Frequency, number> = { annual: 12, semiannual: 6, quarterly: 3 };
const PER_YEAR: Record<Frequency, number> = { annual: 1, semiannual: 2, quarterly: 4 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function weekdayNumbers(names: readonly string[]): number[] {
  return names.map((name) => {
    const n = WEEKDAYS.indexOf(name);
    if (n < 0) throw new RangeError(`Not a weekday: ${name}`);
    return n;
  });
}

// ---------------------------------------------------------------- calendar arithmetic

function parseDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError(`Not a date: ${iso}`);
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    throw new RangeError(`Not a date: ${iso}`);
  }
  return date;
}

const format = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const date = parseDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return format(date);
}

/** Add months, clamping to the last day of the month (31 Aug + 6 months = 28 or 29 Feb). */
export function addMonths(iso: string, months: number): string {
  const date = parseDate(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return format(date);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000);
}

export function isBusinessDay(iso: string, calendar: BusinessCalendar): boolean {
  return !calendar.weekendDays.includes(parseDate(iso).getUTCDay()) && !calendar.holidays.includes(iso);
}

/** The date itself if a business day, else the next business day ("following"). */
export function following(iso: string, calendar: BusinessCalendar): string {
  let date = iso;
  while (!isBusinessDay(date, calendar)) date = addDays(date, 1);
  return date;
}

export function businessDaysBefore(iso: string, count: number, calendar: BusinessCalendar): string {
  let date = iso;
  for (let moved = 0; moved < count; ) {
    date = addDays(date, -1);
    if (isBusinessDay(date, calendar)) moved++;
  }
  return date;
}

// ---------------------------------------------------------------- schedule

/**
 * Coupon periods, rolled back from maturity in steps of 12 / frequency months
 * (the market convention): every period is regular except possibly the
 * first, which starts on the issue date.
 */
export function couponSchedule(terms: BondTerms, calendar: BusinessCalendar): CouponPeriod[] {
  const step = MONTHS[terms.frequency];
  if (daysBetween(terms.issueDate, terms.maturityDate) <= 0) {
    throw new RangeError("A bond must mature after it is issued");
  }
  const ends: string[] = [];
  for (let k = 0; ; k++) {
    const end = addMonths(terms.maturityDate, -step * k);
    if (daysBetween(terms.issueDate, end) <= 0) break;
    ends.unshift(end);
  }
  return ends.map((end, index) => {
    const paymentDate = following(end, calendar);
    return {
      number: index + 1,
      start: index === 0 ? terms.issueDate : ends[index - 1]!,
      end,
      paymentDate,
      recordDate: businessDaysBefore(paymentDate, terms.recordDays, calendar),
      final: index === ends.length - 1,
    };
  });
}

/** The fraction of a year a period accrues, by the bond's day count. */
export function yearFraction(terms: BondTerms, period: Pick<CouponPeriod, "start" | "end">): Decimal {
  const { start, end } = period;
  switch (terms.dayCount) {
    case "ACT/365F":
      return new Decimal(daysBetween(start, end)).dividedBy(365);
    case "30/360": {
      const a = parseDate(start);
      const b = parseDate(end);
      const d1 = Math.min(a.getUTCDate(), 30);
      const d2 = b.getUTCDate() === 31 && d1 === 30 ? 30 : b.getUTCDate();
      const days =
        360 * (b.getUTCFullYear() - a.getUTCFullYear()) + 30 * (b.getUTCMonth() - a.getUTCMonth()) + (d2 - d1);
      return new Decimal(days).dividedBy(360);
    }
    case "ACT/ACT-ICMA": {
      // Actual days over the days of the regular period ending on `end`, times one period's share of a year.
      const notionalStart = addMonths(end, -MONTHS[terms.frequency]);
      return new Decimal(daysBetween(start, end))
        .dividedBy(daysBetween(notionalStart, end))
        .dividedBy(PER_YEAR[terms.frequency]);
    }
  }
}

// ---------------------------------------------------------------- payments

export interface Holding<H extends string = string> {
  readonly holder: H;
  readonly units: bigint;
}

export interface CouponPayment<H extends string = string> {
  readonly period: CouponPeriod;
  /** Each holder's coupon, rounded once from the exact amount per unit. */
  readonly payments: readonly { holder: H; units: bigint; amount: Money }[];
  /** What the issuer pays: the coupon on all outstanding units, rounded once. */
  readonly issuerDebit: Money;
  /**
   * issuerDebit minus the sum paid to holders: what per-holder rounding left
   * over (positive) or overspent (negative). Invariant 8: paid + residual = issuerDebit.
   */
  readonly residual: Money;
}

/** The exact coupon on one unit for a period, before any rounding. */
export function couponPerUnit(terms: BondTerms, period: Pick<CouponPeriod, "start" | "end">): Decimal {
  return toDecimal(terms.face).times(parseDecimal(terms.couponRate)).times(yearFraction(terms, period));
}

export function couponPayment<H extends string>(
  terms: BondTerms,
  period: CouponPeriod,
  holdings: readonly Holding<H>[],
): CouponPayment<H> {
  const currency: CurrencyCode = terms.face.currency;
  const perUnit = couponPerUnit(terms, period);
  const payments = holdings
    .filter((h) => h.units > 0n)
    .map((h) => ({
      holder: h.holder,
      units: h.units,
      amount: fromDecimal(currency, perUnit.times(h.units.toString()), terms.rounding),
    }));
  const totalUnits = holdings.reduce((total, h) => total + h.units, 0n);
  const issuerDebit = fromDecimal(currency, perUnit.times(totalUnits.toString()), terms.rounding);
  const paid = sum(currency, payments.map((p) => p.amount));
  return { period, payments, issuerDebit, residual: money(currency, issuerDebit.minor - paid.minor) };
}

/** Principal repaid on `units` at maturity: face per unit, exactly. */
export function principal(terms: BondTerms, units: bigint): Money {
  return money(terms.face.currency, terms.face.minor * units);
}
