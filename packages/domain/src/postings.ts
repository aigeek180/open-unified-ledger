import { credit, debit, type Line } from "./accounting.ts";
import { bankAccounts as bank, centralBankAccounts as cb } from "./chart.ts";
import { type Money, money, sum } from "./money.ts";

/**
 * What each participant posts for each flow in SPEC.md §5. Every function
 * returns one participant's balanced lines; the on-ledger legs and the other
 * participants' lines are built from the same inputs, so they agree by
 * construction.
 */

/** §5.1 A bank moves reserves from its RTGS account into wholesale tokens. */
export const fundWholesale = {
  bank: (amount: Money): Line[] => [
    debit(bank.wholesaleReserves(amount.currency), amount),
    credit(bank.rtgsReserves(amount.currency), amount),
  ],
  centralBank: (bankId: string, amount: Money): Line[] => [
    debit(cb.settlementAccount(bankId), amount),
    credit(cb.wholesaleLine(bankId), amount),
  ],
};

/** §5.1 reversed: wholesale tokens back into the RTGS account. */
export const redeemWholesale = {
  bank: (amount: Money): Line[] => [
    debit(bank.rtgsReserves(amount.currency), amount),
    credit(bank.wholesaleReserves(amount.currency), amount),
  ],
  centralBank: (bankId: string, amount: Money): Line[] => [
    debit(cb.wholesaleLine(bankId), amount),
    credit(cb.settlementAccount(bankId), amount),
  ],
};

/**
 * §5.2 A customer tokenizes part of a deposit. Value moves between two
 * liability accounts; the bank's total deposits do not change.
 */
export function tokenizeDeposit(customer: string, amount: Money): Line[] {
  return [
    debit(bank.customerDeposit(customer), amount),
    credit(bank.tokenizedDeposit(customer), amount),
  ];
}

export function detokenizeDeposit(customer: string, amount: Money): Line[] {
  return [
    debit(bank.tokenizedDeposit(customer), amount),
    credit(bank.customerDeposit(customer), amount),
  ];
}

/**
 * §5.3 Interbank transfer: the payer's deposit token is burned, wholesale
 * tokens move from the payer's bank to the payee's, and the payee's deposit
 * token is minted, in one on-ledger instruction.
 */
export const interbankTransfer = {
  payerBank: (payer: string, amount: Money): Line[] => [
    debit(bank.tokenizedDeposit(payer), amount),
    credit(bank.wholesaleReserves(amount.currency), amount),
  ],
  payeeBank: (payee: string, amount: Money): Line[] => [
    debit(bank.wholesaleReserves(amount.currency), amount),
    credit(bank.tokenizedDeposit(payee), amount),
  ],
  centralBank: (fromBank: string, toBank: string, amount: Money): Line[] => [
    debit(cb.wholesaleLine(fromBank), amount),
    credit(cb.wholesaleLine(toBank), amount),
  ],
};

/**
 * §13 A payment across currencies, payment versus payment, in one
 * instruction: the payer's deposit burned and its bank's wholesale moved to
 * the dealer in the source currency; the dealer's wholesale moved to the
 * payee's bank and the payee's deposit minted in the target currency. The
 * payer's and payee's banks book as for an interbank transfer, each in its
 * own currency. The dealer books the exchange against its FX position in
 * each currency, so each currency balances apart (invariant 1); revaluing
 * the open position is the dealer's own business.
 */
export const fxPayment = {
  payerBank: (payer: string, source: Money): Line[] => interbankTransfer.payerBank(payer, source),
  dealer: (source: Money, target: Money): Line[] => [
    debit(bank.wholesaleReserves(source.currency), source),
    credit(bank.fxPosition(source.currency), source),
    debit(bank.fxPosition(target.currency), target),
    credit(bank.wholesaleReserves(target.currency), target),
  ],
  payeeBank: (payee: string, target: Money): Line[] => interbankTransfer.payeeBank(payee, target),
};

/** A line for `amount` on the side its sign says (positive: `positive` side), or none when zero. */
function signed(account: string, amount: Money, positive: "debit" | "credit"): Line[] {
  if (amount.minor === 0n) return [];
  const abs = money(amount.currency, amount.minor < 0n ? -amount.minor : amount.minor);
  const side = amount.minor > 0n ? positive : positive === "debit" ? "credit" : "debit";
  return [side === "debit" ? debit(account, abs) : credit(account, abs)];
}

const minus = (a: Money, b: Money) => money(a.currency, a.minor - b.minor);

/**
 * §5.4–§5.6 Bonds. Holdings are carried at face value; what a bank pays or
 * receives above or below face is a gain or loss on securities at once (the
 * sandbox does not amortize premiums and discounts). The paying agent debits
 * the issuer's deposit for what the issuer owes and pays holders their
 * rounded shares; the difference is the rounding residual (invariant 8).
 */
export const bondPostings = {
  /** A bank acquires units, at issue or in a trade: holdings at face, paid in wholesale tokens. */
  buy: (symbol: string, faceValue: Money, consideration: Money): Line[] => [
    debit(bank.bondHolding(symbol), faceValue),
    credit(bank.wholesaleReserves(consideration.currency), consideration),
    ...signed(bank.securitiesGains, minus(faceValue, consideration), "credit"),
  ],
  /** A bank delivers units in a trade and receives wholesale tokens. */
  sell: (symbol: string, faceValue: Money, consideration: Money): Line[] => [
    debit(bank.wholesaleReserves(consideration.currency), consideration),
    credit(bank.bondHolding(symbol), faceValue),
    ...signed(bank.securitiesGains, minus(consideration, faceValue), "credit"),
  ],
  /** The issuing agent receives the proceeds of issue and credits the issuer's deposit. */
  agentIssue: (issuer: string, proceeds: Money): Line[] => [
    debit(bank.wholesaleReserves(proceeds.currency), proceeds),
    credit(bank.customerDeposit(issuer), proceeds),
  ],
  /** A holder receives a coupon. */
  receiveCoupon: (amount: Money): Line[] => [debit(bank.wholesaleReserves(amount.currency), amount), credit(bank.interestIncome, amount)],
  /** A holder's units are redeemed: principal back at face, plus the final coupon. */
  redeem: (symbol: string, principalAmount: Money, coupon: Money): Line[] => [
    debit(bank.wholesaleReserves(principalAmount.currency), money(principalAmount.currency, principalAmount.minor + coupon.minor)),
    credit(bank.bondHolding(symbol), principalAmount),
    ...signed(bank.interestIncome, coupon, "credit"),
  ],
  /**
   * The paying agent debits the issuer for what it owes and pays holders what
   * they are owed; the residual (owed minus paid) is the agent's to keep or cover.
   */
  agentPay: (issuer: string, issuerDebit: Money, paid: Money): Line[] => [
    debit(bank.customerDeposit(issuer), issuerDebit),
    credit(bank.wholesaleReserves(paid.currency), paid),
    ...signed(bank.roundingResidual, minus(issuerDebit, paid), "credit"),
  ],
};

/**
 * §15 Client custody. The custodian buys and sells bonds for its clients at
 * its omnibus address and keeps their positions off its balance sheet, as a
 * memorandum pair at face: the omnibus's units (mirroring the chain) against
 * each client's position. The cash is the client's: its deposit pays for a
 * purchase and receives a sale's proceeds, each coupon and the redemption.
 */
export const custodyPostings = {
  /** Units arrive at the omnibus for a client, paid from its deposit in wholesale tokens. */
  buy: (symbol: string, client: string, faceValue: Money, consideration: Money): Line[] => [
    debit(bank.custodyHolding(symbol), faceValue),
    credit(bank.custodyPosition(symbol, client), faceValue),
    debit(bank.customerDeposit(client), consideration),
    credit(bank.wholesaleReserves(consideration.currency), consideration),
  ],
  /** A client's units leave the omnibus; the proceeds go to its deposit. */
  sell: (symbol: string, client: string, faceValue: Money, consideration: Money): Line[] => [
    debit(bank.custodyPosition(symbol, client), faceValue),
    credit(bank.custodyHolding(symbol), faceValue),
    debit(bank.wholesaleReserves(consideration.currency), consideration),
    credit(bank.customerDeposit(client), consideration),
  ],
  /**
   * What the omnibus received (a coupon, or principal and the final coupon)
   * allocated to the clients by their positions at the record block, each
   * share rounded once; the residual (received minus allocated) is the
   * custodian's, shown, never dropped.
   */
  allocate: (received: Money, shares: readonly { client: string; amount: Money }[]): Line[] => {
    const allocated = sum(received.currency, shares.map((s) => s.amount));
    return [
      debit(bank.wholesaleReserves(received.currency), received),
      ...shares.filter((s) => s.amount.minor > 0n).map((s) => credit(bank.customerDeposit(s.client), s.amount)),
      ...signed(bank.roundingResidual, minus(received, allocated), "credit"),
    ];
  },
  /** At redemption the omnibus's units are cancelled, and with them each client's position. */
  cancel: (symbol: string, positions: readonly { client: string; faceValue: Money }[]): Line[] => {
    const total = positions.reduce((t, p) => t + p.faceValue.minor, 0n);
    if (total === 0n) return [];
    return [
      ...positions.filter((p) => p.faceValue.minor > 0n).map((p) => debit(bank.custodyPosition(symbol, p.client), p.faceValue)),
      credit(bank.custodyHolding(symbol), money(positions[0]!.faceValue.currency, total)),
    ];
  },
};

/**
 * §5.7–§5.10 Repo. Title to the collateral moves on chain, but the economics
 * stay with the borrower, so neither side treats it as a sale: the lender
 * books the cash it lent as a reverse-repo receivable and the units it holds
 * as a memorandum pair (collateral received, collateral to return); the
 * borrower books the cash as a repo liability, keeps the units in its bond
 * holdings, and records them as a memorandum pair (collateral pledged,
 * collateral to recover). Collateral is at face, like holdings, so each
 * side's units on chain are its holdings plus collateral received, minus
 * collateral pledged, at face (invariant 10).
 */
export const repoPostings = {
  /** The lender takes units of a bond as collateral. */
  receive: (symbol: string, faceValue: Money): Line[] => [
    debit(bank.collateralReceivedIn(symbol), faceValue),
    credit(bank.collateralToReturnIn(symbol), faceValue),
  ],
  /** The lender gives units back. */
  giveBack: (symbol: string, faceValue: Money): Line[] => [
    debit(bank.collateralToReturnIn(symbol), faceValue),
    credit(bank.collateralReceivedIn(symbol), faceValue),
  ],
  /** The borrower pledges units out of its holdings. */
  pledge: (symbol: string, faceValue: Money): Line[] => [
    debit(bank.collateralToRecoverIn(symbol), faceValue),
    credit(bank.collateralPledgedIn(symbol), faceValue),
  ],
  /** The borrower gets pledged units back. */
  recover: (symbol: string, faceValue: Money): Line[] => [
    debit(bank.collateralPledgedIn(symbol), faceValue),
    credit(bank.collateralToRecoverIn(symbol), faceValue),
  ],
  /** §5.7 The lender pays the purchase price. */
  lend: (cash: Money): Line[] => [debit(bank.reverseRepos, cash), credit(bank.wholesaleReserves(cash.currency), cash)],
  /** §5.7 The borrower receives it. */
  borrow: (cash: Money): Line[] => [debit(bank.wholesaleReserves(cash.currency), cash), credit(bank.repoBorrowings, cash)],
  /** §5.10 The lender is repaid the purchase price plus repo interest. */
  repaid: (cash: Money, interest: Money): Line[] => [
    debit(bank.wholesaleReserves(cash.currency), money(cash.currency, cash.minor + interest.minor)),
    credit(bank.reverseRepos, cash),
    ...signed(bank.interestIncome, interest, "credit"),
  ],
  /** §5.10 The borrower repays it. */
  repay: (cash: Money, interest: Money): Line[] => [
    debit(bank.repoBorrowings, cash),
    ...signed(bank.interestExpense, interest, "debit"),
    credit(bank.wholesaleReserves(cash.currency), money(cash.currency, cash.minor + interest.minor)),
  ],
  /** §5.10 The lender passes on a coupon it received on collateral: a manufactured payment. */
  manufacture: (amount: Money): Line[] => [debit(bank.manufacturedPayments, amount), credit(bank.wholesaleReserves(amount.currency), amount)],
  /** §5.10 The borrower receives it: the coupon on its own bonds. */
  manufactured: (amount: Money): Line[] => [debit(bank.wholesaleReserves(amount.currency), amount), credit(bank.interestIncome, amount)],
};
