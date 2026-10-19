import type { Approval } from "@oul/chain";
import type { Executor } from "@oul/ledger";
import { sql } from "drizzle-orm";
import type { Flow, Quote } from "./flows.ts";

/** One row of the `instructions` table (migrations/0001_runtime.sql). */
export interface InstructionRow {
  readonly uetr: string;
  /** submitter: we send it; approver: we co-signed it; party: we book it, someone else sends it. */
  readonly role: "submitter" | "approver" | "party";
  readonly flow: Flow;
  readonly approvals: readonly Approval[];
  readonly entryKey: string;
  /**
   * proposed: booked, waiting for the approvals its policy requires; ready: approved, to be sent;
   * rejected: an approver refused it, and its entry was voided.
   */
  readonly status: "proposed" | "ready" | "submitted" | "awaiting" | "settled" | "failed" | "expired" | "rejected";
  readonly deadline: Date;
  readonly txHash: string | null;
  readonly settledBlock: bigint | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

export type InstructionStatus = InstructionRow["status"];

function fromRow(row: Record<string, unknown>): InstructionRow {
  return {
    uetr: String(row["uetr"]),
    role: row["role"] as InstructionRow["role"],
    flow: row["flow"] as Flow,
    approvals: row["approvals"] as Approval[],
    entryKey: String(row["entry_key"]),
    status: row["status"] as InstructionStatus,
    deadline: new Date(String(row["deadline"])),
    txHash: row["tx_hash"] == null ? null : String(row["tx_hash"]),
    settledBlock: row["settled_block"] == null ? null : BigInt(String(row["settled_block"])),
    attempts: Number(row["attempts"]),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    createdAt: new Date(String(row["created_at"])),
  };
}

export async function insertInstruction(
  db: Executor,
  row: Pick<InstructionRow, "uetr" | "role" | "flow" | "approvals" | "entryKey" | "status" | "deadline">,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO instructions (uetr, role, flow, approvals, entry_key, status, deadline)
    VALUES (${row.uetr}, ${row.role}, ${JSON.stringify(row.flow)}::jsonb, ${JSON.stringify(row.approvals)}::jsonb,
            ${row.entryKey}, ${row.status}, ${row.deadline.toISOString()}::timestamptz)
  `);
}

export async function getInstruction(db: Executor, uetr: string): Promise<InstructionRow | undefined> {
  const result = await db.execute(sql`SELECT * FROM instructions WHERE uetr = ${uetr}`);
  const row = result.rows[0];
  return row ? fromRow(row) : undefined;
}

export async function instructionsWithStatus(
  db: Executor,
  statuses: readonly InstructionStatus[],
  role?: InstructionRow["role"],
): Promise<InstructionRow[]> {
  const result = await db.execute(sql`
    SELECT * FROM instructions
     WHERE status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})
       ${role ? sql`AND role = ${role}` : sql``}
     ORDER BY created_at
  `);
  return result.rows.map(fromRow);
}

/** A page of instructions, newest first, before an earlier page's last `createdAt` and `uetr`. */
export async function listInstructions(
  db: Executor,
  options: { limit: number; before?: { createdAt: Date; uetr: string }; statuses?: readonly InstructionStatus[] },
): Promise<InstructionRow[]> {
  const { limit, before, statuses } = options;
  const result = await db.execute(sql`
    SELECT * FROM instructions
     WHERE true
       ${before ? sql`AND (created_at, uetr) < (${before.createdAt.toISOString()}::timestamptz, ${before.uetr})` : sql``}
       ${statuses?.length ? sql`AND status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
     ORDER BY created_at DESC, uetr DESC
     LIMIT ${limit}
  `);
  return result.rows.map(fromRow);
}

export async function updateInstruction(
  db: Executor,
  uetr: string,
  changes: {
    status?: InstructionStatus;
    txHash?: string;
    settledBlock?: bigint;
    lastError?: string | null;
    attempt?: boolean;
    /** The flow again, with the deadline it is released under; the deadline column follows it. */
    flow?: Flow;
    approvals?: readonly Approval[];
  },
): Promise<void> {
  await db.execute(sql`
    UPDATE instructions SET
      status = coalesce(${changes.status ?? null}, status),
      flow = coalesce(${changes.flow ? JSON.stringify(changes.flow) : null}::jsonb, flow),
      deadline = coalesce(${changes.flow ? new Date(changes.flow.deadline * 1000).toISOString() : null}::timestamptz, deadline),
      approvals = coalesce(${changes.approvals ? JSON.stringify(changes.approvals) : null}::jsonb, approvals),
      tx_hash = coalesce(${changes.txHash ?? null}, tx_hash),
      settled_block = coalesce(${changes.settledBlock?.toString() ?? null}::bigint, settled_block),
      last_error = ${changes.lastError === undefined ? sql`last_error` : sql`${changes.lastError}`},
      attempts = attempts + ${changes.attempt ? 1 : 0},
      updated_at = clock_timestamp()
    WHERE uetr = ${uetr}
  `);
}

export async function recordBreak(
  db: Executor,
  entry: { block: bigint; kind: "unexplained" | "mismatch"; uetr?: string | undefined; txHash: string; detail: unknown },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO chain_breaks (block, kind, uetr, tx_hash, detail)
    VALUES (${entry.block.toString()}::bigint, ${entry.kind}, ${entry.uetr ?? null}, ${entry.txHash},
            ${JSON.stringify(entry.detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}::jsonb)
  `);
}

export async function readCursor(db: Executor): Promise<bigint | undefined> {
  const result = await db.execute(sql`SELECT last_block::text AS last_block FROM chain_cursor`);
  const row = result.rows[0];
  return row ? BigInt(String(row["last_block"])) : undefined;
}

export async function writeCursor(db: Executor, block: bigint): Promise<void> {
  await db.execute(sql`
    INSERT INTO chain_cursor (singleton, last_block) VALUES (true, ${block.toString()}::bigint)
    ON CONFLICT (singleton) DO UPDATE SET last_block = excluded.last_block
  `);
}

// ---------------------------------------------------------------- FX quotes (migrations/0004_fx_quotes.sql)

export interface QuoteRow {
  readonly role: "dealer" | "requester";
  readonly quote: Quote;
  /** The instruction that settles it, once one has claimed it. */
  readonly uetr: string | null;
  readonly createdAt: Date;
}

const quoteFromRow = (row: Record<string, unknown>): QuoteRow => ({
  role: row["role"] as QuoteRow["role"],
  quote: row["quote"] as Quote,
  uetr: row["uetr"] == null ? null : String(row["uetr"]),
  createdAt: new Date(String(row["created_at"])),
});

export async function insertQuote(db: Executor, role: QuoteRow["role"], quote: Quote): Promise<void> {
  await db.execute(sql`INSERT INTO fx_quotes (id, role, quote) VALUES (${quote.id}, ${role}, ${JSON.stringify(quote)}::jsonb)`);
}

export async function getQuote(db: Executor, id: string): Promise<QuoteRow | undefined> {
  const result = await db.execute(sql`SELECT * FROM fx_quotes WHERE id = ${id}`);
  const row = result.rows[0];
  return row ? quoteFromRow(row) : undefined;
}

/** Claim a quote for one instruction; false if another instruction already holds it. */
export async function claimQuote(db: Executor, id: string, uetr: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE fx_quotes SET uetr = ${uetr} WHERE id = ${id} AND (uetr IS NULL OR uetr = ${uetr}) RETURNING id
  `);
  return result.rows.length === 1;
}

/** The newest quotes first. */
export async function listQuotes(db: Executor, limit: number): Promise<QuoteRow[]> {
  const result = await db.execute(sql`SELECT * FROM fx_quotes ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
  return result.rows.map(quoteFromRow);
}
