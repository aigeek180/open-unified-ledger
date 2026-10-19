import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Ledger tests each create their own Postgres schema; a long property run
    // is slower than a unit test.
    testTimeout: 120_000,
    // Concurrent tests (the conformance kit's engines) run two at a time: each holds Postgres connections for
    // every participant's books, and the server allows 100.
    maxConcurrency: 2,
  },
});
