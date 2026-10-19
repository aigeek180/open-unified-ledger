import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  type CurrencyCode,
  Decimal,
  formatMoney,
  fromDecimal,
  minorUnit,
  money,
  parseMoney,
  subtract,
  SUPPORTED_CURRENCIES,
  toDecimal,
} from "../src/index.ts";

const currency = fc.constantFrom(...SUPPORTED_CURRENCIES);
const minor = fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n });
const amount = (c: CurrencyCode) => minor.map((m) => money(c, m));

describe("money", () => {
  it("formats and parses back to the same amount", () => {
    fc.assert(
      fc.property(currency, minor, (c, m) => {
        const original = money(c, m);
        expect(parseMoney(c, formatMoney(original))).toEqual(original);
      }),
    );
  });

  it("formats with exactly the currency's decimal places", () => {
    expect(formatMoney(parseMoney("CAD", "10.5"))).toBe("10.50");
    expect(formatMoney(parseMoney("CAD", "-0.07"))).toBe("-0.07");
    expect(formatMoney(parseMoney("JPY", "1000"))).toBe("1000");
    expect(formatMoney(parseMoney("BHD", "1.5"))).toBe("1.500");
  });

  it("rejects more precision than the currency has instead of rounding", () => {
    expect(() => parseMoney("CAD", "10.505")).toThrow(RangeError);
    expect(() => parseMoney("JPY", "10.5")).toThrow(RangeError);
    expect(() => parseMoney("CAD", "1e3")).toThrow(RangeError);
    expect(() => parseMoney("CAD", "01.00")).toThrow(RangeError);
  });

  it("adds commutatively and associatively, and subtract undoes add", () => {
    fc.assert(
      fc.property(
        currency.chain((c) => fc.tuple(amount(c), amount(c), amount(c))),
        ([a, b, c]) => {
          expect(add(a, b)).toEqual(add(b, a));
          expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
          expect(subtract(add(a, b), b)).toEqual(a);
        },
      ),
    );
  });

  it("refuses to combine different currencies", () => {
    expect(() => add(money("CAD", 1n), money("USD", 1n))).toThrow(TypeError);
    expect(() => compare(money("CAD", 1n), money("JPY", 1n))).toThrow(TypeError);
  });

  it("converts to Decimal and back without loss", () => {
    fc.assert(
      fc.property(currency, minor, (c, m) => {
        const original = money(c, m);
        expect(fromDecimal(c, toDecimal(original), "half-even")).toEqual(original);
      }),
    );
  });

  it("rounds a computed value once, within half a minor unit", () => {
    fc.assert(
      fc.property(
        currency,
        minor,
        fc.integer({ min: 1, max: 999_999 }),
        (c, m, rateMillionths) => {
          const exact = toDecimal(money(c, m)).times(new Decimal(rateMillionths).dividedBy(1_000_000));
          const rounded = fromDecimal(c, exact, "half-even");
          const error = toDecimal(rounded).minus(exact).abs();
          const halfUnit = new Decimal(1).dividedBy(new Decimal(10).toPower(minorUnit(c))).dividedBy(2);
          expect(error.lessThanOrEqualTo(halfUnit)).toBe(true);
        },
      ),
    );
  });

  it("applies the named rounding rule", () => {
    const half = new Decimal("0.125");
    expect(fromDecimal("CAD", half, "half-even").minor).toBe(12n);
    expect(fromDecimal("CAD", half, "half-up").minor).toBe(13n);
    expect(fromDecimal("CAD", half, "down").minor).toBe(12n);
    expect(fromDecimal("CAD", new Decimal("0.121"), "up").minor).toBe(13n);
  });
});
