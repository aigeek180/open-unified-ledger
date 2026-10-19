import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/index.ts";
import { DATABASE_URL } from "./helpers.ts";

/**
 * Two processes opening the same fresh schema at once, as a participant's
 * service and the harness's checker do on a fresh deployment: the migrations
 * run once, under an advisory lock on the schema, and every opener gets a
 * working ledger.
 */
describe("opening one fresh schema from several pools at once", () => {
  const schema = `mig_${randomBytes(6).toString("hex")}`;
  const raw = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  afterAll(async () => {
    await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await raw.end();
  });

  it("migrates once, and every opener gets the ledger", async () => {
    const ledgers = await Promise.all(Array.from({ length: 8 }, () => Ledger.open({ connectionString: DATABASE_URL, schema, maxConnections: 1 })));
    try {
      const files = (await readdir(path.resolve(import.meta.dirname, "../migrations"))).filter((f) => f.endsWith(".sql"));
      const { rows } = await raw.query<{ name: string }>(`SELECT name FROM ${schema}.ledger_migrations ORDER BY name`);
      expect(rows.map((r) => r.name)).toEqual(files.sort());
      for (const ledger of ledgers) expect((await ledger.trialBalance()).accounts).toEqual([]);
    } finally {
      for (const ledger of ledgers) await ledger.close();
    }
  });
});
