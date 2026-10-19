import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

/**
 * Create the schema and apply the ledger's SQL migrations to it, in name
 * order. Each runs in its own transaction and is recorded, so running this
 * again applies only what is new.
 *
 * Two processes may open the same fresh schema at once: a participant's
 * service and the harness's checker, say. So all of it runs under a Postgres
 * advisory lock keyed on the schema, and which migrations are done is read
 * only once the lock is held: one process migrates, the other waits and
 * finds nothing left to do.
 */
export async function migrate(pool: Pool, schema: string): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  const key = `oul-ledger:${schema}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ledger_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
         )`,
      );
      const done = new Set(
        (await client.query<{ name: string }>("SELECT name FROM ledger_migrations")).rows.map(
          (r) => r.name,
        ),
      );
      for (const file of files) {
        if (done.has(file)) continue;
        const text = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(text);
          await client.query("INSERT INTO ledger_migrations (name) VALUES ($1)", [file]);
          await client.query("COMMIT");
          applied.push(file);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    client.release();
  }
  return applied;
}
