import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BondTerms,
  type BusinessCalendar,
  couponPayment,
  couponSchedule,
  daysBetween,
  formatMoney,
  isBusinessDay,
  parseMoney,
  principal,
  weekdayNumbers,
  yearFraction,
} from "../src/index.ts";

const calendar: BusinessCalendar = {
  weekendDays: weekdayNumbers(["saturday", "sunday"]),
  holidays: ["2026-12-25", "2027-01-01", "2027-05-24", "2027-11-11"],
};

/** The ca-bond-dvp bond. */
const bond: BondTerms = {
  face: parseMoney("CAD", "1000.00"),
  couponRate: "0.0325",
  frequency: "semiannual",
  dayCount: "ACT/365F",
  issueDate: "2026-11-02",
  maturityDate: "2031-11-02",
  recordDays: 1,
  rounding: "half-even",
};

describe("coupon schedule", () => {
  it("rolls back from maturity, with payments on business days", () => {
    const schedule = couponSchedule(bond, calendar);
    expect(schedule).toHaveLength(10);
    expect(schedule[0]).toMatchObject({ number: 1, start: "2026-11-02", end: "2027-05-02", paymentDate: "2027-05-03" });
    // 2 November 2031 is a Sunday: the final payment rolls to Monday.
    expect(schedule.at(-1)).toMatchObject({ end: "2031-11-02", paymentDate: "2031-11-03", final: true });
    for (const [i, period] of schedule.entries()) {
      if (i > 0) expect(period.start).toBe(schedule[i - 1]!.end);
      expect(isBusinessDay(period.paymentDate, calendar)).toBe(true);
      expect(isBusinessDay(period.recordDate, calendar)).toBe(true);
      expect(daysBetween(period.recordDate, period.paymentDate)).toBeGreaterThan(0);
    }
  });

  it("starts with a short first period when issue is off-cycle", () => {
    const schedule = couponSchedule({ ...bond, issueDate: "2027-01-15" }, calendar);
    expect(schedule[0]).toMatchObject({ start: "2027-01-15", end: "2027-05-02" });
    expect(schedule[1]).toMatchObject({ start: "2027-05-02", end: "2027-11-02" });
  });

  it("gives a regular period exactly one period's share of a year under 30/360 and ACT/ACT-ICMA", () => {
    const period = { start: "2027-05-02", end: "2027-11-02" };
    expect(yearFraction({ ...bond, dayCount: "30/360" }, period).toString()).toBe("0.5");
    expect(yearFraction({ ...bond, dayCount: "ACT/ACT-ICMA" }, period).toString()).toBe("0.5");
    expect(yearFraction(bond, period).toFixed(6)).toBe((184 / 365).toFixed(6));
  });
});

describe("coupon payments", () => {
  it("pays each holder its rounded share and leaves the rounding residual visible", () => {
    const [first] = couponSchedule(bond, calendar);
    // 181 days: 1,000.00 × 3.25% × 181/365 = 16.11643835616… per unit.
    const payment = couponPayment(bond, first!, [
      { holder: "bank-a", units: 60000n },
      { holder: "bank-b", units: 40000n },
    ]);
    expect(payment.payments.map((p) => formatMoney(p.amount))).toEqual(["966986.30", "644657.53"]);
    expect(formatMoney(payment.issuerDebit)).toBe("1611643.84");
    expect(formatMoney(payment.residual)).toBe("0.01");
  });

  it("satisfies invariant 8: paid plus residual equals the issuer's debit, to the minor unit", () => {
    const schedule = couponSchedule(bond, calendar);
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 12 }),
        fc.nat({ max: schedule.length - 1 }),
        fc.constantFrom("half-even" as const, "half-up" as const, "down" as const, "up" as const),
        fc.constantFrom("ACT/365F" as const, "ACT/ACT-ICMA" as const, "30/360" as const),
        (units, index, rounding, dayCount) => {
          const terms = { ...bond, rounding, dayCount };
          const payment = couponPayment(
            terms,
            schedule[index]!,
            units.map((u, i) => ({ holder: `h${i}`, units: u })),
          );
          const paid = payment.payments.reduce((total, p) => total + p.amount.minor, 0n);
          expect(paid + payment.residual.minor).toBe(payment.issuerDebit.minor);
          // Each holder's rounding moves the total by less than one minor unit.
          const holders = BigInt(payment.payments.length);
          const bound = rounding === "half-even" || rounding === "half-up" ? holders : holders + 1n;
          expect(payment.residual.minor <= bound && payment.residual.minor >= -bound).toBe(true);
          if (rounding === "down") expect(payment.residual.minor >= 0n).toBe(true);
          if (rounding === "up") expect(payment.residual.minor <= 0n).toBe(true);
        },
      ),
    );
  });

  it("repays face per unit exactly at maturity", () => {
    expect(formatMoney(principal(bond, 60000n))).toBe("60000000.00");
  });
});
