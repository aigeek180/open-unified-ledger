import { sql } from "drizzle-orm";
import { bigint, boolean, char, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Drizzle's view of the tables in migrations/0001_ledger.sql, which is the
 * source of truth: the constraints and triggers that keep the books correct
 * live there. Tables are unqualified; each participant's books are a
 * Postgres schema chosen by the connection's search_path.
 */

export const accounts = pgTable("accounts", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: text("type").$type<"asset" | "liability" | "equity" | "income" | "expense">().notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  control: boolean("control").notNull(),
  mirrored: boolean("mirrored").notNull(),
  parentId: bigint("parent_id", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  postable: boolean("postable").generatedAlwaysAs(sql`NOT control`),
});

export const journalEntries = pgTable("journal_entries", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  description: text("description").notNull(),
  status: text("status").$type<"pending" | "posted" | "voided">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  ledgerBlock: bigint("ledger_block", { mode: "bigint" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journalLines = pgTable("journal_lines", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  entryId: bigint("entry_id", { mode: "bigint" }).notNull(),
  accountId: bigint("account_id", { mode: "bigint" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  side: text("side").$type<"debit" | "credit">().notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  postable: boolean("postable").generatedAlwaysAs(sql`true`),
});
