import type { CurrencyCode } from "./currency.ts";
import { type Decimal, parseDecimal } from "./decimal.ts";
import { fromDecimal, type Money, toDecimal } from "./money.ts";

/**
 * Foreign exchange for payment versus payment (SPEC.md §13). A rate is a
 * decimal string of target currency per unit of source currency, stored as
 * `numeric(19,6)`: positive, at most six decimal places and thirteen whole
 * digits. A converted amount is the source amount times the rate, rounded
 * once, half-even, to the target currency's minor unit (invariant 11).
 */

const RATE_PATTERN = /^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/;

/** Parse a rate exactly, refusing what `numeric(19,6)` could not hold or what is not positive. */
export function parseRate(value: string): Decimal {
  if (!RATE_PATTERN.test(value)) {
    throw new RangeError(`A rate is a positive decimal with at most 6 decimal places: "${value}"`);
  }
  const rate = parseDecimal(value);
  if (!rate.greaterThan(0)) throw new RangeError(`A rate must be positive: "${value}"`);
  return rate;
}

/** `amount` in `target` at `rate`, rounded once, half-even, to the target's minor unit. */
export function convert(amount: Money, rate: string, target: CurrencyCode): Money {
  if (amount.currency === target) throw new RangeError(`Nothing to convert: ${target} into itself`);
  return fromDecimal(target, toDecimal(amount).times(parseRate(rate)), "half-even");
}

