import { type CurrencyCode, minorUnit } from "./currency.ts";
import { Decimal, type Rounding, roundingMode } from "./decimal.ts";

/**
 * An amount of one currency in integer minor units. Never a JavaScript
 * number: `minor` is a bigint end to end, from Postgres to the chain.
 */
export interface Money {
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

export function money(currency: CurrencyCode, minor: bigint): Money {
  return Object.freeze({ currency, minor });
}

export function zero(currency: CurrencyCode): Money {
  return money(currency, 0n);
}

const AMOUNT_PATTERN = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Parse a decimal string exactly. "10.50" is 1050 minor units of CAD; "10.505"
 * is rejected for CAD rather than rounded, and "10.5" is rejected for JPY.
 */
export function parseMoney(currency: CurrencyCode, value: string): Money {
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Not a decimal amount: "${value}"`);
  }
  const [, sign, whole = "0", fraction = ""] = match;
  const digits = minorUnit(currency);
  if (fraction.length > digits) {
    throw new RangeError(
      `${currency} has ${digits} decimal places; "${value}" has ${fraction.length}`,
    );
  }
  const minor = BigInt(whole + fraction.padEnd(digits, "0"));
  return money(currency, sign ? -minor : minor);
}

/** Format with exactly the currency's decimal places, e.g. "-1234.50". */
export function formatMoney(amount: Money): string {
  const digits = minorUnit(amount.currency);
  const negative = amount.minor < 0n;
  const abs = (negative ? -amount.minor : amount.minor).toString();
  if (digits === 0) {
    return (negative ? "-" : "") + abs;
  }
  const padded = abs.padStart(digits + 1, "0");
  const whole = padded.slice(0, -digits);
  const fraction = padded.slice(-digits);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Currency mismatch: ${a.currency} and ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.currency, a.minor - b.minor);
}

export function negate(a: Money): Money {
  return money(a.currency, -a.minor);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

export function sum(currency: CurrencyCode, amounts: Iterable<Money>): Money {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new TypeError(`Currency mismatch: ${currency} and ${amount.currency}`);
    }
    total += amount.minor;
  }
  return money(currency, total);
}

/** The amount in major units as a Decimal, for rate arithmetic. */
export function toDecimal(amount: Money): Decimal {
  return new Decimal(amount.minor.toString()).dividedBy(
    new Decimal(10).toPower(minorUnit(amount.currency)),
  );
}

/**
 * Round a computed major-unit Decimal to Money, once, by a named rule. This is
 * the only way a rate's result becomes money.
 */
export function fromDecimal(
  currency: CurrencyCode,
  value: Decimal,
  rounding: Rounding,
): Money {
  const minor = value
    .times(new Decimal(10).toPower(minorUnit(currency)))
    .toDecimalPlaces(0, roundingMode(rounding));
  return money(currency, BigInt(minor.toFixed(0)));
}
