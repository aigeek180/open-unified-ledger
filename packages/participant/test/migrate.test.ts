import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Ledger } from "@oul/ledger";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrateRuntime } from "../src/migrate.ts";

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";

/** The runtime's migrations, like the ledger's, run once when several open the same fresh schema at once. */
describe("the runtime's migrations from several pools at once", () => {
  const schema = `migrt_${randomBytes(6).toString("hex")}`;
  const raw = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  afterAll(async () => {
    await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await raw.end();
  });

  it("applies each once", async () => {
    const books = await Promise.all(Array.from({ length: 8 }, () => Ledger.open({ connectionString: DATABASE_URL, schema, maxConnections: 1 })));
    try {
      await Promise.all(books.map((b) => migrateRuntime(b)));
      const files = (await readdir(path.resolve(import.meta.dirname, "../migrations"))).filter((f) => f.endsWith(".sql"));
      const { rows } = await raw.query<{ name: string }>(`SELECT name FROM ${schema}.runtime_migrations ORDER BY name`);
      expect(rows.map((r) => r.name)).toEqual(files.sort());
    } finally {
      for (const b of books) await b.close();
    }
  });
});
