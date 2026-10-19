import {
  bankAccounts,
  type CollateralLine,
  collateralValue,
  couponPayment,
  couponSchedule,
  daysHeld,
  formatMoney,
  fromDecimal,
  isCovered,
  marginCall,
  type Mark,
  money,
  moveCollateral,
  repoInterest,
  type RepoTerms,
  assertRepoTerms,
  substitutionUnits,
  toDecimal,
} from "@oul/domain";
import type { Executor } from "@oul/ledger";
import type { RepoSpec } from "@oul/scenario";
import { sql } from "drizzle-orm";
import type { RuntimeContext } from "./context.ts";
import { canonical } from "./canonical.ts";
import { FlowRejected } from "./errors.ts";
import {
  type BondFlow,
  bondInfo,
  type CollateralUnits,
  markOf,
  type RepoFlow,
  type RepoMark,
  repoCurrency,
} from "./flows.ts";
import type { ReconciliationCheck } from "./reconciler.ts";

/**
 * Repo (SPEC.md §5.7–§5.10). Each bank keeps its own record of every repo it
 * is party to: the terms both sides affirmed when it opened, and the
 * collateral the lender holds now, moved only when the chain settles a repo
 * instruction. Every repo flow is checked against that record by both sides
 * before it is booked or signed: a margin is exactly what the marks call for,
 * a substitution brings in at least the value it takes out, a close returns
 * every unit and repays exactly the purchase price plus interest, and a
 * manufactured payment is the coupon on the units the record shows at the
 * coupon's record block. Invariant 14 is checked from the record, the books
 * and the settled instructions after every block.
 */

/**
 * A repo's interest for its whole term (SPEC.md §5.10): ACT/365F, rounded
 * once, half-even; over a 360-day year under the conformance kit's broken
 * engine `repo-interest-360` alone (defects.ts).
 */
export function interestFor(rt: RuntimeContext, terms: RepoTerms): ReturnType<typeof repoInterest> {
  if (!rt.defects.has("repo-interest-360")) return repoInterest(terms, terms.endDate);
  return fromDecimal(terms.cash.currency, toDecimal(terms.cash).times(terms.rate).times(daysHeld(terms, terms.endDate)).dividedBy(360), "half-even");
}

/** The terms of a repo as both sides affirmed them, kept in each side's record. */
export interface RepoTermsRecord {
  readonly lender: string;
  readonly borrower: string;
  /** The purchase price, in minor units. */
  readonly cash: string;
  readonly rate: string;
  readonly haircut: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly dayCount: "ACT/365F";
}

export interface RepoRow {
  readonly id: string;
  readonly role: "lender" | "borrower";
  readonly counterparty: string;
  readonly terms: RepoTermsRecord;
  /** The collateral the lender holds now, by bond. */
  readonly collateral: readonly CollateralUnits[];
  readonly status: "open" | "closed";
  readonly openedBlock: bigint;
  readonly closedBlock: bigint | null;
}

/** The scenario's repo conventions, or a refusal where it has none. */
export function repoConventions(rt: RuntimeContext): RepoSpec {
  if (!rt.scenario.repo) throw new FlowRejected("invalid-flow", `${rt.scenario.id} has no repo`);
  return rt.scenario.repo;
}

/** A repo's terms in the domain's form. */
export function domainTerms(rt: RuntimeContext, terms: RepoTermsRecord): RepoTerms {
  return {
    cash: money(repoCurrency(rt.scenario), BigInt(terms.cash)),
    rate: terms.rate,
    haircut: terms.haircut,
    startDate: terms.startDate,
    endDate: terms.endDate,
    dayCount: terms.dayCount,
  };
}

const termsOfOpen = (flow: Extract<RepoFlow, { kind: "repo-open" }>, dayCount: "ACT/365F"): RepoTermsRecord => ({
  lender: flow.lender,
  borrower: flow.borrower,
  cash: flow.cash,
  rate: flow.rate,
  haircut: flow.haircut,
  startDate: flow.startDate,
  endDate: flow.endDate,
  dayCount,
});

const toLines = (collateral: readonly CollateralUnits[]): CollateralLine[] => collateral.map((c) => ({ bond: c.bond, units: BigInt(c.units) }));
const fromLines = (lines: readonly CollateralLine[]): CollateralUnits[] => lines.map((c) => ({ bond: c.bond, units: c.units.toString() }));
const toMarks = (rt: RuntimeContext, marks: readonly RepoMark[]): Mark[] =>
  marks.map((m) => ({ bond: m.bond, price: money(repoCurrency(rt.scenario), BigInt(m.price)) }));
const sorted = (collateral: readonly CollateralUnits[]) => [...collateral].sort((a, b) => (a.bond < b.bond ? -1 : a.bond > b.bond ? 1 : 0));

// ---------------------------------------------------------------- the record (migrations/0008_repo.sql)

function repoFromRow(row: Record<string, unknown>): RepoRow {
  return {
    id: String(row["id"]),
    role: row["role"] as RepoRow["role"],
    counterparty: String(row["counterparty"]),
    terms: row["terms"] as RepoTermsRecord,
    collateral: row["collateral"] as CollateralUnits[],
    status: row["status"] as RepoRow["status"],
    openedBlock: BigInt(String(row["opened_block"])),
    closedBlock: row["closed_block"] == null ? null : BigInt(String(row["closed_block"])),
  };
}

export async function getRepo(db: Executor, id: string): Promise<RepoRow | undefined> {
  const row = (await db.execute(sql`SELECT * FROM repos WHERE id = ${id}`)).rows[0];
  return row ? repoFromRow(row) : undefined;
}

export async function listRepos(db: Executor): Promise<RepoRow[]> {
  return (await db.execute(sql`SELECT * FROM repos ORDER BY opened_block DESC, id`)).rows.map(repoFromRow);
}

/** The record after each settled flow of a repo, oldest first. */
export async function repoHistory(db: Executor, id: string) {
  const rows = (await db.execute(sql`SELECT uetr, kind, block::text AS block, collateral FROM repo_records WHERE repo = ${id} ORDER BY block, uetr`)).rows;
  return rows.map((r) => ({ uetr: String(r["uetr"]), kind: String(r["kind"]), block: BigInt(String(r["block"])), collateral: r["collateral"] as CollateralUnits[] }));
}

/** The collateral the record shows at the end of `block`: nothing before the repo opened. */
export async function recordAt(db: Executor, id: string, block: bigint): Promise<CollateralUnits[]> {
  const row = (
    await db.execute(sql`SELECT collateral FROM repo_records WHERE repo = ${id} AND block <= ${block.toString()}::bigint ORDER BY block DESC, uetr DESC LIMIT 1`)
  ).rows[0];
  return (row?.["collateral"] as CollateralUnits[] | undefined) ?? [];
}

/** Every repo open at the end of `block`, with the collateral its record shows then. */
export async function recordsAt(db: Executor, block: bigint): Promise<{ repo: string; role: RepoRow["role"]; collateral: CollateralUnits[] }[]> {
  const out = [];
  for (const repo of await listRepos(db)) {
    if (repo.openedBlock > block || (repo.closedBlock !== null && repo.closedBlock <= block)) continue;
    out.push({ repo: repo.id, role: repo.role, collateral: await recordAt(db, repo.id, block) });
  }
  return out;
}

/**
 * Move the record for a repo instruction the chain settled, in the
 * listener's transaction: an open starts it, a margin or substitution moves
 * its collateral, a close empties and closes it. A manufactured payment moves
 * no collateral.
 */
export async function applyRepoSettlement(rt: RuntimeContext, db: Executor, flow: RepoFlow, block: bigint): Promise<void> {
  const role = flow.lender === rt.participant ? "lender" : "borrower";
  const record = async (repo: string, collateral: readonly CollateralUnits[]) =>
    db.execute(sql`
      INSERT INTO repo_records (repo, uetr, kind, block, collateral)
      VALUES (${repo}, ${flow.uetr}, ${flow.kind}, ${block.toString()}::bigint, ${JSON.stringify(sorted(collateral))}::jsonb)
      ON CONFLICT DO NOTHING
    `);
  if (flow.kind === "repo-open") {
    const collateral = [{ bond: flow.bond, units: flow.units }];
    await db.execute(sql`
      INSERT INTO repos (id, role, counterparty, terms, collateral, status, opened_block)
      VALUES (${flow.uetr}, ${role}, ${role === "lender" ? flow.borrower : flow.lender},
              ${JSON.stringify(termsOfOpen(flow, repoConventions(rt).dayCount))}::jsonb, ${JSON.stringify(collateral)}::jsonb, 'open', ${block.toString()}::bigint)
      ON CONFLICT DO NOTHING
    `);
    await record(flow.uetr, collateral);
    return;
  }
  if (flow.kind === "repo-manufactured") return;
  const repo = await getRepo(db, flow.repo);
  if (!repo) {
    rt.log(`settled ${flow.kind} ${flow.uetr} for repo ${flow.repo}, which this record does not hold`);
    return;
  }
  let lines = toLines(repo.collateral);
  if (flow.kind === "repo-margin") lines = moveCollateral(lines, flow.bond, (flow.direction === "deliver" ? 1n : -1n) * BigInt(flow.units));
  if (flow.kind === "repo-substitute") {
    lines = moveCollateral(lines, flow.outgoing.bond, -BigInt(flow.outgoing.units));
    lines = moveCollateral(lines, flow.incoming.bond, BigInt(flow.incoming.units));
  }
  if (flow.kind === "repo-close") lines = [];
  const collateral = fromLines(lines);
  await db.execute(sql`
    UPDATE repos SET collateral = ${JSON.stringify(collateral)}::jsonb,
           status = ${flow.kind === "repo-close" ? "closed" : repo.status},
           closed_block = ${flow.kind === "repo-close" ? block.toString() : null}::bigint,
           updated_at = clock_timestamp()
     WHERE id = ${repo.id}
  `);
  await record(repo.id, collateral);
}

// ---------------------------------------------------------------- holdings

/**
 * A bank's units of a bond it may deliver: what it owns, less what it has
 * pledged or is pledging. Collateral it received is not its to deliver.
 */
export async function freeUnits(rt: RuntimeContext, bond: string): Promise<bigint> {
  const face = bondInfo(rt.scenario, bond).terms.face.minor;
  const holdings = (await rt.books.balance(bankAccounts.bondHolding(bond))).available.minor;
  if (!rt.scenario.repo) return holdings / face;
  const pledged = await rt.books.balance(bankAccounts.collateralPledgedIn(bond));
  return (holdings - pledged.posted.minor - pledged.pendingCredits.minor) / face;
}

/** Refuse a delivery of more units than this bank may deliver. */
export async function requireFreeUnits(rt: RuntimeContext, bond: string, units: bigint): Promise<void> {
  const free = await freeUnits(rt, bond);
  if (free < units) {
    throw new FlowRejected(
      "insufficient-funds",
      `${rt.participant} owns ${free} units of ${bond} it may deliver, not ${units}: units it pledged, or holds as a lender's collateral, are not its to deliver`,
    );
  }
}

/** The units of a bond this bank holds as collateral or has pledged, in open repos: none may be redeemed meanwhile. */
export async function collateralUnitsIn(db: Executor, bond: string): Promise<bigint> {
  let total = 0n;
  for (const repo of (await listRepos(db)).filter((r) => r.status === "open")) {
    total += repo.collateral.filter((c) => c.bond === bond).reduce((t, c) => t + BigInt(c.units), 0n);
  }
  return total;
}

// ---------------------------------------------------------------- checks before booking or signing

/** Live repo instructions for a repo here, other than `uetr`. */
async function liveRepoFlows(db: Executor, repo: string, uetr: string): Promise<{ uetr: string; flow: RepoFlow }[]> {
  const rows = (
    await db.execute(sql`
      SELECT uetr, flow FROM instructions
       WHERE flow->>'kind' LIKE 'repo-%'
         AND (flow->>'repo' = ${repo} OR uetr = ${repo})
         AND uetr <> ${uetr}
         AND status IN ('proposed', 'ready', 'submitted', 'awaiting')
    `)
  ).rows;
  return rows.map((r) => ({ uetr: String(r["uetr"]), flow: r["flow"] as RepoFlow }));
}

/**
 * Check a repo flow against the scenario, this bank's record and its books,
 * as it is about to affirm it (`affirmer`), hear of a margin call
 * (`called`), book and send it (`submitter`) or book and sign it
 * (`approver`). Every side computes what the flow must be itself and refuses
 * anything else.
 */
export async function checkRepo(rt: RuntimeContext, flow: RepoFlow, side: "affirmer" | "called" | "submitter" | "approver"): Promise<void> {
  const conventions = repoConventions(rt);
  const fail = (message: string): never => {
    throw new FlowRejected("invalid-flow", message);
  };
  if (flow.lender === flow.borrower) fail("A repo needs two different banks");
  if (rt.participant !== flow.lender && rt.participant !== flow.borrower) {
    throw new FlowRejected("not-a-party", `${rt.participant} is not party to this ${flow.kind}`);
  }
  const bonds =
    flow.kind === "repo-open" || flow.kind === "repo-margin" || flow.kind === "repo-manufactured"
      ? [flow.bond]
      : flow.kind === "repo-substitute"
        ? [flow.outgoing.bond, flow.incoming.bond]
        : flow.collateral.map((c) => c.bond);
  for (const bond of bonds) {
    if (!conventions.collateral.includes(bond)) fail(`${bond} is not collateral a repo in ${rt.scenario.id} accepts`);
    const { agent } = bondInfo(rt.scenario, bond);
    if (agent === flow.lender || agent === flow.borrower) fail(`${agent} pays ${bond}, so it cannot hold it as repo collateral`);
  }
  const currency = repoCurrency(rt.scenario);
  const delivering = side === "submitter" && rt.participant === flow.borrower;

  if (flow.kind === "repo-open") {
    const terms = termsOfOpen(flow, conventions.dayCount);
    try {
      assertRepoTerms(domainTerms(rt, terms));
    } catch (error) {
      fail((error as Error).message);
    }
    const marks = [{ bond: flow.bond, price: money(currency, BigInt(flow.mark)) }];
    if (!isCovered(domainTerms(rt, terms), toLines([{ bond: flow.bond, units: flow.units }]), marks, flow.startDate)) {
      fail(`${flow.units} units of ${flow.bond} at ${formatMoney(marks[0]!.price)} less a ${flow.haircut} haircut do not cover ${formatMoney(money(currency, BigInt(flow.cash)))}`);
    }
    if (await getRepo(rt.books.database, flow.uetr)) throw new FlowRejected("conflicting-instruction", `Repo ${flow.uetr} is already open here`);
    if (delivering) await requireFreeUnits(rt, flow.bond, BigInt(flow.units));
    return;
  }

  const repo = await getRepo(rt.books.database, flow.repo);
  if (!repo) throw new FlowRejected("not-found", `${rt.participant} has no repo ${flow.repo}`);
  if (repo.terms.lender !== flow.lender || repo.terms.borrower !== flow.borrower) fail(`Repo ${flow.repo} is between ${repo.terms.lender} and ${repo.terms.borrower}`);
  const terms = domainTerms(rt, repo.terms);

  if (flow.kind === "repo-manufactured") {
    await checkManufactured(rt, repo, flow);
    return;
  }
  if (repo.status !== "open") fail(`Repo ${flow.repo} is closed`);
  // One flow at a time per repo: each is computed from the record the one before leaves.
  const other = (await liveRepoFlows(rt.books.database, repo.id, flow.uetr)).find((f) => f.flow.kind !== "repo-manufactured");
  if (other) throw new FlowRejected("conflicting-instruction", `Repo ${repo.id} already has ${other.flow.kind} ${other.uetr} in flight`);
  const held = toLines(repo.collateral);

  if (flow.kind === "repo-margin" || flow.kind === "repo-substitute") {
    try {
      daysHeld(terms, flow.asOf);
    } catch (error) {
      fail((error as Error).message);
    }
    const marked = new Set(flow.marks.map((m) => m.bond));
    for (const bond of new Set([...held.map((c) => c.bond), ...bonds])) {
      if (!marked.has(bond)) fail(`No mark for ${bond}`);
    }
    if (marked.size !== flow.marks.length) fail("A bond is marked twice");
    for (const m of flow.marks) markOf(flow.marks, m.bond);
  }

  if (flow.kind === "repo-margin") {
    const call = marginCall(terms, held, toMarks(rt, flow.marks), flow.asOf, flow.bond);
    if (call.direction === "none") fail(`At these marks the collateral covers the exposure on ${flow.asOf}: no margin is due`);
    if (call.direction !== flow.direction || call.units.toString() !== flow.units) {
      fail(`At these marks the margin on ${flow.asOf} is to ${call.direction} ${call.direction === "none" ? 0n : call.units} units of ${flow.bond}, not to ${flow.direction} ${flow.units}`);
    }
    // The side that receives units calls the margin; the other delivers it, and only on a call it heard of.
    const caller = flow.direction === "deliver" ? flow.lender : flow.borrower;
    if (side === "affirmer" && rt.participant !== caller) fail(`${caller} calls this margin, not ${rt.participant}`);
    if (side === "submitter") {
      const called = await getMarginCall(rt.books.database, flow.uetr);
      if (!called || called.caller !== caller || !sameRepoFlow(called.flow, flow)) fail(`${caller} has made no margin call ${flow.uetr} for this`);
    }
    if (delivering) await requireFreeUnits(rt, flow.bond, BigInt(flow.units));
    return;
  }

  if (flow.kind === "repo-substitute") {
    const has = held.find((c) => c.bond === flow.outgoing.bond)?.units ?? 0n;
    if (has < BigInt(flow.outgoing.units)) fail(`Repo ${repo.id} holds ${has} units of ${flow.outgoing.bond} as collateral, not ${flow.outgoing.units}`);
    let needed: bigint;
    try {
      needed = substitutionUnits({ bond: flow.outgoing.bond, units: BigInt(flow.outgoing.units) }, flow.incoming.bond, toMarks(rt, flow.marks), currency);
    } catch (error) {
      return fail((error as Error).message);
    }
    if (needed.toString() !== flow.incoming.units) fail(`At these marks ${flow.outgoing.units} ${flow.outgoing.bond} are replaced by ${needed} ${flow.incoming.bond}, not ${flow.incoming.units}`);
    if (delivering) await requireFreeUnits(rt, flow.incoming.bond, needed);
    return;
  }

  // repo-close: every unit the record holds, the purchase price, and interest over every day of the term.
  if (canonical(sorted(flow.collateral)) !== canonical(sorted(repo.collateral))) {
    fail(`Repo ${repo.id} holds ${repo.collateral.map((c) => `${c.units} ${c.bond}`).join(", ")}: a close returns exactly that`);
  }
  if (flow.cash !== repo.terms.cash) fail(`Repo ${repo.id}'s purchase price is ${repo.terms.cash} minor units, not ${flow.cash}`);
  const interest = interestFor(rt, terms);
  if (interest.minor.toString() !== flow.interest) fail(`Interest on repo ${repo.id} is ${formatMoney(interest)}, not ${formatMoney(money(currency, BigInt(flow.interest)))}`);
}

/**
 * A manufactured payment (SPEC.md §5.10): the coupon on the collateral units
 * the record shows at the coupon's record block, rounded once by the bond's
 * rule, at most once per repo, bond and period. The lender checks the record
 * block is the one its own coupon was paid at.
 */
async function checkManufactured(rt: RuntimeContext, repo: RepoRow, flow: Extract<RepoFlow, { kind: "repo-manufactured" }>): Promise<void> {
  const info = bondInfo(rt.scenario, flow.bond);
  const period = couponSchedule(info.terms, info.calendar)[flow.period - 1];
  if (!period || period.final) throw new FlowRejected("invalid-flow", `Period ${flow.period} of ${flow.bond} is not a coupon`);
  const units = toLines(await recordAt(rt.books.database, repo.id, BigInt(flow.recordBlock))).find((c) => c.bond === flow.bond)?.units ?? 0n;
  if (units === 0n || units.toString() !== flow.units) {
    throw new FlowRejected("invalid-flow", `At block ${flow.recordBlock} repo ${repo.id} held ${units} units of ${flow.bond}, not ${flow.units}`);
  }
  const amount = couponPayment(info.terms, period, [{ holder: "collateral", units }]).payments[0]!.amount;
  if (amount.minor.toString() !== flow.amount) {
    throw new FlowRejected("invalid-flow", `The coupon on ${units} units of ${flow.bond} is ${formatMoney(amount)}, not ${formatMoney(money(amount.currency, BigInt(flow.amount)))}`);
  }
  if (rt.participant === flow.lender) {
    const coupon = await couponReceived(rt, flow.bond, flow.period);
    if (!coupon || coupon.recordBlock !== flow.recordBlock) {
      throw new FlowRejected("invalid-flow", `${rt.participant} received no coupon ${flow.period} on ${flow.bond} closed at block ${flow.recordBlock}`);
    }
  }
  const done = (await manufacturedPayments(rt.books.database, repo.id)).find((m) => m.flow.bond === flow.bond && m.flow.period === flow.period && m.uetr !== flow.uetr);
  if (done) throw new FlowRejected("conflicting-instruction", `Coupon ${flow.period} on ${flow.bond} under repo ${repo.id} is already passed on by ${done.uetr}`);
}

/** The coupon on a bond this bank was paid as a holder, settled: its period and record block. */
async function couponReceived(rt: RuntimeContext, bond: string, period: number) {
  const row = (
    await rt.books.database.execute(sql`
      SELECT flow FROM instructions
       WHERE flow->>'kind' = 'bond-coupon' AND flow->>'bond' = ${bond} AND (flow->>'period')::int = ${period} AND status = 'settled'
    `)
  ).rows[0];
  const flow = row?.["flow"] as Extract<BondFlow, { kind: "bond-coupon" }> | undefined;
  return flow ? { recordBlock: flow.recordBlock, uetr: flow.uetr } : undefined;
}

/** The manufactured payments under a repo that are not dead. */
async function manufacturedPayments(db: Executor, repo: string): Promise<{ uetr: string; status: string; flow: Extract<RepoFlow, { kind: "repo-manufactured" }> }[]> {
  const rows = (
    await db.execute(sql`
      SELECT uetr, status, flow FROM instructions
       WHERE flow->>'kind' = 'repo-manufactured' AND flow->>'repo' = ${repo} AND status NOT IN ('failed', 'expired', 'rejected')
    `)
  ).rows;
  return rows.map((r) => ({ uetr: String(r["uetr"]), status: String(r["status"]), flow: r["flow"] as Extract<RepoFlow, { kind: "repo-manufactured" }> }));
}

/** Two repo flows are the same if everything but the deadline matches. */
export function sameRepoFlow(a: object, b: object): boolean {
  const strip = ({ deadline: _d, ...rest }: Record<string, unknown>) => rest;
  return canonical(strip(a as Record<string, unknown>)) === canonical(strip(b as Record<string, unknown>));
}

/**
 * A co-signer signs an open, a margin or a substitution only if its own
 * operator affirmed exactly it first, under the same UETR: the terms of a
 * repo, and the marks behind any change to its collateral, are never decided
 * by the counterparty alone.
 */
export async function requireRepoAffirmation(rt: RuntimeContext, flow: RepoFlow): Promise<void> {
  if (flow.kind === "repo-close" || flow.kind === "repo-manufactured") return;
  const result = await rt.books.database.execute(sql`SELECT flow FROM affirmations WHERE uetr = ${flow.uetr} AND status = 'affirmed'`);
  const affirmed = result.rows[0]?.["flow"] as Record<string, unknown> | undefined;
  if (!affirmed || !sameRepoFlow(affirmed, flow)) {
    throw new FlowRejected("not-a-party", `${rt.participant} has not affirmed this ${flow.kind} (${flow.uetr})`);
  }
}

// ---------------------------------------------------------------- margin calls

export interface MarginCallRow {
  readonly uetr: string;
  readonly repo: string;
  readonly flow: Extract<RepoFlow, { kind: "repo-margin" }>;
  readonly caller: string;
  readonly dueBy: number;
  readonly notified: boolean;
}

const callFromRow = (r: Record<string, unknown>): MarginCallRow => ({
  uetr: String(r["uetr"]),
  repo: String(r["repo"]),
  flow: r["flow"] as MarginCallRow["flow"],
  caller: String(r["caller"]),
  dueBy: Number(r["due_by"]),
  notified: Boolean(r["notified"]),
});

export async function recordMarginCall(db: Executor, call: MarginCallRow): Promise<void> {
  await db.execute(sql`
    INSERT INTO margin_calls (uetr, repo, flow, caller, due_by, notified)
    VALUES (${call.uetr}, ${call.flow.repo}, ${JSON.stringify(call.flow)}::jsonb, ${call.caller}, ${call.dueBy}, ${call.notified})
    ON CONFLICT (uetr) DO NOTHING
  `);
}

export async function getMarginCall(db: Executor, uetr: string): Promise<MarginCallRow | undefined> {
  const row = (await db.execute(sql`SELECT * FROM margin_calls WHERE uetr = ${uetr}`)).rows[0];
  return row ? callFromRow(row) : undefined;
}

/** Calls this bank made, affirmed, that the other side has not yet heard of. */
export async function callsToNotify(db: Executor): Promise<MarginCallRow[]> {
  const rows = (
    await db.execute(sql`
      SELECT c.* FROM margin_calls c JOIN affirmations a ON a.uetr = c.uetr
       WHERE NOT c.notified AND a.status = 'affirmed'
    `)
  ).rows;
  return rows.map(callFromRow);
}

export async function markNotified(db: Executor, uetr: string): Promise<void> {
  await db.execute(sql`UPDATE margin_calls SET notified = true WHERE uetr = ${uetr}`);
}

export type MarginCallStatus = "proposed" | "rejected" | "open" | "overdue" | "met";

/** Each margin call on a repo with where it stands: met once settled, overdue once past its due time unmet. */
export async function marginCallsOf(rt: RuntimeContext, repo: string, now: number) {
  const rows = (
    await rt.books.database.execute(sql`
      SELECT c.*, a.status AS affirmation, i.status AS instruction, i.settled_block::text AS settled_block
        FROM margin_calls c
        LEFT JOIN affirmations a ON a.uetr = c.uetr
        LEFT JOIN instructions i ON i.uetr = c.uetr
       WHERE c.repo = ${repo}
       ORDER BY c.created_at
    `)
  ).rows;
  return rows.map((r) => {
    const call = callFromRow(r);
    const affirmation = r["affirmation"] == null ? null : String(r["affirmation"]);
    const status: MarginCallStatus =
      r["instruction"] === "settled"
        ? "met"
        : affirmation === "rejected"
          ? "rejected"
          : affirmation === "proposed"
            ? "proposed"
            : now > call.dueBy
              ? "overdue"
              : "open";
    return { ...call, status, settledBlock: r["settled_block"] == null ? null : String(r["settled_block"]) };
  });
}

// ---------------------------------------------------------------- planning a flow from the record

export type RepoRequest = Omit<Extract<RepoFlow, { kind: "repo-margin" | "repo-substitute" | "repo-close" | "repo-manufactured" }>, "uetr" | "deadline">;

async function openRepo(rt: RuntimeContext, id: string): Promise<RepoRow> {
  const repo = await getRepo(rt.books.database, id);
  if (!repo) throw new FlowRejected("not-found", `${rt.participant} has no repo ${id}`);
  return repo;
}

/** The margin these marks call for on `asOf`, settled in units of `bond` (SPEC.md §5.8). */
export async function planMargin(rt: RuntimeContext, id: string, marks: readonly RepoMark[], asOf: string, bond: string) {
  const repo = await openRepo(rt, id);
  let call;
  try {
    call = marginCall(domainTerms(rt, repo.terms), toLines(repo.collateral), toMarks(rt, marks), asOf, bond);
  } catch (error) {
    throw new FlowRejected("invalid-flow", (error as Error).message);
  }
  if (call.direction === "none") throw new FlowRejected("invalid-flow", `At these marks the collateral covers the exposure on ${asOf}: no margin is due`);
  return {
    kind: "repo-margin" as const,
    repo: repo.id,
    lender: repo.terms.lender,
    borrower: repo.terms.borrower,
    direction: call.direction,
    bond,
    units: call.units.toString(),
    marks: [...marks],
    asOf,
  };
}

/** A substitution of `units` of one bond for the units of another the marks call for (SPEC.md §5.9). */
export async function planSubstitution(rt: RuntimeContext, id: string, outgoing: CollateralUnits, incomingBond: string, marks: readonly RepoMark[], asOf: string) {
  const repo = await openRepo(rt, id);
  let units: bigint;
  try {
    units = substitutionUnits({ bond: outgoing.bond, units: BigInt(outgoing.units) }, incomingBond, toMarks(rt, marks), repoCurrency(rt.scenario));
  } catch (error) {
    throw new FlowRejected("invalid-flow", (error as Error).message);
  }
  return {
    kind: "repo-substitute" as const,
    repo: repo.id,
    lender: repo.terms.lender,
    borrower: repo.terms.borrower,
    outgoing,
    incoming: { bond: incomingBond, units: units.toString() },
    marks: [...marks],
    asOf,
  };
}

/** The close at the end date: every collateral unit back, the purchase price plus interest (SPEC.md §5.10). */
export async function planClose(rt: RuntimeContext, id: string) {
  const repo = await openRepo(rt, id);
  if (repo.status !== "open") throw new FlowRejected("invalid-flow", `Repo ${id} is closed`);
  return {
    kind: "repo-close" as const,
    repo: repo.id,
    lender: repo.terms.lender,
    borrower: repo.terms.borrower,
    collateral: sorted(repo.collateral),
    cash: repo.terms.cash,
    interest: interestFor(rt, domainTerms(rt, repo.terms)).minor.toString(),
  };
}

/** The manufactured payment of a coupon this lender received on collateral (SPEC.md §5.10). */
export async function planManufactured(rt: RuntimeContext, id: string, bond: string, period: number) {
  const repo = await openRepo(rt, id);
  if (repo.role !== "lender") throw new FlowRejected("not-a-party", `${rt.participant} borrows under repo ${id}: the lender pays a manufactured payment`);
  const coupon = await couponReceived(rt, bond, period);
  if (!coupon) throw new FlowRejected("invalid-flow", `${rt.participant} has received no coupon ${period} on ${bond}`);
  const units = toLines(await recordAt(rt.books.database, id, BigInt(coupon.recordBlock))).find((c) => c.bond === bond)?.units ?? 0n;
  if (units === 0n) throw new FlowRejected("invalid-flow", `Repo ${id} held no ${bond} as collateral at block ${coupon.recordBlock}`);
  const info = bondInfo(rt.scenario, bond);
  const schedulePeriod = couponSchedule(info.terms, info.calendar)[period - 1]!;
  return {
    kind: "repo-manufactured" as const,
    repo: repo.id,
    lender: repo.terms.lender,
    borrower: repo.terms.borrower,
    bond,
    period,
    recordBlock: coupon.recordBlock,
    units: units.toString(),
    amount: couponPayment(info.terms, schedulePeriod, [{ holder: "collateral", units }]).payments[0]!.amount.minor.toString(),
  };
}

// ---------------------------------------------------------------- what a bank sees of a repo

/** Coupons this lender received on collateral under a repo, each with the manufactured payment that passed it on, if any. */
async function manufacturedDue(rt: RuntimeContext, repo: RepoRow) {
  if (repo.role !== "lender") return [];
  const coupons = (
    await rt.books.database.execute(sql`
      SELECT flow FROM instructions WHERE flow->>'kind' = 'bond-coupon' AND status = 'settled' ORDER BY settled_block
    `)
  ).rows.map((r) => r["flow"] as Extract<BondFlow, { kind: "bond-coupon" }>);
  const paid = await manufacturedPayments(rt.books.database, repo.id);
  const due = [];
  for (const coupon of coupons) {
    const units = toLines(await recordAt(rt.books.database, repo.id, BigInt(coupon.recordBlock))).find((c) => c.bond === coupon.bond)?.units ?? 0n;
    if (units === 0n) continue;
    const by = paid.find((m) => m.flow.bond === coupon.bond && m.flow.period === coupon.period);
    due.push({ bond: coupon.bond, period: coupon.period, recordBlock: coupon.recordBlock, units: units.toString(), paidBy: by?.uetr ?? null, status: by?.status ?? null });
  }
  return due;
}

/** A repo as one side sees it: its terms, its collateral and its history, what is owed, and its margin calls. */
export async function repoView(rt: RuntimeContext, repo: RepoRow, now: number) {
  const terms = domainTerms(rt, repo.terms);
  const currency = terms.cash.currency;
  const face = (bond: string) => bondInfo(rt.scenario, bond).terms.face.minor;
  return {
    ...repo,
    openedBlock: repo.openedBlock.toString(),
    closedBlock: repo.closedBlock?.toString() ?? null,
    currency,
    repurchasePrice: formatMoney(money(currency, terms.cash.minor + interestFor(rt, terms).minor)),
    interestAtEnd: formatMoney(interestFor(rt, terms)),
    collateralAtFace: formatMoney(money(currency, repo.collateral.reduce((t, c) => t + BigInt(c.units) * face(c.bond), 0n))),
    history: (await repoHistory(rt.books.database, repo.id)).map((h) => ({ ...h, block: h.block.toString() })),
    calls: await marginCallsOf(rt, repo.id, now),
    manufactured: await manufacturedDue(rt, repo),
  };
}

// ---------------------------------------------------------------- invariant 14

/**
 * Invariant 14 at this bank, at `block`, for every repo it is party to:
 *   - the record is exactly what the repo's settled instructions moved,
 *     replayed from its opening;
 *   - per bond, the collateral its open repos' records show equals its
 *     books' collateral received (as lender) or pledged (as borrower), at face;
 *   - after each margin, the collateral at the agreed marks, after the
 *     haircut, covered the cash lent plus interest accrued to the mark's date;
 *     after each substitution, what came in was worth at least what went out;
 *   - each close repaid exactly the purchase price plus interest for the
 *     term, and returned every unit.
 */
export async function repoChecks(rt: RuntimeContext, block: bigint): Promise<ReconciliationCheck[]> {
  if (!rt.scenario.repo || rt.kind !== "bank") return [];
  const checks: ReconciliationCheck[] = [];
  const currency = repoCurrency(rt.scenario);
  const settled = (
    await rt.books.database.execute(sql`
      SELECT uetr, flow, settled_block::text AS block FROM instructions
       WHERE flow->>'kind' LIKE 'repo-%' AND status = 'settled' AND settled_block <= ${block.toString()}::bigint
       ORDER BY settled_block, uetr
    `)
  ).rows.map((r) => ({ uetr: String(r["uetr"]), flow: r["flow"] as RepoFlow, block: BigInt(String(r["block"])) }));
  const describe = (lines: readonly CollateralLine[]) => (lines.length === 0 ? "none" : lines.map((c) => `${c.units} ${c.bond}`).join(", "));

  const perBond = new Map<string, { lender: bigint; borrower: bigint }>();
  for (const repo of await listRepos(rt.books.database)) {
    if (repo.openedBlock > block) continue;
    const terms = domainTerms(rt, repo.terms);
    const flows = settled.filter((s) => (s.flow.kind === "repo-open" ? s.uetr === repo.id : (s.flow as { repo?: string }).repo === repo.id));
    let replay: CollateralLine[] = [];
    for (const { flow, block: at } of flows) {
      const before = replay;
      if (flow.kind === "repo-open") replay = [{ bond: flow.bond, units: BigInt(flow.units) }];
      if (flow.kind === "repo-margin") replay = moveCollateral(replay, flow.bond, (flow.direction === "deliver" ? 1n : -1n) * BigInt(flow.units));
      if (flow.kind === "repo-substitute") {
        replay = moveCollateral(moveCollateral(replay, flow.outgoing.bond, -BigInt(flow.outgoing.units)), flow.incoming.bond, BigInt(flow.incoming.units));
      }
      if (flow.kind === "repo-margin") {
        const marks = toMarks(rt, flow.marks);
        const value = collateralValue(terms, replay, marks);
        const owed = money(currency, terms.cash.minor + repoInterest(terms, flow.asOf).minor);
        checks.push({
          invariant: 14,
          account: `repo ${repo.id.slice(0, 8)} margin at block ${at}: collateral after the haircut covers cash plus interest to ${flow.asOf}`,
          books: formatMoney(owed),
          chain: `${formatMoney(money(currency, BigInt(value.floor().toFixed(0))))} (${describe(replay)})`,
          ok: isCovered(terms, replay, marks, flow.asOf),
        });
      }
      if (flow.kind === "repo-substitute") {
        const marks = toMarks(rt, flow.marks);
        const out = collateralValue(terms, [{ bond: flow.outgoing.bond, units: BigInt(flow.outgoing.units) }], marks);
        const incoming = collateralValue(terms, [{ bond: flow.incoming.bond, units: BigInt(flow.incoming.units) }], marks);
        checks.push({
          invariant: 14,
          account: `repo ${repo.id.slice(0, 8)} substitution at block ${at}: what came in is worth what went out`,
          books: `${formatMoney(money(currency, BigInt(out.floor().toFixed(0))))} out`,
          chain: `${formatMoney(money(currency, BigInt(incoming.floor().toFixed(0))))} in`,
          ok: incoming.greaterThanOrEqualTo(out),
        });
      }
      if (flow.kind === "repo-close") {
        const interest = interestFor(rt, terms);
        const returned = canonical(sorted(fromLines(before))) === canonical(sorted(flow.collateral));
        replay = [];
        checks.push({
          invariant: 14,
          account: `repo ${repo.id.slice(0, 8)} close at block ${at}: principal plus interest, every unit back`,
          books: formatMoney(money(currency, terms.cash.minor + interest.minor)),
          chain: `${formatMoney(money(currency, BigInt(flow.cash) + BigInt(flow.interest)))} repaid, ${returned ? "every unit" : "not every unit"} returned`,
          ok: flow.cash === repo.terms.cash && flow.interest === interest.minor.toString() && returned,
        });
      }
    }
    const record = toLines(await recordAt(rt.books.database, repo.id, block));
    checks.push({
      invariant: 14,
      account: `repo ${repo.id.slice(0, 8)} (${repo.role} with ${repo.counterparty}): record`,
      books: describe(record),
      chain: `${describe(replay)} moved by its instructions`,
      ok: canonical(fromLines(record)) === canonical(fromLines(replay)),
    });
    for (const line of record) {
      const totals = perBond.get(line.bond) ?? { lender: 0n, borrower: 0n };
      totals[repo.role] += line.units;
      perBond.set(line.bond, totals);
    }
  }
  for (const bond of rt.scenario.repo.collateral) {
    const face = bondInfo(rt.scenario, bond).terms.face.minor;
    const totals = perBond.get(bond) ?? { lender: 0n, borrower: 0n };
    for (const [role, account] of [
      ["lender", bankAccounts.collateralReceivedIn(bond)],
      ["borrower", bankAccounts.collateralPledgedIn(bond)],
    ] as const) {
      const books = await rt.books.balanceAtBlock(account, block);
      checks.push({
        invariant: 14,
        account,
        books: formatMoney(books),
        chain: `${formatMoney(money(currency, totals[role] * face))} in the records of open repos`,
        ok: books.minor === totals[role] * face,
      });
    }
  }
  return checks;
}
