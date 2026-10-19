/**
 * ISO 4217 currencies the engine accepts, with their minor units. A cash
 * token's decimals equal its currency's minor unit, so one token unit is one
 * minor unit and on-ledger amounts equal core-ledger amounts exactly.
 *
 * The table holds the currencies central banks are testing tokenized money
 * in, plus a zero- and a three-decimal currency so the engine is exercised
 * on more than two decimals. Add a currency here, not in a scenario.
 */
const MINOR_UNITS = {
  AUD: 2,
  BHD: 3,
  CAD: 2,
  CHF: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  JPY: 0,
  KRW: 0,
  MXN: 2,
  SGD: 2,
  USD: 2,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof MINOR_UNITS;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(MINOR_UNITS, value);
}

export function currencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new RangeError(`Unsupported currency "${value}"`);
  }
  return value;
}

export function minorUnit(currency: CurrencyCode): number {
  return MINOR_UNITS[currency];
}

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNITS) as CurrencyCode[];
