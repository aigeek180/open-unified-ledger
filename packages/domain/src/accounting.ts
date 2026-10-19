import type { CurrencyCode } from "./currency.ts";
import { type Money, money } from "./money.ts";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type Side = "debit" | "credit";

export const ACCOUNT_TYPES: readonly AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** Assets and expenses grow on the debit side; the rest on the credit side. */
export function normalSide(type: AccountType): Side {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

/** One side of a journal entry. `amount` is always positive. */
export interface Line {
  readonly account: string;
  readonly side: Side;
  readonly amount: Money;
}

export function debit(account: string, amount: Money): Line {
  return { account, side: "debit", amount };
}

export function credit(account: string, amount: Money): Line {
  return { account, side: "credit", amount };
}

/** Debits positive, credits negative: a balanced entry sums to zero. */
export function signedMinor(line: Line): bigint {
  return line.side === "debit" ? line.amount.minor : -line.amount.minor;
}

/**
 * A balance in the account's own terms: positive when the account holds what
 * its type says it holds (an asset owned, a liability owed).
 */
export function normalBalance(
  type: AccountType,
  currency: CurrencyCode,
  debitsMinusCredits: bigint,
): Money {
  return money(
    currency,
    normalSide(type) === "debit" ? debitsMinusCredits : -debitsMinusCredits,
  );
}

export class UnbalancedEntryError extends Error {
  override readonly name = "UnbalancedEntryError";
}

/**
 * The rules every journal entry obeys before it reaches the database, which
 * enforces them again: at least two lines, every amount positive, and debits
 * equal to credits in each currency.
 */
export function assertBalanced(lines: readonly Line[]): void {
  if (lines.length < 2) {
    throw new UnbalancedEntryError("A journal entry needs at least two lines");
  }
  const totals = new Map<CurrencyCode, bigint>();
  for (const line of lines) {
    if (line.amount.minor <= 0n) {
      throw new UnbalancedEntryError(
        `Line amounts must be positive; ${line.account} has ${line.amount.minor}`,
      );
    }
    const currency = line.amount.currency;
    totals.set(currency, (totals.get(currency) ?? 0n) + signedMinor(line));
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) {
      const [larger, smaller] = total > 0n ? ["debits", "credits"] : ["credits", "debits"];
      const difference = total > 0n ? total : -total;
      throw new UnbalancedEntryError(
        `${larger} exceed ${smaller} by ${difference} minor units of ${currency}`,
      );
    }
  }
}
