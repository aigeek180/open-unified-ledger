import type { AccountType } from "./accounting.ts";
import type { CurrencyCode } from "./currency.ts";

/**
 * The charts of accounts every participant of a kind keeps. The flows in
 * SPEC.md §5 post only to these accounts, so a scenario names customers and
 * opening balances but never invents accounts.
 *
 * Every account has one currency. A bank keeps its books in its deposits'
 * currency and holds reserves in one or more currencies, so its reserve
 * accounts are named by currency (`wholesale-reserves/CAD`); a bank holding
 * reserves in more than one also keeps an FX position in each, against which
 * it exchanges one for another so every entry balances in each currency.
 */
export interface AccountSpec {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  /** A control account aggregates its children and takes no postings. */
  readonly control: boolean;
  /**
   * Its balance has an on-ledger counterpart the reconciler compares, so a
   * posted entry touching it must carry the block it settled in.
   */
  readonly mirrored: boolean;
  readonly parent?: string;
  /**
   * Off the balance sheet: what the bank holds for its clients in custody,
   * kept in its books as a memorandum pair that always balances (SPEC.md §15).
   */
  readonly memorandum?: boolean;
}

export const bankAccounts = {
  rtgsReserves: (currency: CurrencyCode) => `rtgs-reserves/${currency}`,
  wholesaleReserves: (currency: CurrencyCode) => `wholesale-reserves/${currency}`,
  fxPosition: (currency: CurrencyCode) => `fx-position/${currency}`,
  loansAndSecurities: "loans-and-securities",
  customerDeposits: "customer-deposits",
  tokenizedDeposits: "tokenized-deposits",
  interestExpense: "interest-expense",
  roundingResidual: "rounding-residual",
  equity: "equity",
  bondHoldings: "bond-holdings",
  interestIncome: "interest-income",
  securitiesGains: "securities-gains",
  customerDeposit: (customer: string) => `customer-deposits/${customer}`,
  tokenizedDeposit: (customer: string) => `tokenized-deposits/${customer}`,
  bondHolding: (symbol: string) => `bond-holdings/${symbol}`,
  custodyHoldings: "custody-holdings",
  custodyPositions: "custody-positions",
  /** Units of a bond held at the omnibus custody address, at face: mirrors the omnibus balance on chain. */
  custodyHolding: (symbol: string) => `custody-holdings/${symbol}`,
  /** One client's position in a bond held for it in custody, at face. */
  custodyPosition: (symbol: string, client: string) => `custody-positions/${symbol}/${client}`,
  reverseRepos: "reverse-repos",
  repoBorrowings: "repo-borrowings",
  manufacturedPayments: "manufactured-payments",
  collateralReceived: "collateral-received",
  collateralToReturn: "collateral-to-return",
  collateralPledged: "collateral-pledged",
  collateralToRecover: "collateral-to-recover",
  /**
   * A lender's units of a bond held as repo collateral, at face (SPEC.md §5.7):
   * at its own address with the units it owns, so its on-chain balance is
   * holdings plus collateral received, minus collateral pledged.
   */
  collateralReceivedIn: (symbol: string) => `collateral-received/${symbol}`,
  /** A lender's obligation to return the collateral it holds, at face. */
  collateralToReturnIn: (symbol: string) => `collateral-to-return/${symbol}`,
  /** A borrower's units of a bond pledged as repo collateral, still in its holdings, at face. */
  collateralPledgedIn: (symbol: string) => `collateral-pledged/${symbol}`,
  /** A borrower's claim to the return of the units it pledged, at face. */
  collateralToRecoverIn: (symbol: string) => `collateral-to-recover/${symbol}`,
} as const;

/**
 * The account whose balance an on-chain balance is mirrored into, for the
 * accounts that share one (SPEC.md §5.7): a bank's units of a bond at its own
 * address are its holding, plus the collateral it received, minus the
 * collateral it pledged, so `collateral-received/<bond>` and
 * `collateral-pledged/<bond>` mirror into `bond-holdings/<bond>`. Every other
 * account is its own.
 */
export function mirrorGroup(account: string): string {
  for (const prefix of [`${bankAccounts.collateralReceived}/`, `${bankAccounts.collateralPledged}/`]) {
    if (account.startsWith(prefix)) return bankAccounts.bondHolding(account.slice(prefix.length));
  }
  return account;
}

export const centralBankAccounts = {
  governmentSecurities: "government-securities",
  settlementAccounts: "settlement-accounts",
  wholesaleOutstanding: "wholesale-outstanding",
  equity: "equity",
  settlementAccount: (bank: string) => `settlement-accounts/${bank}`,
  wholesaleLine: (bank: string) => `wholesale-outstanding/${bank}`,
} as const;

type Spec = Omit<AccountSpec, "currency"> & { readonly currency?: CurrencyCode };

function leaf(code: string, name: string, type: AccountType, mirrored = false): Spec {
  return { code, name, type, control: false, mirrored };
}

function control(code: string, name: string, type: AccountType, mirrored = false): Spec {
  return { code, name, type, control: true, mirrored };
}

function child(parent: Spec, code: string, name: string): Spec {
  return {
    code,
    name,
    type: parent.type,
    control: false,
    mirrored: parent.mirrored,
    parent: parent.code,
    ...(parent.memorandum ? { memorandum: true } : {}),
  };
}

/**
 * @param currency The bank's own currency: its deposits, loans, equity and
 * bond holdings are in it.
 * @param reserves The currencies it holds reserves in, at each currency's
 * central bank: an RTGS and a wholesale account in each, and an FX position
 * in each when there is more than one.
 * @param bonds Symbols of the scenario's bonds. Every bank can hold every
 * bond; holdings are carried at face value, so they reconcile exactly with
 * the units on chain times face.
 * @param custodyClients The customers this bank holds bonds for in custody
 * (SPEC.md §15), if it is a custodian: off the balance sheet, the omnibus
 * address's units of each bond at face, and each client's position in it.
 * @param repo Whether the scenario's banks lend and borrow against its bonds
 * (SPEC.md §5.7–§5.10): the cash lent and borrowed, and, off the balance
 * sheet at face, the collateral received and pledged in each bond, each with
 * its counterpart (what is owed back, and what is to be recovered).
 */
export function bankChart(
  currency: CurrencyCode,
  reserves: readonly CurrencyCode[],
  customers: readonly { id: string; name: string }[],
  bonds: readonly string[] = [],
  custodyClients: readonly { id: string; name: string }[] = [],
  repo = false,
): AccountSpec[] {
  const a = bankAccounts;
  const inCurrency = (spec: Spec, code: CurrencyCode): Spec => ({ ...spec, currency: code });
  const deposits = control(a.customerDeposits, "Customer deposits", "liability");
  const tokenized = control(a.tokenizedDeposits, "Tokenized deposits", "liability", true);
  const holdings = control(a.bondHoldings, "Bond holdings at face value", "asset", true);
  const specs: Spec[] = [
    ...reserves.flatMap((code) => [
      inCurrency(leaf(a.rtgsReserves(code), `Reserves at the central bank (RTGS), ${code}`, "asset"), code),
      inCurrency(leaf(a.wholesaleReserves(code), `Tokenized wholesale reserves, ${code}`, "asset", true), code),
    ]),
    ...(reserves.length > 1
      ? reserves.map((code) => inCurrency(leaf(a.fxPosition(code), `FX position, ${code}`, "equity"), code))
      : []),
    leaf(a.loansAndSecurities, "Loans and securities", "asset"),
    holdings,
    deposits,
    tokenized,
    leaf(a.interestExpense, "Interest expense", "expense"),
    leaf(a.interestIncome, "Interest income", "income"),
    leaf(a.securitiesGains, "Gains and losses on securities", "income"),
    leaf(a.roundingResidual, "Rounding residual", "expense"),
    leaf(a.equity, "Equity", "equity"),
  ];
  for (const symbol of bonds) {
    specs.push(child(holdings, a.bondHolding(symbol), `Holding: ${symbol}`));
  }
  if (custodyClients.length > 0) {
    const held = { ...control(a.custodyHoldings, "Bonds held in custody at the omnibus address, at face", "asset", true), memorandum: true };
    const positions = { ...control(a.custodyPositions, "Clients' custody positions, at face", "liability"), memorandum: true };
    specs.push(held, positions);
    for (const symbol of bonds) {
      specs.push(child(held, a.custodyHolding(symbol), `Held in custody: ${symbol}`));
      for (const client of custodyClients) {
        specs.push(child(positions, a.custodyPosition(symbol, client.id), `Custody: ${client.name}, ${symbol}`));
      }
    }
  }
  if (repo) {
    specs.push(
      leaf(a.reverseRepos, "Reverse repos: cash lent against collateral", "asset"),
      leaf(a.repoBorrowings, "Repos: cash borrowed against collateral", "liability"),
      leaf(a.manufacturedPayments, "Manufactured payments on collateral received", "expense"),
    );
    // Title to the collateral moves on chain, the economics do not: each side keeps it off its balance sheet.
    const memo = (spec: Spec): Spec => ({ ...spec, memorandum: true });
    const received = memo(control(a.collateralReceived, "Repo collateral received, at face", "asset", true));
    const toReturn = memo(control(a.collateralToReturn, "Repo collateral to return, at face", "liability"));
    const pledged = memo(control(a.collateralPledged, "Repo collateral pledged out of holdings, at face", "liability", true));
    const toRecover = memo(control(a.collateralToRecover, "Repo collateral to recover, at face", "asset"));
    specs.push(received, toReturn, pledged, toRecover);
    for (const symbol of bonds) {
      specs.push(
        child(received, a.collateralReceivedIn(symbol), `Collateral received: ${symbol}`),
        child(toReturn, a.collateralToReturnIn(symbol), `Collateral to return: ${symbol}`),
        child(pledged, a.collateralPledgedIn(symbol), `Collateral pledged: ${symbol}`),
        child(toRecover, a.collateralToRecoverIn(symbol), `Collateral to recover: ${symbol}`),
      );
    }
  }
  for (const customer of customers) {
    specs.push(child(deposits, a.customerDeposit(customer.id), `Deposit: ${customer.name}`));
    specs.push(
      child(tokenized, a.tokenizedDeposit(customer.id), `Tokenized deposit: ${customer.name}`),
    );
  }
  return specs.map((spec) => ({ ...spec, currency: spec.currency ?? currency }));
}

export function centralBankChart(
  currency: CurrencyCode,
  banks: readonly { id: string; name: string }[],
): AccountSpec[] {
  const a = centralBankAccounts;
  const settlement = control(a.settlementAccounts, "Bank settlement accounts", "liability");
  const wholesale = control(a.wholesaleOutstanding, "Wholesale tokens outstanding", "liability", true);
  const specs: Spec[] = [
    leaf(a.governmentSecurities, "Government securities", "asset"),
    settlement,
    wholesale,
    leaf(a.equity, "Equity", "equity"),
  ];
  for (const bank of banks) {
    specs.push(child(settlement, a.settlementAccount(bank.id), `Settlement account: ${bank.name}`));
    specs.push(child(wholesale, a.wholesaleLine(bank.id), `Wholesale tokens: ${bank.name}`));
  }
  return specs.map((spec) => ({ ...spec, currency }));
}
