import { type CurrencyCode, parseMoney } from "@oul/domain";
import type { BondTerms } from "@oul/scenario";
import { type Hex, keccak256, toBytes } from "viem";

/**
 * A scenario bond's terms as the Bond contract stores them, and the hash that
 * commits to the canonical terms so anyone can check the chain against the
 * scenario.
 */

/** The contract's rate scale: 3.25% is 0.0325 × 10^18. */
export const RATE_SCALE_DIGITS = 18;

export const DAY_COUNT_CODE = { "ACT/365F": 0, "ACT/ACT-ICMA": 1, "30/360": 2 } as const;
export const COUPONS_PER_YEAR = { annual: 1, semiannual: 2, quarterly: 4 } as const;

/** An annual rate as a decimal string, scaled exactly; no floating point on the way. */
export function scaledRate(rate: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(rate);
  if (!match) throw new RangeError(`Not a plain decimal rate: "${rate}"`);
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > RATE_SCALE_DIGITS) {
    throw new RangeError(`A rate has at most ${RATE_SCALE_DIGITS} decimal places; "${rate}" has ${fraction.length}`);
  }
  return BigInt(whole + fraction.padEnd(RATE_SCALE_DIGITS, "0"));
}

/** 2026-11-02 → 20261102. */
export function dateNumber(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError(`Not a date: ${iso}`);
  return Number(iso.replaceAll("-", ""));
}

/** The canonical terms: fixed key order, decimal strings as written, the currency included. */
export function canonicalTerms(currency: CurrencyCode, bond: BondTerms): string {
  return JSON.stringify({
    symbol: bond.symbol,
    issuer: bond.issuer,
    agent: bond.agent,
    currency,
    face: bond.face,
    units: bond.units.toString(),
    couponRate: bond.couponRate,
    frequency: bond.frequency,
    dayCount: bond.dayCount,
    issueDate: bond.issueDate,
    maturityDate: bond.maturityDate,
    recordDays: bond.recordDays,
    rounding: bond.rounding,
  });
}

export function bondTermsHash(currency: CurrencyCode, bond: BondTerms): Hex {
  return keccak256(toBytes(canonicalTerms(currency, bond)));
}

/** The `Bond.Terms` struct for deployment. */
export function onChainTerms(currency: CurrencyCode, bond: BondTerms) {
  return {
    faceValue: parseMoney(currency, bond.face).minor,
    couponRate: scaledRate(bond.couponRate),
    frequency: COUPONS_PER_YEAR[bond.frequency],
    dayCount: DAY_COUNT_CODE[bond.dayCount],
    issueDate: dateNumber(bond.issueDate),
    maturityDate: dateNumber(bond.maturityDate),
    recordDays: bond.recordDays,
    termsHash: bondTermsHash(currency, bond),
  } as const;
}
