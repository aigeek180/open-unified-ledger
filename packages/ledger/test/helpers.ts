import { randomBytes } from "node:crypto";
import pg from "pg";
import { Ledger } from "../src/index.ts";

export const DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";

/** A ledger in a fresh schema, dropped by `dispose`. */
export async function testLedger(prefix = "t"): Promise<{
  ledger: Ledger;
  /** Raw SQL against the same schema, bypassing the Ledger class. */
  raw: pg.Pool;
  dispose: () => Promise<void>;
}> {
  const schema = `${prefix}_${randomBytes(6).toString("hex")}`;
  const ledger = await Ledger.open({ connectionString: DATABASE_URL, schema });
  const raw = new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 2,
  });
  return {
    ledger,
    raw,
    dispose: async () => {
      await ledger.close();
      await raw.query(`DROP SCHEMA ${schema} CASCADE`);
      await raw.end();
    },
  };
}

/** Instants one second apart from a fixed origin, for readable tests. */
export function clock(start = Date.UTC(2026, 10, 2, 14, 0, 0)) {
  let now = start;
  return {
    now: () => new Date(now),
    tick: (seconds = 1) => {
      now += seconds * 1000;
      return new Date(now);
    },
  };
}
