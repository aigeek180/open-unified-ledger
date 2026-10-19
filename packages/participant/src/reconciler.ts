import { contracts } from "@oul/chain";
import { bankAccounts, centralBankAccounts, type CurrencyCode, formatMoney, type Line, type Money, money, parseMoney } from "@oul/domain";
import { depositOf, wholesaleFor } from "@oul/scenario";
import { sql } from "drizzle-orm";
import type { Address } from "viem";
import type { RuntimeContext } from "./context.ts";
import { type BondFlow, bondInfo, flowValue, type FxFlow } from "./flows.ts";
import { targetFor, verifyQuote } from "./fx.ts";
import { allAudit, verifyAudit } from "./audit.ts";
import { custodyChecks } from "./custody.ts";
import { repoChecks } from "./repo.ts";
import { policyViolations } from "./policy.ts";
import { instructionsWithStatus } from "./store.ts";

const { WholesaleToken } = contracts;

export interface ReconciliationCheck {
  /** Which invariant (SPEC.md §6) the check belongs to. */
  readonly invariant: 2 | 3 | 8 | 10 | 11 | 12 | 13 | 14;
  readonly account: string;
  readonly books: string;
  readonly chain: string;
  readonly ok: boolean;
}

export interface Reconciliation {
  readonly block: bigint;
  readonly ok: boolean;
  readonly checks: readonly ReconciliationCheck[];
}

/**
 * Prove this participant's share of invariants 2 and 3 at `block`, in each
 * currency apart: every mirrored account, as posted up to that block, equals
 * the token balance it mirrors at that block.
 *   - Bank: its wholesale reserves in each currency it holds equal its
 *     balance of that currency's wholesale token (2); each customer's
 *     tokenized deposit equals the customer's token balance, and the
 *     tokenized-deposits total equals the token's supply (3).
 *   - Central bank: each bank's wholesale line equals the bank's balance of
 *     its wholesale token, and the outstanding total equals the supply (2).
 *   - Bank: each bond holding, plus collateral it received and less collateral
 *     it pledged in repos, at face, equals its units on chain times face (10).
 *   - Paying agent: every coupon and redemption it settled took from the
 *     issuer exactly what it paid holders plus the rounding residual (8).
 *   - Every party to a payment across currencies: what it booked in each
 *     currency is exactly what the dealer signed, and that is the source
 *     amount at the quoted rate, rounded once, half-even (11).
 *   - A custodian: its clients' positions sum, per bond, to its omnibus
 *     wallets' units on chain, and every coupon or redemption the omnibus
 *     received went to the clients by their positions at the record block,
 *     the residual shown (13).
 *   - A party to repos: each repo's record is what its instructions moved, its
 *     books' collateral equals its records', every margin left the repo covered
 *     at its marks after the haircut, and every close repaid exactly principal
 *     plus interest (14).
 *   - Its audit log: nothing was released or submitted before the approvals
 *     its policy required were recorded, and the log's hash chain verifies
 *     from its first entry (12).
 * A failed check is recorded and shown; nothing is corrected.
 */
export async function reconcile(rt: RuntimeContext, block: bigint): Promise<Reconciliation> {
  const checks: ReconciliationCheck[] = [];
  const read = (token: Address, functionName: "balanceOf" | "totalSupply", holder?: Address) =>
    rt.client.readContract({
      address: token,
      abi: WholesaleToken.abi,
      functionName,
      ...(holder ? { args: [holder] } : {}),
      blockNumber: block,
    } as never) as Promise<bigint>;
  const check = async (invariant: 2 | 3 | 10, account: string, onChain: Promise<bigint>, factor = 1n, booked?: Promise<Money>) => {
    const books = await (booked ?? rt.books.balanceAtBlock(account, block));
    const chain = (await onChain) * factor;
    checks.push({
      invariant,
      account,
      books: formatMoney(books),
      chain: formatMoney(money(books.currency, chain)),
      ok: books.minor === chain,
    });
  };

  const { scenario, deployment } = rt;
  const wholesale = (currency: CurrencyCode) => deployment.tokens[wholesaleFor(scenario, currency).symbol]!.address;
  if (rt.kind === "central-bank") {
    const token = wholesale(rt.currency);
    for (const bank of scenario.participants) {
      if (!bank.reserves.includes(rt.currency)) continue;
      const address = deployment.participants[bank.id]!.address;
      await check(2, centralBankAccounts.wholesaleLine(bank.id), read(token, "balanceOf", address));
    }
    await check(2, centralBankAccounts.wholesaleOutstanding, read(token, "totalSupply"));
  } else {
    const self = deployment.participants[rt.participant]!.address;
    for (const currency of rt.reserves) {
      await check(2, bankAccounts.wholesaleReserves(currency), read(wholesale(currency), "balanceOf", self));
    }
    const deposit = deployment.tokens[depositOf(scenario, rt.participant).symbol]!.address;
    for (const [ref, customer] of Object.entries(rt.deployment.customers)) {
      if (customer.bank !== rt.participant) continue;
      const customerId = ref.slice(rt.participant.length + 1);
      await check(3, bankAccounts.tokenizedDeposit(customerId), read(deposit, "balanceOf", customer.address));
    }
    await check(3, bankAccounts.tokenizedDeposits, read(deposit, "totalSupply"));
    for (const spec of rt.scenario.instruments.bonds) {
      const token = rt.deployment.tokens[spec.symbol];
      if (token?.kind !== "bond") continue;
      const face = parseMoney(spec.currency, spec.face).minor;
      // With repo, the units at its own address are its holding plus collateral received, less collateral pledged.
      const booked = rt.scenario.repo
        ? Promise.all([
            rt.books.balanceAtBlock(bankAccounts.bondHolding(spec.symbol), block),
            rt.books.balanceAtBlock(bankAccounts.collateralReceivedIn(spec.symbol), block),
            rt.books.balanceAtBlock(bankAccounts.collateralPledgedIn(spec.symbol), block),
          ]).then(([held, received, pledged]) => money(held.currency, held.minor + received.minor - pledged.minor))
        : undefined;
      await check(10, bankAccounts.bondHolding(spec.symbol), read(token.address, "balanceOf", self), face, booked);
    }
  }
  checks.push(...(await couponChecks(rt)));
  checks.push(...(await fxChecks(rt)));
  checks.push(...(await policyChecks(rt)));
  checks.push(...(await custodyChecks(rt, block)));
  checks.push(...(await allocationChecks(rt)));
  checks.push(...(await repoChecks(rt, block)));

  const ok = checks.every((c) => c.ok);
  await rt.books.database.execute(sql`
    INSERT INTO reconciliation_runs (block, ok, checks)
    VALUES (${block.toString()}::bigint, ${ok}, ${JSON.stringify(checks)}::jsonb)
    ON CONFLICT (block) DO NOTHING
  `);
  if (!ok) rt.log(`reconciliation break at block ${block}`);
  return { block, ok, checks };
}

export async function latestReconciliation(rt: RuntimeContext): Promise<Reconciliation | undefined> {
  const result = await rt.books.database.execute(sql`
    SELECT block::text AS block, ok, checks FROM reconciliation_runs ORDER BY reconciliation_runs.block DESC LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    block: BigInt(String(row["block"])),
    ok: Boolean(row["ok"]),
    checks: row["checks"] as ReconciliationCheck[],
  };
}

/** Invariant 8 over every coupon and redemption this participant settled as paying agent. */
async function couponChecks(rt: RuntimeContext): Promise<ReconciliationCheck[]> {
  const checks: ReconciliationCheck[] = [];
  const rows = await instructionsWithStatus(rt.books.database, ["settled"], "submitter");
  for (const row of rows) {
    const flow = row.flow as BondFlow;
    if (flow.kind !== "bond-coupon" && flow.kind !== "bond-redeem") continue;
    const entry = await rt.books.entryByKey(row.entryKey);
    if (!entry) continue;
    const { issuer, terms } = bondInfo(rt.scenario, flow.bond);
    const currency = terms.face.currency;
    const total = (lines: readonly Line[], account: string, side: "debit" | "credit") =>
      lines.filter((l) => l.account === account && l.side === side).reduce((t, l) => t + l.amount.minor, 0n);
    const issuerDebit = total(entry.lines, bankAccounts.customerDeposit(issuer), "debit");
    const paid = total(entry.lines, bankAccounts.wholesaleReserves(currency), "credit");
    const residual =
      total(entry.lines, bankAccounts.roundingResidual, "credit") - total(entry.lines, bankAccounts.roundingResidual, "debit");
    checks.push({
      invariant: 8,
      account: `${flow.bond} payment ${flow.period}`,
      books: formatMoney(money(currency, issuerDebit)),
      chain: `${formatMoney(money(currency, paid))} paid + ${formatMoney(money(currency, residual))} residual`,
      ok: issuerDebit === paid + residual && paid === flowValue(flow) && issuerDebit === BigInt(flow.issuerDebit),
    });
  }
  return checks;
}

/**
 * Invariant 11 over every payment across currencies this participant booked:
 * the quote is the dealer's, signed, and priced by its rate; and every line of
 * the posted entry in the source currency is the source amount, every line in
 * the target currency the target amount. The listener has already matched
 * the entry to what the chain moved.
 */
async function fxChecks(rt: RuntimeContext): Promise<ReconciliationCheck[]> {
  const checks: ReconciliationCheck[] = [];
  for (const row of await instructionsWithStatus(rt.books.database, ["settled"])) {
    if (row.flow.kind !== "pvp") continue;
    const { quote } = row.flow as FxFlow;
    const entry = await rt.books.entryByKey(row.entryKey);
    if (!entry) continue;
    const source = money(quote.from, BigInt(quote.sourceAmount));
    const target = money(quote.to, BigInt(quote.targetAmount));
    const signed = await verifyQuote(rt, quote, { settled: true }).then(
      () => true,
      () => false,
    );
    const booked = entry.lines.every((l) =>
      l.amount.currency === quote.from ? l.amount.minor === source.minor : l.amount.currency === quote.to && l.amount.minor === target.minor,
    );
    // Books: the target amount as signed and booked. Chain: what the source amount comes to at the rate.
    checks.push({
      invariant: 11,
      account: `${quote.from} ${formatMoney(source)} → ${quote.to} at ${quote.rate}, quote ${quote.id}`,
      books: formatMoney(target),
      chain: formatMoney(money(quote.to, targetFor(rt, quote))),
      ok: signed && booked && targetFor(rt, quote) === target.minor,
    });
  }
  return checks;
}

/**
 * Invariant 12 from the audit log alone: every instruction, affirmation and
 * change released only after the approvals its policy required, by operators
 * other than its initiator; and the chain that makes the log evidence intact.
 */
async function policyChecks(rt: RuntimeContext): Promise<ReconciliationCheck[]> {
  const entries = await allAudit(rt.books.database);
  const chain = await verifyAudit(rt.books.database, entries);
  const violations = policyViolations(entries);
  const released = entries.filter((e) => e.action === "released" || e.action === "affirmed" || e.action === "changed").length;
  return [
    {
      invariant: 12,
      account: "policy: released only after the approvals it requires",
      books: `${released} released`,
      chain: violations.length === 0 ? `${released} with their approvals` : `${violations.length} without: ${violations[0]!.subject} ${violations[0]!.problem}`,
      ok: violations.length === 0,
    },
    {
      invariant: 12,
      account: "audit log: hash chain",
      books: `${chain.entries} entries`,
      chain: chain.ok ? `verifies to ${chain.head.slice(0, 12)}` : `breaks at entry ${chain.brokenAt!.seq}: ${chain.brokenAt!.reason}`,
      ok: chain.ok,
    },
  ];
}

/**
 * Invariant 13's second half: for every coupon or redemption a custodian was
 * paid on its omnibus, what it received is exactly what it credited its
 * clients plus the residual it kept, as its posted entry shows.
 */
async function allocationChecks(rt: RuntimeContext): Promise<ReconciliationCheck[]> {
  const checks: ReconciliationCheck[] = [];
  for (const row of await instructionsWithStatus(rt.books.database, ["settled"], "approver")) {
    const flow = row.flow as BondFlow;
    if (flow.kind !== "bond-coupon" && flow.kind !== "bond-redeem") continue;
    const custody = flow.payments.filter((p) => p.bank === rt.participant && p.wallet);
    if (custody.length === 0) continue;
    const entry = await rt.books.entryByKey(row.entryKey);
    if (!entry) continue;
    const currency = bondInfo(rt.scenario, flow.bond).terms.face.currency;
    const received = custody.reduce((t, p) => t + ("amount" in p ? BigInt(p.amount) : BigInt(p.principal) + BigInt(p.coupon)), 0n);
    const total = (prefix: string, side: "debit" | "credit") =>
      entry.lines.filter((l) => l.account.startsWith(prefix) && l.side === side).reduce((t, l) => t + l.amount.minor, 0n);
    const clients = new Set(rt.scenario.custody.find((c) => c.bank === rt.participant)?.clients ?? []);
    const allocated = entry.lines
      .filter((l) => l.side === "credit" && l.account.startsWith(`${bankAccounts.customerDeposits}/`) && clients.has(l.account.slice(bankAccounts.customerDeposits.length + 1)))
      .reduce((t, l) => t + l.amount.minor, 0n);
    const residual = total(bankAccounts.roundingResidual, "credit") - total(bankAccounts.roundingResidual, "debit");
    checks.push({
      invariant: 13,
      account: `${flow.bond} payment ${flow.period} to clients`,
      books: `${formatMoney(money(currency, allocated))} allocated + ${formatMoney(money(currency, residual))} residual`,
      chain: formatMoney(money(currency, received)),
      ok: allocated + residual === received,
    });
  }
  return checks;
}
