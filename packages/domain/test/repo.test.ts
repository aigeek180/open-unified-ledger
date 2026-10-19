import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertBalanced,
  assertRepoTerms,
  type CollateralLine,
  isCovered,
  marginCall,
  type Mark,
  money,
  moveCollateral,
  parseMoney,
  repoExposure,
  repoInterest,
  repoPostings,
  type RepoTerms,
  repurchasePrice,
  substitutionUnits,
} from "../src/index.ts";

const terms = (overrides: Partial<RepoTerms> = {}): RepoTerms => ({
  cash: parseMoney("CAD", "10000000.00"),
  rate: "0.0275",
  haircut: "0.02",
  startDate: "2027-01-15",
  endDate: "2027-01-22",
  dayCount: "ACT/365F",
  ...overrides,
});
const mark = (bond: string, price: string): Mark => ({ bond, price: parseMoney("CAD", price) });

/** cash × rate × days / 365 in integers only, the rate in millionths, rounded half-even once. */
function exactInterest(cashMinor: bigint, rateMillionths: bigint, days: bigint): bigint {
  const numerator = cashMinor * rateMillionths * days;
  const denominator = 1_000_000n * 365n;
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

describe("repo interest", () => {
  it("is the purchase price × rate × days / 365, rounded once, half-even", () => {
    // 10,000,000 × 2.75% × 7 / 365 = 5,273.9726…
    expect(repoInterest(terms(), "2027-01-22")).toEqual(parseMoney("CAD", "5273.97"));
    expect(repurchasePrice(terms())).toEqual(parseMoney("CAD", "10005273.97"));
    expect(repoInterest(terms(), "2027-01-15")).toEqual(money("CAD", 0n));
    expect(repoExposure(terms(), "2027-01-18")).toEqual(parseMoney("CAD", "10002260.27"));
    // Ties go to the even minor unit: 3.65 × 0.5 × 1 / 365 = 0.005 → 0.00; 10.95 × 0.5 / 365 = 0.015 → 0.02.
    const tie = { rate: "0.5", startDate: "2027-01-15", endDate: "2027-01-16" };
    expect(repoInterest(terms({ ...tie, cash: parseMoney("CAD", "3.65") }), "2027-01-16")).toEqual(money("CAD", 0n));
    expect(repoInterest(terms({ ...tie, cash: parseMoney("CAD", "10.95") }), "2027-01-16")).toEqual(money("CAD", 2n));
  });

  it("matches integer arithmetic for any purchase price, rate and term", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.bigInt({ min: 0n, max: 999_999n }),
        fc.integer({ min: 1, max: 400 }),
        (cashMinor, rateMillionths, days) => {
          const rate = `0.${rateMillionths.toString().padStart(6, "0")}`;
          const end = new Date(Date.UTC(2027, 0, 15 + days)).toISOString().slice(0, 10);
          const t = terms({ cash: money("CAD", cashMinor), rate, endDate: end });
          expect(repoInterest(t, end).minor).toBe(exactInterest(cashMinor, rateMillionths, BigInt(days)));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("refuses terms no repo could have, and a date outside the repo", () => {
    expect(() => assertRepoTerms(terms())).not.toThrow();
    expect(() => assertRepoTerms(terms({ cash: money("CAD", 0n) }))).toThrow(/positive/);
    expect(() => assertRepoTerms(terms({ endDate: "2027-01-15" }))).toThrow(/ends after it starts/);
    expect(() => assertRepoTerms(terms({ haircut: "1" }))).toThrow(/fraction/);
    expect(() => assertRepoTerms(terms({ rate: "-0.01" }))).toThrow(/fraction/);
    expect(() => repoInterest(terms(), "2027-01-23")).toThrow(/outside the repo/);
    expect(() => repoInterest(terms(), "2027-01-14")).toThrow(/outside the repo/);
  });
});

describe("collateral", () => {
  const t = terms();
  // 10,300 units marked at 1,000.00 with a 2% haircut: 10,094,000.00, which covers 10,000,000 plus a week's interest.
  const held: CollateralLine[] = [{ bond: "BOND-A", units: 10_300n }];

  it("covers the cash lent plus interest accrued at the mark, after the haircut", () => {
    expect(isCovered(t, held, [mark("BOND-A", "1000.00")], "2027-01-22")).toBe(true);
    // At 990.00 the units are worth 9,993,060.00 after the haircut: short.
    expect(isCovered(t, held, [mark("BOND-A", "990.00")], "2027-01-18")).toBe(false);
  });

  it("calls the fewest units that cover the shortfall, and returns the most that leave it covered", () => {
    const marks = [mark("BOND-A", "990.00")];
    const call = marginCall(t, held, marks, "2027-01-18", "BOND-A");
    expect(call).toEqual({ direction: "deliver", bond: "BOND-A", units: 10n });
    expect(isCovered(t, moveCollateral(held, "BOND-A", 10n), marks, "2027-01-18")).toBe(true);
    expect(isCovered(t, moveCollateral(held, "BOND-A", 9n), marks, "2027-01-18")).toBe(false);

    const up = [mark("BOND-A", "1010.00")];
    const back = marginCall(t, held, up, "2027-01-18", "BOND-A");
    expect(back).toEqual({ direction: "return", bond: "BOND-A", units: 194n });
    expect(isCovered(t, moveCollateral(held, "BOND-A", -194n), up, "2027-01-18")).toBe(true);
    expect(isCovered(t, moveCollateral(held, "BOND-A", -195n), up, "2027-01-18")).toBe(false);
    expect(marginCall(t, moveCollateral(held, "BOND-A", -194n), up, "2027-01-18", "BOND-A")).toEqual({ direction: "none" });
  });

  it("for any mark, a delivery covers exactly and a return leaves it covered", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 50_000n }),
        fc.bigInt({ min: 50_000n, max: 200_000n }),
        fc.integer({ min: 0, max: 7 }),
        (units, priceMinor, day) => {
          const collateral = [{ bond: "BOND-A", units }];
          const marks = [{ bond: "BOND-A", price: money("CAD", priceMinor) }];
          const asOf = `2027-01-${String(15 + day).padStart(2, "0")}`;
          const call = marginCall(t, collateral, marks, asOf, "BOND-A");
          if (call.direction === "deliver") {
            expect(isCovered(t, moveCollateral(collateral, "BOND-A", call.units), marks, asOf)).toBe(true);
            expect(isCovered(t, moveCollateral(collateral, "BOND-A", call.units - 1n), marks, asOf)).toBe(false);
          } else if (call.direction === "return") {
            const after = moveCollateral(collateral, "BOND-A", -call.units);
            expect(isCovered(t, after, marks, asOf)).toBe(true);
            if (call.units < units) expect(isCovered(t, moveCollateral(after, "BOND-A", -1n), marks, asOf)).toBe(false);
          } else {
            expect(isCovered(t, collateral, marks, asOf)).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("substitutes the fewest incoming units worth at least the outgoing ones", () => {
    const marks = [mark("BOND-A", "1001.50"), mark("BOND-B", "987.25")];
    const units = substitutionUnits({ bond: "BOND-A", units: 10_300n }, "BOND-B", marks, "CAD");
    expect(units).toBe(10_449n);
    expect(98725n * units >= 100150n * 10_300n).toBe(true);
    expect(98725n * (units - 1n) < 100150n * 10_300n).toBe(true);
    expect(() => substitutionUnits({ bond: "BOND-A", units: 1n }, "BOND-A", marks, "CAD")).toThrow(/one bond for another/);
    expect(() => substitutionUnits({ bond: "BOND-A", units: 1n }, "BOND-C", marks, "CAD")).toThrow(/No mark/);
  });

  it("moves collateral between bonds, never below zero", () => {
    expect(moveCollateral(held, "BOND-B", 5n)).toEqual([{ bond: "BOND-A", units: 10_300n }, { bond: "BOND-B", units: 5n }]);
    expect(moveCollateral(held, "BOND-A", -10_300n)).toEqual([]);
    expect(() => moveCollateral(held, "BOND-A", -10_301n)).toThrow(/holds 10300/);
  });
});

describe("repo postings", () => {
  const positive = fc.bigInt({ min: 1n, max: 10n ** 15n }).map((m) => money("CAD", m));
  const nonNegative = fc.bigInt({ min: 0n, max: 10n ** 12n }).map((m) => money("CAD", m));

  it("every template balances", () => {
    fc.assert(
      fc.property(positive, positive, nonNegative, (face, cash, interest) => {
        for (const lines of [
          repoPostings.receive("BOND-A", face),
          repoPostings.giveBack("BOND-A", face),
          repoPostings.pledge("BOND-A", face),
          repoPostings.recover("BOND-A", face),
          repoPostings.lend(cash),
          repoPostings.borrow(cash),
          repoPostings.repaid(cash, interest),
          repoPostings.repay(cash, interest),
          repoPostings.manufacture(cash),
          repoPostings.manufactured(cash),
        ]) {
          expect(() => assertBalanced(lines)).not.toThrow();
        }
      }),
    );
  });
});
