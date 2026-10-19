import { type CurrencyCode, Decimal, minorUnit, parseDecimal } from "@oul/domain";

/**
 * Source amounts, in minor units of `from`, whose exact value in `to` at
 * `rate` falls within a twentieth of a minor unit of the half: just below,
 * exactly on and just above it, with the whole part both odd and even. Once,
 * half-even rounding takes each to a different neighbour than rounding twice
 * (to a tenth, then to the unit) or rounding half up would, for some of them.
 */
export function roundingProbes(from: CurrencyCode, to: CurrencyCode, rate: string): bigint[] {
  const wanted = new Map<string, bigint>();
  const start = 100n * 10n ** BigInt(minorUnit(from));
  for (let s = start; s < start + 200_000n && wanted.size < 6; s++) {
    const where = nearHalf(from, to, rate, s);
    if (where && !wanted.has(where)) wanted.set(where, s);
  }
  return [...wanted.values()];
}

/**
 * Whether `amount` of `from` at `rate` lands within a twentieth of a minor
 * unit of the half in `to`, and where: "below", "on" or "above" it, with the
 * whole part "odd" or "even". Undefined if it lands anywhere else.
 */
export function nearHalf(from: CurrencyCode, to: CurrencyCode, rate: string, amount: bigint): string | undefined {
  const exact = parseDecimal(rate).times(new Decimal(10).toPower(minorUnit(to) - minorUnit(from))).times(amount.toString());
  const whole = exact.floor();
  const fraction = exact.minus(whole);
  const parity = whole.mod(2).isZero() ? "even" : "odd";
  if (fraction.equals("0.5")) return `on-${parity}`;
  if (fraction.greaterThanOrEqualTo("0.45") && fraction.lessThan("0.5")) return `below-${parity}`;
  if (fraction.greaterThan("0.5") && fraction.lessThanOrEqualTo("0.55")) return `above-${parity}`;
  return undefined;
}
