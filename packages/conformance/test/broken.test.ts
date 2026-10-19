import path from "node:path";
import { anvilPath } from "@oul/chain/testing";
import { loadScenario } from "@oul/scenario";
import { afterAll, describe, it } from "vitest";
import { type CheckName, conformance, failing, formatReport } from "../src/index.ts";
import { BROKEN_ENGINES, type BrokenEngineName, SandboxAdapter } from "../src/sandbox/index.ts";
import { expectFaultsReachedTheEngine } from "./expect.ts";

/**
 * Proof that the kit catches failures (SPEC.md §14): each of the sandbox's
 * deliberately broken engines, run through the kit's scripted run on a
 * fresh Anvil, fails the check named for it. Each break also fails the
 * checks listed with it, for the reason docs/conformance.md gives; no other
 * check fails. The real engine passes every check in sandbox.test.ts.
 */

// Two at a time (vitest.config.ts): each engine holds Postgres connections for every participant's books.
const run = anvilPath() ? describe.concurrent : describe.skip;
const adapters: SandboxAdapter[] = [];

/** Every check each broken engine fails, the one named for it first. */
const FAILS: Record<BrokenEngineName, readonly CheckName[]> = {
  "split-legs": ["atomicity", "supply-equals-liability", "books-equal-ledger"],
  "no-once": ["exactly-once", "supply-equals-liability", "books-equal-ledger"],
  "lax-mint": ["authority", "supply-equals-liability", "books-equal-ledger"],
  "open-deposit": ["eligibility"],
  "book-refused": ["supply-equals-liability", "books-equal-ledger"],
  "round-fx-twice": ["fx-consistency"],
  "repo-interest-360": ["repo-collateral"],
};

run("the conformance kit against each broken engine", () => {
  afterAll(async () => {
    for (const adapter of adapters) await adapter.close();
  });

  for (const broken of BROKEN_ENGINES) {
    it(`fails "${broken.name}" (${broken.breaks}) on ${broken.check}`, async ({ expect }) => {
      const scenario = await loadScenario(path.resolve(import.meta.dirname, `../../../scenarios/${broken.scenario}`));
      const adapter = new SandboxAdapter({ broken: broken.name });
      adapters.push(adapter);
      const report = await conformance(adapter, scenario, { shrinkBudget: 0 });
      const shown = formatReport(report, scenario).join("\n");
      if (process.env["OUL_LOG"]) console.log(shown);
      expect(report.passed).toBe(false);
      expectFaultsReachedTheEngine(expect, report);
      const failed = failing(report.runs[0]!.checks);
      expect(failed, shown).toContain(broken.check);
      expect([...failed].sort(), shown).toEqual([...FAILS[broken.name]].sort());
    }, 600_000);
  }
});
