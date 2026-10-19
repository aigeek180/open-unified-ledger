import { createHash } from "node:crypto";
import type { Executor } from "@oul/ledger";
import { sql } from "drizzle-orm";
import { canonical } from "./canonical.ts";

/**
 * The participant's audit log (SPEC.md §15): every initiation, approval,
 * rejection, signature and submission, and each outcome, appended in order
 * to a table in the participant's own schema. Each entry carries the hash of
 * the one before it, so an entry edited or deleted afterwards, even by
 * someone who goes around the table's append-only rules, breaks the chain at
 * that point, and `verifyAudit` says where.
 *
 * An actor is `operator:<id>` for one of the participant's operators,
 * `peer:<participant>` for a request another participant sent, and `runtime`
 * for what the runtime does on its own (sending, signing, booking an outcome).
 */

export type AuditAction =
  | "initiated"
  | "approved"
  | "rejected"
  | "released"
  | "signed"
  | "submitted"
  | "settled"
  | "refused"
  | "expired"
  | "affirmed"
  | "changed";

export interface AuditInput {
  readonly actor: string;
  readonly action: AuditAction;
  /** The instruction's UETR, or the id of the change or affirmation it concerns. */
  readonly subject?: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface AuditEntry {
  readonly seq: bigint;
  readonly at: Date;
  readonly actor: string;
  readonly action: string;
  readonly subject: string | null;
  readonly detail: Record<string, unknown>;
  readonly prev: string;
  readonly hash: string;
}

/** The `prev` of the first entry. */
export const GENESIS = "0".repeat(64);

/** JSON values only: bigints become strings, so the detail hashes the same before and after jsonb. */
const plain = (detail: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;

/** The hash of an entry: sha256 over its canonical JSON, the previous hash included. */
export function auditHash(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(
      canonical({
        seq: entry.seq.toString(),
        at: entry.at.toISOString(),
        actor: entry.actor,
        action: entry.action,
        subject: entry.subject,
        detail: entry.detail,
        prev: entry.prev,
      }),
    )
    .digest("hex");
}

/**
 * Append one entry after the last. The schema's advisory lock serializes
 * appends from every connection, so two writers never chain onto the same
 * entry; run inside the transaction that makes the change it records, and the
 * entry commits with it or not at all.
 */
export async function appendAudit(db: Executor, input: AuditInput): Promise<AuditEntry> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':audit'))`);
    const last = (await tx.execute(sql`SELECT seq::text AS seq, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1`)).rows[0];
    const at = new Date();
    const entry = {
      seq: last ? BigInt(String(last["seq"])) + 1n : 1n,
      at,
      actor: input.actor,
      action: input.action,
      subject: input.subject ?? null,
      detail: plain(input.detail ?? {}),
      prev: last ? String(last["hash"]) : GENESIS,
    };
    const hash = auditHash(entry);
    await tx.execute(sql`
      INSERT INTO audit_log (seq, at, actor, action, subject, detail, prev, hash)
      VALUES (${entry.seq.toString()}::bigint, ${at.toISOString()}::timestamptz, ${entry.actor}, ${entry.action},
              ${entry.subject}, ${JSON.stringify(entry.detail)}::jsonb, ${entry.prev}, ${hash})
    `);
    return { ...entry, hash };
  });
}

function fromRow(row: Record<string, unknown>): AuditEntry {
  return {
    seq: BigInt(String(row["seq"])),
    at: row["at"] instanceof Date ? row["at"] : new Date(String(row["at"])),
    actor: String(row["actor"]),
    action: String(row["action"]),
    subject: row["subject"] == null ? null : String(row["subject"]),
    detail: row["detail"] as Record<string, unknown>,
    prev: String(row["prev"]),
    hash: String(row["hash"]),
  };
}

/** A page of the log, newest first; `before` is a sequence number; `subject` picks one instruction's or change's entries. */
export async function readAudit(
  db: Executor,
  options: { limit: number; before?: bigint; subject?: string },
): Promise<AuditEntry[]> {
  const result = await db.execute(sql`
    SELECT seq::text AS seq, at, actor, action, subject, detail, prev, hash FROM audit_log
     WHERE true
       ${options.before ? sql`AND seq < ${options.before.toString()}::bigint` : sql``}
       ${options.subject ? sql`AND subject = ${options.subject}` : sql``}
     ORDER BY audit_log.seq DESC
     LIMIT ${options.limit}
  `);
  return result.rows.map(fromRow);
}

/** The whole log, oldest first. */
export async function allAudit(db: Executor): Promise<AuditEntry[]> {
  return (await db.execute(sql`SELECT seq::text AS seq, at, actor, action, subject, detail, prev, hash FROM audit_log ORDER BY audit_log.seq`)).rows.map(fromRow);
}

export interface AuditVerification {
  readonly ok: boolean;
  /** How many entries were checked. */
  readonly entries: number;
  /** The hash of the last entry: what the next one will chain onto. */
  readonly head: string;
  /** Where the chain breaks, and how: the first entry whose content, hash or link is wrong. */
  readonly brokenAt?: { readonly seq: string; readonly reason: string };
}

/**
 * Walk the whole log from the first entry: each entry's hash must be its
 * content's, each must name the hash before it, and sequence numbers must run
 * without a gap. An edited entry fails on its own hash; a deleted one on the
 * gap, or on the next entry's link.
 */
export async function verifyAudit(db: Executor, entries?: readonly AuditEntry[]): Promise<AuditVerification> {
  const rows = entries ?? (await allAudit(db));
  let prev = GENESIS;
  let expected = 1n;
  for (const entry of rows) {
    const broken = (reason: string) => ({ ok: false, entries: rows.length, head: rows.at(-1)!.hash, brokenAt: { seq: entry.seq.toString(), reason } });
    if (entry.seq !== expected) return broken(`entry ${expected} is missing`);
    if (entry.prev !== prev) return broken("it does not name the hash of the entry before it");
    if (auditHash(entry) !== entry.hash) return broken("its content does not match its hash");
    prev = entry.hash;
    expected++;
  }
  return { ok: true, entries: rows.length, head: prev };
}
