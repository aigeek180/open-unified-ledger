import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertBalanced, convert, type CurrencyCode, fxPayment, minorUnit, money, parseMoney, parseRate } from "../src/index.ts";

/** The same conversion in integers only: source minor units times the rate in millionths, rounded half-even once. */
function exact(sourceMinor: bigint, from: CurrencyCode, rateMillionths: bigint, to: CurrencyCode): bigint {
  const numerator = sourceMinor * rateMillionths * 10n ** BigInt(minorUnit(to));
  const denominator = 1_000_000n * 10n ** BigInt(minorUnit(from));
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

describe("FX conversion", () => {
  it("converts at the quoted rate, rounding once, half-even, in the target's minor unit", () => {
    expect(convert(parseMoney("CAD", "1000.00"), "0.7315", "USD")).toEqual(money("USD", 73150n));
    // Ties go to the even minor unit.
    expect(convert(parseMoney("CAD", "0.25"), "0.5", "USD")).toEqual(money("USD", 12n));
    expect(convert(parseMoney("CAD", "0.35"), "0.5", "USD")).toEqual(money("USD", 18n));
    // Into a currency with no minor unit, and one with three.
    expect(convert(parseMoney("USD", "100.00"), "151.255", "JPY")).toEqual(money("JPY", 15126n));
    expect(convert(parseMoney("USD", "1.00"), "0.376", "BHD")).toEqual(money("BHD", 376n));
  });

  it("matches integer arithmetic for any amount and rate", () => {
    const pairs: [CurrencyCode, CurrencyCode][] = [["CAD", "USD"], ["USD", "CAD"], ["USD", "JPY"], ["JPY", "USD"], ["CAD", "BHD"]];
    fc.assert(
      fc.property(
        fc.constantFrom(...pairs),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        ([from, to], sourceMinor, rateMillionths) => {
          const rate = `${rateMillionths / 1_000_000n}.${(rateMillionths % 1_000_000n).toString().padStart(6, "0")}`;
          expect(convert(money(from, sourceMinor), rate, to)).toEqual(money(to, exact(sourceMinor, from, rateMillionths, to)));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("refuses a rate numeric(19,6) cannot hold, or that is not positive", () => {
    for (const rate of ["0", "0.000000", "-1.2", "1.2345678", "1e3", "12345678901234", " 1.2", "01.5", ".5"]) {
      expect(() => parseRate(rate), rate).toThrow(RangeError);
    }
    expect(parseRate("1234567890123.123456").toFixed()).toBe("1234567890123.123456");
    expect(() => convert(parseMoney("CAD", "1.00"), "1", "CAD")).toThrow(RangeError);
  });

  it("books a payment across currencies so that every entry balances in each currency", () => {
    const source = parseMoney("CAD", "1000.00");
    const target = convert(source, "0.7315", "USD");
    const dealer = fxPayment.dealer(source, target);
    assertBalanced(dealer);
    expect(dealer.map((l) => `${l.side} ${l.account} ${l.amount.minor} ${l.amount.currency}`)).toEqual([
      "debit wholesale-reserves/CAD 100000 CAD",
      "credit fx-position/CAD 100000 CAD",
      "debit fx-position/USD 73150 USD",
      "credit wholesale-reserves/USD 73150 USD",
    ]);
    assertBalanced(fxPayment.payerBank("northwind-freight", source));
    assertBalanced(fxPayment.payeeBank("mesa-solar", target));
  });
});
