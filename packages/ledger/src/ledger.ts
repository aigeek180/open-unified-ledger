import { createHash } from "node:crypto";
import {
  type AccountSpec,
  type AccountType,
  assertBalanced,
  type CurrencyCode,
  currencyCode,
  type Line,
  type Money,
  money,
  normalBalance,
} from "@oul/domain";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";
import { migrate } from "./migrate.ts";
import { accounts, journalEntries, journalLines } from "./tables.ts";

export interface LedgerOptions {
  readonly connectionString: string;
  /** The Postgres schema holding this participant's books. */
  readonly schema: string;
  /** How many connections its pool may hold; 4 by default. */
  readonly maxConnections?: number;
}

export interface EntryInput {
  /** Retrying with the same key and payload returns the first result. */
  readonly idempotencyKey: string;
  readonly description: string;
  readonly lines: readonly Line[];
  readonly status: "pending" | "posted";
  /** The business instant. Never earlier than an instant already recorded. */
  readonly at: Date;
  /** Required when a posted entry touches a mirrored account. */
  readonly ledgerBlock?: bigint;
}

export interface EntryResult {
  readonly id: bigint;
  /** True when this call matched an earlier one by idempotency key. */
  readonly replayed: boolean;
}

export interface Entry {
  readonly id: bigint;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly status: "pending" | "posted" | "voided";
  readonly createdAt: Date;
  readonly postedAt: Date | null;
  readonly voidedAt: Date | null;
  readonly ledgerBlock: bigint | null;
  readonly lines: readonly Line[];
}

/**
 * A balance in the account's own terms (positive when an asset is owned or a
 * liability owed). Pending entries are reported separately; `available`
 * subtracts pending movements against the account's normal side and ignores
 * pending movements toward it, so money on hold is not spendable and money
 * not yet received is not counted.
 */
export interface Balance {
  readonly account: string;
  readonly posted: Money;
  readonly pendingDebits: Money;
  readonly pendingCredits: Money;
  readonly available: Money;
}

export interface Movement {
  readonly entryId: bigint;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly postedAt: Date;
  readonly ledgerBlock: bigint | null;
  readonly side: "debit" | "credit";
  readonly amount: Money;
}

export interface TrialBalance {
  /** Debits minus credits of all posted lines, per currency. Always zero. */
  readonly totals: ReadonlyMap<CurrencyCode, bigint>;
  readonly accounts: readonly { code: string; type: AccountType; posted: Money }[];
}

/** The database refused a write because it would break a ledger rule. */
export class LedgerRuleError extends Error {
  override readonly name = "LedgerRuleError";
}

export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
}

export class UnknownAccountError extends Error {
  override readonly name = "UnknownAccountError";
}

interface AccountRow {
  id: bigint;
  code: string;
  type: AccountType;
  currency: CurrencyCode;
  control: boolean;
  mirrored: boolean;
  parentId: bigint | null;
}

/** The database or a transaction on it. */
export type Executor = PgDatabase<NodePgQueryResultHKT, Record<string, never>>;

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const IDEMPOTENCY_CONSTRAINT = "journal_entries_idempotency_key_key";

/** The pg error behind a Drizzle error, if any. */
function pgErrorOf(error: unknown): { code: string; message: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; message?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        message: String(candidate.message),
        ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/** Turn a rule the database enforced into a typed error; rethrow the rest. */
function translate(error: unknown): never {
  const pgError = pgErrorOf(error);
  if (pgError && pgError.message.startsWith("ledger:")) {
    throw new LedgerRuleError(pgError.message.slice("ledger:".length).trim(), { cause: error });
  }
  if (pgError?.code === "23503" || pgError?.code === "23514") {
    throw new LedgerRuleError(pgError.message, { cause: error });
  }
  throw error;
}

function payloadHash(input: EntryInput): string {
  const canonical = JSON.stringify({
    description: input.description,
    status: input.status,
    at: input.at.toISOString(),
    ledgerBlock: input.ledgerBlock?.toString() ?? null,
    lines: input.lines.map((l) => [l.account, l.side, l.amount.currency, l.amount.minor.toString()]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const big = (value: unknown): bigint => BigInt(String(value ?? "0"));

/**
 * One participant's double-entry books (SPEC.md §4.3). The database enforces
 * the rules; this class validates early, maps errors and answers queries.
 */
export class Ledger {
  readonly schema: string;
  private readonly pool: pg.Pool;
  private readonly db: NodePgDatabase;
  private accountCache: Map<string, AccountRow> | undefined;

  private constructor(schema: string, pool: pg.Pool, db: NodePgDatabase) {
    this.schema = schema;
    this.pool = pool;
    this.db = db;
  }

  /** Connect to a participant's schema, creating and migrating it if needed. */
  static async open(options: LedgerOptions): Promise<Ledger> {
    if (!SCHEMA_PATTERN.test(options.schema)) {
      throw new RangeError(`Invalid schema name "${options.schema}"`);
    }
    const pool = new pg.Pool({
      connectionString: options.connectionString,
      options: `-c search_path=${options.schema}`,
      max: options.maxConnections ?? 4,
    });
    try {
      await migrate(pool, options.schema);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return new Ledger(options.schema, pool, drizzle({ client: pool }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Create the chart's accounts. Opening the same chart again is a no-op; an
   * account whose definition differs from the existing one is an error.
   */
  async openAccounts(chart: readonly AccountSpec[]): Promise<void> {
    const ordered = [...chart].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
    try {
      await this.db.transaction(async (tx) => {
        const existing = new Map(
          (await tx.select().from(accounts)).map((row) => [row.code, row]),
        );
        for (const spec of ordered) {
          const parent = spec.parent ? existing.get(spec.parent) : undefined;
          if (spec.parent && !parent) {
            throw new UnknownAccountError(`Parent "${spec.parent}" of "${spec.code}" does not exist`);
          }
          const current = existing.get(spec.code);
          if (current) {
            const same =
              current.type === spec.type &&
              current.currency === spec.currency &&
              current.control === spec.control &&
              current.mirrored === spec.mirrored &&
              current.parentId === (parent?.id ?? null);
            if (!same) {
              throw new LedgerRuleError(`Account "${spec.code}" exists with a different definition`);
            }
            continue;
          }
          const [row] = await tx
            .insert(accounts)
            .values({
              code: spec.code,
              name: spec.name,
              type: spec.type,
              currency: spec.currency,
              control: spec.control,
              mirrored: spec.mirrored,
              parentId: parent?.id ?? null,
            })
            .returning();
          if (row) existing.set(row.code, row);
        }
      });
    } catch (error) {
      translate(error);
    } finally {
      this.accountCache = undefined;
    }
  }

  private async accountMap(): Promise<Map<string, AccountRow>> {
    if (!this.accountCache) {
      const rows = await this.db.select().from(accounts);
      this.accountCache = new Map(
        rows.map((r) => [
          r.code,
          {
            id: r.id,
            code: r.code,
            type: r.type,
            currency: currencyCode(r.currency),
            control: r.control,
            mirrored: r.mirrored,
            parentId: r.parentId,
          },
        ]),
      );
    }
    return this.accountCache;
  }

  private async account(code: string): Promise<AccountRow> {
    const row = (await this.accountMap()).get(code);
    if (!row) throw new UnknownAccountError(`No account "${code}"`);
    return row;
  }

  /** Record a journal entry, pending or posted. Safe to retry. */
  async post(input: EntryInput): Promise<EntryResult> {
    try {
      return await this.db.transaction((tx) => this.postWith(tx, input));
    } catch (error) {
      const pgError = pgErrorOf(error);
      if (pgError?.code === "23505" && pgError.constraint === IDEMPOTENCY_CONSTRAINT) {
        // A concurrent call with the same key committed first.
        const winner = await this.matchEarlier(this.db, input.idempotencyKey, payloadHash(input));
        if (winner) return winner;
      }
      translate(error);
    }
  }

  /**
   * Run `fn` in one database transaction: the entries it posts, settles or
   * voids commit together with whatever else it writes through `tx.db`, or
   * none of it does. Rule violations surface as LedgerRuleError.
   */
  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction((db) => fn(new LedgerTx(this, db)));
    } catch (error) {
      translate(error);
    }
  }

  /** @internal */
  async postWith(db: Executor, input: EntryInput): Promise<EntryResult> {
    if (input.idempotencyKey.trim() === "") {
      throw new RangeError("An entry needs an idempotency key");
    }
    assertBalanced(input.lines);
    const hash = payloadHash(input);

    const earlier = await this.matchEarlier(db, input.idempotencyKey, hash);
    if (earlier) return earlier;

    const resolved: { line: Line; account: AccountRow }[] = [];
    for (const line of input.lines) {
      const account = await this.account(line.account);
      resolved.push({ line, account });
    }

    const [entry] = await db
      .insert(journalEntries)
      .values({
        idempotencyKey: input.idempotencyKey,
        payloadHash: hash,
        description: input.description,
        status: input.status,
        createdAt: input.at,
        postedAt: input.status === "posted" ? input.at : null,
        ledgerBlock: input.ledgerBlock ?? null,
      })
      .returning({ id: journalEntries.id });
    if (!entry) throw new Error("Insert returned no entry");
    await db.insert(journalLines).values(
      resolved.map(({ line, account }) => ({
        entryId: entry.id,
        accountId: account.id,
        currency: line.amount.currency,
        side: line.side,
        amount: line.amount.minor,
      })),
    );
    return { id: entry.id, replayed: false };
  }

  private async matchEarlier(db: Executor, key: string, hash: string): Promise<EntryResult | undefined> {
    const [row] = await db
      .select({ id: journalEntries.id, payloadHash: journalEntries.payloadHash })
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, key));
    if (!row) return undefined;
    if (row.payloadHash !== hash) {
      throw new IdempotencyConflictError(
        `Idempotency key "${key}" was already used for a different entry`,
      );
    }
    return { id: row.id, replayed: true };
  }

  /** Post a pending entry. Posting it again with the same block is a no-op. */
  async settle(entryId: bigint, options: { at: Date; ledgerBlock?: bigint }): Promise<void> {
    try {
      await this.settleWith(this.db, entryId, options);
    } catch (error) {
      translate(error);
    }
  }

  /** @internal */
  async settleWith(db: Executor, entryId: bigint, options: { at: Date; ledgerBlock?: bigint }): Promise<void> {
    const entry = await this.entryWith(db, entryId);
    if (entry.status === "posted" && entry.ledgerBlock === (options.ledgerBlock ?? null)) return;
    await db
      .update(journalEntries)
      .set({ status: "posted", postedAt: options.at, ledgerBlock: options.ledgerBlock ?? null })
      .where(eq(journalEntries.id, entryId));
  }

  /** Void a pending entry. Voiding it again is a no-op. */
  async void(entryId: bigint, options: { at: Date }): Promise<void> {
    try {
      await this.voidWith(this.db, entryId, options);
    } catch (error) {
      translate(error);
    }
  }

  /** @internal */
  async voidWith(db: Executor, entryId: bigint, options: { at: Date }): Promise<void> {
    const entry = await this.entryWith(db, entryId);
    if (entry.status === "voided") return;
    await db
      .update(journalEntries)
      .set({ status: "voided", voidedAt: options.at })
      .where(eq(journalEntries.id, entryId));
  }

  async entry(entryId: bigint): Promise<Entry> {
    return this.entryWith(this.db, entryId);
  }

  /** The entry recorded under an idempotency key, if any. */
  async entryByKey(key: string): Promise<Entry | undefined> {
    return this.entryByKeyWith(this.db, key);
  }

  /** @internal */
  async entryByKeyWith(db: Executor, key: string): Promise<Entry | undefined> {
    const [row] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, key));
    return row ? this.entryWith(db, row.id) : undefined;
  }

  /**
   * Recent entries, newest first, before an earlier page's last id; or the
   * entries under the given idempotency keys. Lines come in one query.
   */
  async entries(options: { limit: number; beforeId?: bigint; keys?: readonly string[] }): Promise<Entry[]> {
    const { limit, beforeId, keys } = options;
    const conditions = [
      ...(beforeId !== undefined ? [lt(journalEntries.id, beforeId)] : []),
      ...(keys ? [inArray(journalEntries.idempotencyKey, [...keys])] : []),
    ];
    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(journalEntries.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const lines = await this.db
      .select({
        entryId: journalLines.entryId,
        code: accounts.code,
        side: journalLines.side,
        currency: journalLines.currency,
        amount: journalLines.amount,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(inArray(journalLines.entryId, rows.map((r) => r.id)))
      .orderBy(journalLines.id);
    return rows.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      description: row.description,
      status: row.status,
      createdAt: row.createdAt,
      postedAt: row.postedAt,
      voidedAt: row.voidedAt,
      ledgerBlock: row.ledgerBlock,
      lines: lines
        .filter((l) => l.entryId === row.id)
        .map((l) => ({ account: l.code, side: l.side, amount: money(currencyCode(l.currency), l.amount) })),
    }));
  }

  /** @internal */
  async entryWith(db: Executor, entryId: bigint): Promise<Entry> {
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    if (!row) throw new RangeError(`No journal entry ${entryId}`);
    const lines = await db
      .select({
        code: accounts.code,
        side: journalLines.side,
        currency: journalLines.currency,
        amount: journalLines.amount,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(journalLines.entryId, entryId))
      .orderBy(journalLines.id);
    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      description: row.description,
      status: row.status,
      createdAt: row.createdAt,
      postedAt: row.postedAt,
      voidedAt: row.voidedAt,
      ledgerBlock: row.ledgerBlock,
      lines: lines.map((l) => ({
        account: l.code,
        side: l.side,
        amount: money(currencyCode(l.currency), l.amount),
      })),
    };
  }

  /** The database this participant's books live in, for tables of its own in the same schema. */
  get database(): Executor {
    return this.db;
  }

  /** The account definitions, for mapping on-chain holders to accounts. */
  async accountSpec(code: string): Promise<{ type: AccountType; currency: CurrencyCode; mirrored: boolean }> {
    const account = await this.account(code);
    return { type: account.type, currency: account.currency, mirrored: account.mirrored };
  }

  /**
   * The latest instant and block recorded. Instants and blocks never go
   * backwards, so an as-of answer for an instant before `instant` (or a block
   * before `block`) is final. One for `instant` itself is provisional: more
   * entries may still be recorded at that same instant.
   */
  async watermark(): Promise<{ instant: Date | null; block: bigint | null }> {
    const result = await this.db.execute(sql`
      SELECT CASE WHEN last_instant = '-infinity' THEN NULL ELSE last_instant END AS instant,
             CASE WHEN last_block < 0 THEN NULL ELSE last_block::text END AS block
        FROM ledger_clock
    `);
    const row = result.rows[0] ?? {};
    return {
      instant: row["instant"] == null ? null : new Date(String(row["instant"])),
      block: row["block"] == null ? null : big(row["block"]),
    };
  }

  /**
   * The balance of an account, or of a control account and everything under
   * it, as of an instant (default: everything recorded). Final for instants
   * before the watermark; see `watermark()`.
   */
  async balance(code: string, options: { asOf?: Date } = {}): Promise<Balance> {
    const account = await this.account(code);
    const asOf = options.asOf ? options.asOf.toISOString() : "infinity";
    const result = await this.db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM accounts WHERE id = ${account.id}
        UNION ALL
        SELECT a.id FROM accounts a JOIN subtree s ON a.parent_id = s.id
      ),
      lines AS (
        SELECT l.side, l.amount, e.created_at, e.posted_at, e.voided_at
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id IN (SELECT id FROM subtree)
      )
      SELECT
        coalesce(sum(CASE WHEN posted_at <= ${asOf}::timestamptz
                          THEN CASE side WHEN 'debit' THEN amount ELSE -amount END END), 0)::text AS posted,
        coalesce(sum(CASE WHEN side = 'debit' AND created_at <= ${asOf}::timestamptz
                           AND (posted_at IS NULL OR posted_at > ${asOf}::timestamptz)
                           AND (voided_at IS NULL OR voided_at > ${asOf}::timestamptz)
                          THEN amount END), 0)::text AS pending_debits,
        coalesce(sum(CASE WHEN side = 'credit' AND created_at <= ${asOf}::timestamptz
                           AND (posted_at IS NULL OR posted_at > ${asOf}::timestamptz)
                           AND (voided_at IS NULL OR voided_at > ${asOf}::timestamptz)
                          THEN amount END), 0)::text AS pending_credits
        FROM lines
    `);
    const row = result.rows[0] ?? {};
    const posted = normalBalance(account.type, account.currency, big(row["posted"]));
    const pendingDebits = money(account.currency, big(row["pending_debits"]));
    const pendingCredits = money(account.currency, big(row["pending_credits"]));
    const against = account.type === "asset" || account.type === "expense" ? pendingCredits : pendingDebits;
    return {
      account: code,
      posted,
      pendingDebits,
      pendingCredits,
      available: money(account.currency, posted.minor - against.minor),
    };
  }

  /**
   * The posted lines on an account (a leaf) with a posting instant in
   * (from, to], in posting order: what a statement for that period lists.
   */
  async movements(code: string, period: { from: Date; to: Date }): Promise<Movement[]> {
    const account = await this.account(code);
    const result = await this.db.execute(sql`
      SELECT e.id::text AS entry_id, e.idempotency_key, e.description, e.posted_at,
             e.ledger_block::text AS ledger_block, l.side, l.amount::text AS amount
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ${account.id}
         AND e.status = 'posted'
         AND e.posted_at > ${period.from.toISOString()}::timestamptz
         AND e.posted_at <= ${period.to.toISOString()}::timestamptz
       ORDER BY e.posted_at, e.id, l.id
    `);
    return result.rows.map((row) => ({
      entryId: big(row["entry_id"]),
      idempotencyKey: String(row["idempotency_key"]),
      description: String(row["description"]),
      postedAt: new Date(String(row["posted_at"])),
      ledgerBlock: row["ledger_block"] == null ? null : big(row["ledger_block"]),
      side: String(row["side"]) as "debit" | "credit",
      amount: money(account.currency, big(row["amount"])),
    }));
  }

  /**
   * The posted balance of a mirrored account (or control) after a block. The
   * reconciler compares this with the token balance at the same block.
   */
  async balanceAtBlock(code: string, block: bigint): Promise<Money> {
    const account = await this.account(code);
    if (!account.mirrored) {
      throw new RangeError(`"${code}" is not mirrored on the shared ledger`);
    }
    const result = await this.db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM accounts WHERE id = ${account.id}
        UNION ALL
        SELECT a.id FROM accounts a JOIN subtree s ON a.parent_id = s.id
      )
      SELECT coalesce(sum(CASE l.side WHEN 'debit' THEN l.amount ELSE -l.amount END), 0)::text AS total
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id IN (SELECT id FROM subtree)
         AND e.status = 'posted'
         AND e.ledger_block <= ${block.toString()}::bigint
    `);
    return normalBalance(account.type, account.currency, big(result.rows[0]?.["total"]));
  }

  /**
   * Every leaf balance after a block, mirrored or not, and the per-currency
   * total, which is zero. An entry counts if it was posted with that block or
   * an earlier one, or with no block (an opening entry, say) before anything
   * posted with a later block: instants and blocks never go backwards, so
   * that is the entry's place in the chain's order.
   */
  async trialBalanceAtBlock(block: bigint): Promise<TrialBalance> {
    const result = await this.db.execute(sql`
      WITH later AS (
        SELECT min(posted_at) AS t FROM journal_entries
         WHERE status = 'posted' AND ledger_block > ${block.toString()}::bigint
      ), counted AS (
        SELECT e.id FROM journal_entries e, later
         WHERE e.status = 'posted'
           AND (e.ledger_block <= ${block.toString()}::bigint
                OR (e.ledger_block IS NULL AND (later.t IS NULL OR e.posted_at < later.t)))
      )
      SELECT a.code, a.type, a.currency,
             coalesce(sum(CASE l.side WHEN 'debit' THEN l.amount ELSE -l.amount END)
                        FILTER (WHERE l.entry_id IN (SELECT id FROM counted)), 0)::text AS net
        FROM accounts a
        LEFT JOIN journal_lines l ON l.account_id = a.id
       WHERE NOT a.control
       GROUP BY a.id
       ORDER BY a.code
    `);
    const totals = new Map<CurrencyCode, bigint>();
    const rows = result.rows.map((row) => {
      const currency = currencyCode(String(row["currency"]));
      const type = String(row["type"]) as AccountType;
      const net = big(row["net"]);
      totals.set(currency, (totals.get(currency) ?? 0n) + net);
      return { code: String(row["code"]), type, posted: normalBalance(type, currency, net) };
    });
    return { totals, accounts: rows };
  }

  /** Every posted leaf balance and the per-currency total, which is zero. */
  async trialBalance(options: { asOf?: Date } = {}): Promise<TrialBalance> {
    const asOf = options.asOf ? options.asOf.toISOString() : "infinity";
    const result = await this.db.execute(sql`
      SELECT a.code, a.type, a.currency,
             coalesce(sum(CASE WHEN e.posted_at <= ${asOf}::timestamptz
                               THEN CASE l.side WHEN 'debit' THEN l.amount ELSE -l.amount END END), 0)::text AS net
        FROM accounts a
        LEFT JOIN journal_lines l ON l.account_id = a.id
        LEFT JOIN journal_entries e ON e.id = l.entry_id
       WHERE NOT a.control
       GROUP BY a.id
       ORDER BY a.code
    `);
    const totals = new Map<CurrencyCode, bigint>();
    const rows = result.rows.map((row) => {
      const currency = currencyCode(String(row["currency"]));
      const type = String(row["type"]) as AccountType;
      const net = big(row["net"]);
      totals.set(currency, (totals.get(currency) ?? 0n) + net);
      return { code: String(row["code"]), type, posted: normalBalance(type, currency, net) };
    });
    return { totals, accounts: rows };
  }
}

/** The ledger inside one database transaction; see `Ledger.transaction`. */
export class LedgerTx {
  readonly db: Executor;
  private readonly ledger: Ledger;

  constructor(ledger: Ledger, db: Executor) {
    this.ledger = ledger;
    this.db = db;
  }

  post(input: EntryInput): Promise<EntryResult> {
    return this.ledger.postWith(this.db, input);
  }

  settle(entryId: bigint, options: { at: Date; ledgerBlock?: bigint }): Promise<void> {
    return this.ledger.settleWith(this.db, entryId, options);
  }

  void(entryId: bigint, options: { at: Date }): Promise<void> {
    return this.ledger.voidWith(this.db, entryId, options);
  }

  entry(entryId: bigint): Promise<Entry> {
    return this.ledger.entryWith(this.db, entryId);
  }

  entryByKey(key: string): Promise<Entry | undefined> {
    return this.ledger.entryByKeyWith(this.db, key);
  }
}
