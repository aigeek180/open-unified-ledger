import { Decimal as DecimalJs } from "decimal.js";

/**
 * The one Decimal constructor the engine uses for rates, interest and coupon
 * arithmetic. Forty significant digits is far beyond any amount or rate here,
 * so precision is never what decides a result: the explicit rounding is.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;

/** Rounding rules a bond or deposit product can name in its terms. */
export type Rounding = "half-even" | "half-up" | "down" | "up";

const ROUNDING_MODES: Record<Rounding, DecimalJs.Rounding> = {
  "half-even": DecimalJs.ROUND_HALF_EVEN,
  "half-up": DecimalJs.ROUND_HALF_UP,
  down: DecimalJs.ROUND_DOWN,
  up: DecimalJs.ROUND_UP,
};

export function roundingMode(rounding: Rounding): DecimalJs.Rounding {
  return ROUNDING_MODES[rounding];
}

/** A decimal string such as "0.0425" or "-12.5"; no exponent, no spaces. */
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function parseDecimal(value: string): Decimal {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new RangeError(`Not a plain decimal string: "${value}"`);
  }
  return new Decimal(value);
}
