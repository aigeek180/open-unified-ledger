import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AccountSpec,
  assertBalanced,
  bankChart,
  centralBankChart,
  type CurrencyCode,
  type Line,
  parseDecimal,
  parseMoney,
} from "@oul/domain";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type AccountsFile,
  accountsFile,
  type BondTerms,
  type FxSpec,
  type InteropSpec,
  type ParticipantKind,
  type RepoSpec,
  type ScenarioFile,
  scenarioFile,
} from "./schema.ts";
import { buildOperators, DEFAULT_OPERATORS, type OperatorsFile, operatorsFile, type ParticipantOperators } from "./operators.ts";

export interface Participant {
  readonly id: string;
  readonly name: string;
  readonly kind: ParticipantKind;
  readonly validator: boolean;
  readonly agent?: string;
  /** A central bank's currency. */
  readonly currency?: CurrencyCode;
  /** The currencies a bank holds reserves in; empty for anyone else. */
  readonly reserves: readonly CurrencyCode[];
}

/** A wholesale or deposit token: the participant whose liability it is, and its currency. */
export interface CashToken {
  readonly symbol: string;
  readonly issuer: string;
  readonly currency: CurrencyCode;
}

/** A bond's terms and the currency it is issued and paid in. */
export type ScenarioBond = BondTerms & { readonly currency: CurrencyCode };

/** The books one participant keeps: its chart and its opening entry. */
export interface ParticipantLedger {
  readonly participant: string;
  readonly chart: readonly AccountSpec[];
  /** Empty, or a balanced entry over postable, non-mirrored accounts. */
  readonly opening: readonly Line[];
  readonly customers: readonly { id: string; name: string }[];
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  /** One, or two for cross-border payment versus payment (SPEC.md §13), in the order the scenario lists them. */
  readonly currencies: readonly CurrencyCode[];
  readonly timeZone: string;
  /** ISO 3166-1 numeric: the country a bond holder's identity records (ERC-3643). */
  readonly country?: number;
  readonly calendar: ScenarioFile["calendar"];
  readonly participants: readonly Participant[];
  readonly instruments: {
    /** One per currency, issued by that currency's central bank. */
    readonly wholesale: readonly CashToken[];
    readonly deposits: readonly CashToken[];
    readonly bonds: readonly ScenarioBond[];
  };
  /** One per central bank and bank; issuers keep no books here. */
  readonly ledgers: readonly ParticipantLedger[];
  /** Interop mode's second ledger (SPEC.md §7), if the scenario has one. */
  readonly interop?: InteropSpec;
  /** The dealer and its FX rates, in a scenario of two currencies (SPEC.md §13). */
  readonly fx?: FxSpec;
  /** Client custody (SPEC.md §15): each custodian bank and the customers it holds bonds for. */
  readonly custody: readonly { readonly bank: string; readonly clients: readonly string[] }[];
  /** Repo between the scenario's banks (SPEC.md §5.7–§5.10): its conventions, if the scenario has repo. */
  readonly repo?: RepoSpec;
  /** Each central bank's and bank's operators and policy (SPEC.md §15), from `operators.yaml`. */
  readonly operators: Readonly<Record<string, ParticipantOperators>>;
}

export class ScenarioError extends Error {
  override readonly name = "ScenarioError";
  readonly directory: string;
  readonly issues: readonly string[];
  constructor(directory: string, issues: readonly string[]) {
    super(`Scenario ${directory} is invalid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.directory = directory;
    this.issues = issues;
  }
}

/** QBFT tolerates f faulty validators out of 3f + 1; one fault needs four. */
const MIN_VALIDATORS = 4;

async function readYaml(file: string): Promise<unknown> {
  return parseYaml(await readFile(file, "utf8"));
}

function zodIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
}

export async function loadScenario(directory: string): Promise<Scenario> {
  const dir = path.resolve(directory);
  const parsedScenario = scenarioFile.safeParse(await readYaml(path.join(dir, "scenario.yaml")));
  const parsedAccounts = accountsFile.safeParse(await readYaml(path.join(dir, "accounts.yaml")));
  // Operators are optional: without the file, each participant has one operator holding every role.
  const operatorsPath = path.join(dir, "operators.yaml");
  const hasOperators = await access(operatorsPath).then(
    () => true,
    () => false,
  );
  const parsedOperators = hasOperators ? operatorsFile.safeParse(await readYaml(operatorsPath)) : { success: true as const, data: {} };

  const issues: string[] = [];
  if (!parsedScenario.success) issues.push(...zodIssues("scenario.yaml", parsedScenario.error));
  if (!parsedAccounts.success) issues.push(...zodIssues("accounts.yaml", parsedAccounts.error));
  if (!parsedOperators.success) issues.push(...zodIssues("operators.yaml", parsedOperators.error));
  if (!parsedScenario.success || !parsedAccounts.success || !parsedOperators.success) {
    throw new ScenarioError(dir, issues);
  }

  const scenario = buildScenario(dir, parsedScenario.data, parsedAccounts.data, parsedOperators.data, issues);
  if (issues.length > 0) {
    throw new ScenarioError(dir, issues);
  }
  return scenario;
}

function buildScenario(
  directory: string,
  file: ScenarioFile,
  accounts: AccountsFile,
  operatorsRaw: OperatorsFile,
  issues: string[],
): Scenario {
  const participants: Participant[] = file.participants.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    validator: p.validator,
    ...(p.agent ? { agent: p.agent } : {}),
    ...(p.currency ? { currency: p.currency } : {}),
    reserves: p.reserves ?? [],
  }));
  const byId = new Map<string, Participant>();
  for (const p of participants) {
    if (byId.has(p.id)) issues.push(`scenario.yaml: participant "${p.id}" appears twice`);
    byId.set(p.id, p);
  }
  const ofKind = (kind: ParticipantKind) => participants.filter((p) => p.kind === kind);
  const isKind = (participantId: string, kind: ParticipantKind) =>
    byId.get(participantId)?.kind === kind;

  // Currencies: each has its own central bank, and every bank says which it holds reserves in.
  const currencies = file.currencies;
  if (new Set(currencies).size !== currencies.length) issues.push("scenario.yaml: currencies lists a currency twice");
  const centralBanks = ofKind("central-bank");
  const banks = ofKind("bank");
  for (const cb of centralBanks) {
    if (!cb.currency) issues.push(`scenario.yaml: central bank "${cb.id}" needs its currency`);
    else if (!currencies.includes(cb.currency)) {
      issues.push(`scenario.yaml: central bank "${cb.id}" issues ${cb.currency}, which is not one of the scenario's currencies`);
    }
    if (cb.reserves.length > 0) issues.push(`scenario.yaml: central bank "${cb.id}" holds no reserves`);
  }
  for (const code of currencies) {
    const issuing = centralBanks.filter((cb) => cb.currency === code);
    if (issuing.length !== 1) {
      issues.push(`scenario.yaml: ${code} needs exactly one central bank, found ${issuing.length}`);
    }
    if (!banks.some((b) => b.reserves.includes(code))) {
      issues.push(`scenario.yaml: no bank holds reserves in ${code}`);
    }
  }
  if (banks.length < 2) {
    issues.push(`scenario.yaml: needs at least two banks, found ${banks.length}`);
  }
  for (const bank of banks) {
    if (bank.currency) issues.push(`scenario.yaml: bank "${bank.id}" names the currencies it holds reserves in, not a currency`);
    if (bank.reserves.length === 0) issues.push(`scenario.yaml: bank "${bank.id}" needs the currencies it holds reserves in`);
    if (new Set(bank.reserves).size !== bank.reserves.length) issues.push(`scenario.yaml: bank "${bank.id}" lists a reserve currency twice`);
    for (const code of bank.reserves) {
      if (!currencies.includes(code)) issues.push(`scenario.yaml: bank "${bank.id}" holds reserves in ${code}, which is not one of the scenario's currencies`);
    }
  }
  const validators = participants.filter((p) => p.validator);
  if (validators.length < MIN_VALIDATORS) {
    issues.push(
      `scenario.yaml: needs at least ${MIN_VALIDATORS} validators for QBFT to tolerate one fault, found ${validators.length}`,
    );
  }
  for (const p of participants) {
    if (p.kind === "issuer") {
      if (p.validator) issues.push(`scenario.yaml: issuer "${p.id}" cannot be a validator`);
      if (!p.agent || !isKind(p.agent, "bank")) {
        issues.push(`scenario.yaml: issuer "${p.id}" needs a bank as its agent`);
      }
      if (p.currency || p.reserves.length > 0) issues.push(`scenario.yaml: issuer "${p.id}" has no currency or reserves of its own`);
    } else if (p.agent) {
      issues.push(`scenario.yaml: only an issuer has an agent; "${p.id}" is a ${p.kind}`);
    }
  }

  // Instruments.
  const { wholesale, deposits } = file.instruments;
  for (const code of currencies) {
    const tokens = wholesale.filter((w) => w.currency === code);
    if (tokens.length !== 1) issues.push(`scenario.yaml: ${code} needs exactly one wholesale token, found ${tokens.length}`);
  }
  for (const token of wholesale) {
    const issuer = byId.get(token.issuer);
    if (issuer?.kind !== "central-bank") {
      issues.push(`scenario.yaml: wholesale token ${token.symbol} must be issued by a central bank`);
    } else if (issuer.currency !== token.currency) {
      issues.push(`scenario.yaml: wholesale token ${token.symbol} is in ${token.currency}, but its issuer "${issuer.id}" issues ${issuer.currency}`);
    }
  }
  const symbols = [...wholesale.map((w) => w.symbol), ...deposits.map((d) => d.symbol), ...file.instruments.bonds.map((b) => b.symbol)];
  for (const symbol of new Set(symbols)) {
    if (symbols.filter((s) => s === symbol).length > 1) {
      issues.push(`scenario.yaml: token symbol ${symbol} is used twice`);
    }
  }
  for (const bank of banks) {
    const issued = deposits.filter((d) => d.issuer === bank.id);
    if (issued.length !== 1) {
      issues.push(`scenario.yaml: bank "${bank.id}" must issue exactly one deposit token, found ${issued.length}`);
    }
  }
  for (const deposit of deposits) {
    const issuer = byId.get(deposit.issuer);
    if (issuer?.kind !== "bank") {
      issues.push(`scenario.yaml: deposit token ${deposit.symbol} must be issued by a bank`);
    } else if (!issuer.reserves.includes(deposit.currency)) {
      // Its deposits move between banks in that currency's wholesale tokens.
      issues.push(`scenario.yaml: deposit token ${deposit.symbol} is in ${deposit.currency}, so its issuer "${issuer.id}" must hold reserves in ${deposit.currency}`);
    }
  }

  // Bonds settle in a one-currency scenario, in that currency.
  const bonds: ScenarioBond[] = file.instruments.bonds.map((b) => ({ ...b, currency: currencies[0]! }));
  if (bonds.length > 0 && currencies.length > 1) {
    issues.push("scenario.yaml: bonds settle in a scenario of one currency");
  }
  if (bonds.length > 0 && file.country === undefined) {
    issues.push("scenario.yaml: a scenario with bonds names its country (ISO 3166-1 numeric), which each holder's identity records");
  }
  for (const bond of bonds) {
    const where = `scenario.yaml: bond ${bond.symbol}`;
    if (!isKind(bond.issuer, "issuer")) issues.push(`${where}: issuer must be an issuer participant`);
    if (!isKind(bond.agent, "bank")) issues.push(`${where}: agent must be a bank`);
    if (bond.maturityDate <= bond.issueDate) issues.push(`${where}: matures on or before issue`);
    try {
      if (parseMoney(bond.currency, bond.face).minor <= 0n) issues.push(`${where}: face must be positive`);
    } catch (error) {
      issues.push(`${where}: face: ${(error as Error).message}`);
    }
    const rate = parseDecimal(bond.couponRate);
    if (rate.isNegative() || rate.greaterThanOrEqualTo(1)) {
      issues.push(`${where}: couponRate is an annual fraction in [0, 1), e.g. "0.0325"`);
    }
    if ((bond.couponRate.split(".")[1] ?? "").length > 18) {
      issues.push(`${where}: couponRate has at most 18 decimal places (the contract's scale)`);
    }
  }

  // Interop mode's second ledger.
  if (file.interop) {
    const where = "scenario.yaml: interop";
    for (const v of file.interop.validators) {
      if (!isKind(v, "bank") && !isKind(v, "central-bank")) issues.push(`${where}: validator "${v}" must be a bank or a central bank`);
    }
    for (const symbol of file.interop.deposits) {
      if (!deposits.some((d) => d.symbol === symbol)) issues.push(`${where}: ${symbol} is not one of the scenario's deposit tokens`);
    }
    for (const symbol of file.interop.wholesale) {
      if (!wholesale.some((w) => w.symbol === symbol)) issues.push(`${where}: ${symbol} is not one of the scenario's wholesale tokens`);
    }
    if (currencies.length > 1) {
      // Across currencies, ledger 2 carries one currency whole: its wholesale token and its deposits.
      const there = file.interop.wholesale.map((symbol) => wholesale.find((w) => w.symbol === symbol)?.currency);
      if (there.length !== 1) issues.push(`${where}: a scenario of two currencies puts one currency's wholesale token on ledger 2`);
      for (const symbol of file.interop.deposits) {
        const currency = deposits.find((d) => d.symbol === symbol)?.currency;
        if (currency && !there.includes(currency)) issues.push(`${where}: ${symbol} is in ${currency}, not ledger 2's currency`);
      }
      if (!file.fx) issues.push(`${where}: a payment across currencies on two ledgers needs the scenario's fx dealer`);
    } else if (file.interop.wholesale.length > 0) {
      issues.push(`${where}: in a scenario of one currency, wholesale stays on the shared ledger`);
    }
    if (byId.has(file.interop.notary.id)) issues.push(`${where}: notary id "${file.interop.notary.id}" is already a participant`);
  }

  // The dealer quotes between currencies it holds reserves in both of.
  if (file.fx) {
    const where = "scenario.yaml: fx";
    const dealer = byId.get(file.fx.dealer);
    if (currencies.length < 2) issues.push(`${where}: a scenario of one currency has nothing to exchange`);
    if (dealer?.kind !== "bank") issues.push(`${where}: dealer "${file.fx.dealer}" must be a bank`);
    const pairs = new Set<string>();
    for (const { from, to } of file.fx.rates) {
      const pair = `${from}/${to}`;
      if (from === to) issues.push(`${where}: rate ${pair} exchanges a currency for itself`);
      if (pairs.has(pair)) issues.push(`${where}: rate ${pair} appears twice`);
      pairs.add(pair);
      for (const code of [from, to]) {
        if (!currencies.includes(code)) issues.push(`${where}: rate ${pair} names ${code}, which is not one of the scenario's currencies`);
        else if (dealer?.kind === "bank" && !dealer.reserves.includes(code)) {
          issues.push(`${where}: the dealer holds no reserves in ${code}, so it cannot quote ${pair}`);
        }
      }
    }
  }

  // Books: a central bank keeps them in its currency, with an account for each bank holding reserves in it;
  // a bank keeps them in its deposits' currency, with reserve accounts in each currency it holds reserves in.
  for (const key of Object.keys(accounts)) {
    const p = byId.get(key);
    if (!p) issues.push(`accounts.yaml: "${key}" is not a participant`);
    else if (p.kind === "issuer") issues.push(`accounts.yaml: issuer "${key}" keeps no books here`);
  }
  const ledgers: ParticipantLedger[] = [];
  for (const p of [...centralBanks, ...banks]) {
    const entry = accounts[p.id] ?? { customers: [], opening: [] };
    if (p.kind === "central-bank" && entry.customers.length > 0) {
      issues.push(`accounts.yaml: central bank "${p.id}" has no customers`);
    }
    // Books are kept in a currency the checks above have already asked for; without one there are none.
    const home = p.kind === "central-bank" ? p.currency : deposits.find((d) => d.issuer === p.id)?.currency;
    if (!home) continue;
    const clients = file.custody.find((c) => c.bank === p.id)?.clients ?? [];
    const chart =
      p.kind === "central-bank"
        ? centralBankChart(home, banks.filter((b) => b.reserves.includes(home)))
        : bankChart(
            home,
            p.reserves,
            entry.customers,
            bonds.map((b) => b.symbol),
            entry.customers.filter((c) => clients.includes(c.id)),
            file.repo !== undefined,
          );
    ledgers.push({
      participant: p.id,
      chart,
      opening: openingEntry(p.id, chart, entry.opening, issues),
      customers: entry.customers,
    });
  }
  // Client custody: a bank holding bonds for its own customers, in a scenario that has bonds.
  for (const [index, c] of file.custody.entries()) {
    const where = `scenario.yaml: custody[${index}]`;
    if (!isKind(c.bank, "bank")) issues.push(`${where}: "${c.bank}" is not a bank`);
    if (bonds.length === 0) issues.push(`${where}: custody holds bonds, and the scenario has none`);
    if (bonds.some((b) => b.agent === c.bank)) issues.push(`${where}: "${c.bank}" pays a bond, so it cannot hold it for clients`);
    if (file.custody.filter((x) => x.bank === c.bank).length > 1) issues.push(`${where}: "${c.bank}" is listed twice`);
    const customers = accounts[c.bank]?.customers ?? [];
    for (const client of c.clients) {
      if (!customers.some((x) => x.id === client)) issues.push(`${where}: "${client}" is not a customer of ${c.bank}`);
    }
  }
  // Repo: against the scenario's own bonds, in its one currency.
  if (file.repo) {
    const where = "scenario.yaml: repo";
    if (bonds.length === 0) issues.push(`${where}: a repo is secured on bonds, and the scenario has none`);
    for (const symbol of file.repo.collateral) {
      if (!bonds.some((b) => b.symbol === symbol)) issues.push(`${where}: collateral ${symbol} is not one of the scenario's bonds`);
    }
    if (new Set(file.repo.collateral).size !== file.repo.collateral.length) issues.push(`${where}: collateral lists a bond twice`);
    const agents = new Set(bonds.filter((b) => file.repo!.collateral.includes(b.symbol)).map((b) => b.agent));
    if (banks.filter((b) => !agents.has(b.id)).length < 2) {
      issues.push(`${where}: needs two banks that are not a collateral bond's paying agent, to lend and to borrow`);
    }
  }
  for (const issuer of ofKind("issuer")) {
    const agentBooks = ledgers.find((l) => l.participant === issuer.agent);
    if (agentBooks && !agentBooks.customers.some((c) => c.id === issuer.id)) {
      issues.push(
        `accounts.yaml: issuer "${issuer.id}" must be a customer of its agent "${issuer.agent}"`,
      );
    }
  }

  // Operators: every central bank and bank has its own, and no one else keeps any.
  const operators: Record<string, ParticipantOperators> = {};
  for (const key of Object.keys(operatorsRaw)) {
    const p = byId.get(key);
    if (!p) issues.push(`operators.yaml: "${key}" is not a participant`);
    else if (p.kind === "issuer") issues.push(`operators.yaml: issuer "${key}" acts through its agent and has no operators`);
  }
  for (const p of [...centralBanks, ...banks]) {
    const raw = operatorsRaw[p.id];
    operators[p.id] = raw ? buildOperators(p.id, raw, currencies, issues) : DEFAULT_OPERATORS;
  }

  return {
    id: file.id,
    name: file.name,
    directory,
    currencies,
    timeZone: file.timeZone,
    ...(file.country !== undefined ? { country: file.country } : {}),
    calendar: file.calendar,
    participants,
    instruments: { wholesale, deposits, bonds },
    ledgers,
    ...(file.interop ? { interop: file.interop } : {}),
    ...(file.fx ? { fx: file.fx } : {}),
    custody: file.custody,
    ...(file.repo ? { repo: file.repo } : {}),
    operators,
  };
}

function openingEntry(
  participant: string,
  chart: readonly AccountSpec[],
  raw: AccountsFile[string]["opening"],
  issues: string[],
): Line[] {
  const where = `accounts.yaml: ${participant}.opening`;
  const byCode = new Map(chart.map((a) => [a.code, a]));
  const lines: Line[] = [];
  for (const [index, item] of raw.entries()) {
    const side = "debit" in item ? "debit" : "credit";
    const code = "debit" in item ? item.debit : item.credit;
    const account = byCode.get(code);
    if (!account) {
      issues.push(`${where}[${index}]: no account "${code}"`);
      continue;
    }
    if (account.control) {
      issues.push(`${where}[${index}]: "${code}" is a control account and takes no postings`);
      continue;
    }
    if (account.mirrored) {
      // The shared ledger starts empty; tokens exist only through flows.
      issues.push(`${where}[${index}]: "${code}" mirrors an on-ledger balance and must open at zero`);
      continue;
    }
    try {
      lines.push({ account: code, side, amount: parseMoney(account.currency, item.amount) });
    } catch (error) {
      issues.push(`${where}[${index}]: ${(error as Error).message}`);
    }
  }
  if (lines.length > 0 && lines.length === raw.length) {
    try {
      assertBalanced(lines);
    } catch (error) {
      issues.push(`${where}: ${(error as Error).message}`);
    }
  }
  return lines;
}
