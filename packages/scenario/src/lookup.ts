import type { CurrencyCode } from "@oul/domain";
import type { CashToken, Participant, Scenario } from "./load.ts";

/**
 * Who issues what, and in which currency, in a loaded scenario. The loader
 * has already checked that each answer exists and is unique, so a miss here
 * is a caller's mistake and throws.
 */

function participant(scenario: Scenario, id: string): Participant {
  const p = scenario.participants.find((x) => x.id === id);
  if (!p) throw new RangeError(`No participant "${id}" in ${scenario.id}`);
  return p;
}

/** Every central bank, in the order the scenario lists them. */
export function centralBanks(scenario: Scenario): Participant[] {
  return scenario.participants.filter((p) => p.kind === "central-bank");
}

/** The central bank that operates the shared ledger's registry: the first one listed. */
export function registryOperator(scenario: Scenario): Participant {
  const [first] = centralBanks(scenario);
  if (!first) throw new Error(`Scenario ${scenario.id} has no central bank`);
  return first;
}

/** The central bank of `currency`, which alone issues its wholesale token. */
export function centralBankFor(scenario: Scenario, currency: CurrencyCode): Participant {
  const cb = centralBanks(scenario).find((p) => p.currency === currency);
  if (!cb) throw new RangeError(`No central bank for ${currency} in ${scenario.id}`);
  return cb;
}

/** The wholesale token of `currency`. */
export function wholesaleFor(scenario: Scenario, currency: CurrencyCode): CashToken {
  const token = scenario.instruments.wholesale.find((w) => w.currency === currency);
  if (!token) throw new RangeError(`No wholesale token for ${currency} in ${scenario.id}`);
  return token;
}

/** The deposit token `bank` issues. */
export function depositOf(scenario: Scenario, bank: string): CashToken {
  const token = scenario.instruments.deposits.find((d) => d.issuer === bank);
  if (!token) throw new RangeError(`"${bank}" issues no deposit token in ${scenario.id}`);
  return token;
}

/** A cash token by symbol. */
export function cashToken(scenario: Scenario, symbol: string): CashToken | undefined {
  return [...scenario.instruments.wholesale, ...scenario.instruments.deposits].find((t) => t.symbol === symbol);
}

/**
 * The currency a participant keeps its own books in: a central bank's
 * currency, or the currency of a bank's deposits. A bank's reserves in any
 * other currency are its foreign-currency accounts.
 */
export function homeCurrency(scenario: Scenario, id: string): CurrencyCode {
  const p = participant(scenario, id);
  if (p.kind === "central-bank") return p.currency!;
  if (p.kind === "bank") return depositOf(scenario, id).currency;
  throw new RangeError(`"${id}" keeps no books in ${scenario.id}`);
}

/** Whether `bank` holds reserves in `currency`. */
export function holdsReserves(scenario: Scenario, bank: string, currency: CurrencyCode): boolean {
  return participant(scenario, bank).reserves.includes(currency);
}

/**
 * The currency of a one-currency scenario, for what settles in one currency
 * only: confidential mode (SPEC.md §1) and a scenario's bonds.
 */
export function soleCurrency(scenario: Scenario, what: string): CurrencyCode {
  const [only, ...more] = scenario.currencies;
  if (!only || more.length > 0) {
    throw new Error(`${what} runs on a scenario of one currency; ${scenario.id} has ${scenario.currencies.join(" and ")}`);
  }
  return only;
}

/** The scenario's FX dealer, if it has one (SPEC.md §13). */
export function dealerOf(scenario: Scenario): string | undefined {
  return scenario.fx?.dealer;
}

/** The rate the dealer quotes from one currency into another, as its decimal string. */
export function fxRate(scenario: Scenario, from: CurrencyCode, to: CurrencyCode): string | undefined {
  return scenario.fx?.rates.find((r) => r.from === from && r.to === to)?.rate;
}
