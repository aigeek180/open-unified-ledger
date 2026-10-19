import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Ledger } from "@oul/ledger";
import { sql } from "drizzle-orm";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

/**
 * Apply the runtime's migrations to the participant's schema, after the
 * ledger's own: all in one transaction, under an advisory lock on the schema
 * taken before reading which are done, so two processes opening the same
 * fresh schema at once never both apply one.
 */
export async function migrateRuntime(books: Ledger): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  await books.database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`oul-runtime:${books.schema}`}))`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS runtime_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const done = new Set((await tx.execute(sql`SELECT name FROM runtime_migrations`)).rows.map((r) => String(r["name"])));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.execute(sql.raw(await readFile(path.join(MIGRATIONS_DIR, file), "utf8")));
      await tx.execute(sql`INSERT INTO runtime_migrations (name) VALUES (${file})`);
    }
  });
}
