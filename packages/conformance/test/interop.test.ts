import path from "node:path";
import { anvilPath } from "@oul/chain/testing";
import { COORDINATOR_NAMES, type CoordinatorName, EXPECTED } from "@oul/coordinator";
import { loadScenario } from "@oul/scenario";
import { afterAll, describe, it } from "vitest";
import { conformance, failing, formatReport } from "../src/index.ts";
import { InteropAdapter } from "../src/interop/index.ts";

/**
 * Interop mode's coordinators under the conformance kit (SPEC.md §14): the
 * scripted run, every payment on the interop route and each of §7's faults
 * once, observed on both ledgers. Atomicity must fail for exactly the faults
 * where §7 says the coordinator leaves the ledgers disagreeing, and every
 * other check the kit can run without books must pass: in one currency, and
 * across two, where the payments are made at the rounding edges and one
 * currency is delivered on each ledger.
 */

const run = anvilPath() ? describe.concurrent : describe.skip;
const adapters: InteropAdapter[] = [];
const only = process.env["OUL_COORDINATOR"]?.split(",") as CoordinatorName[] | undefined;
const scenarios = process.env["OUL_INTEROP_SCENARIOS"]?.split(",") ?? ["ca-interbank", "ca-us-pvp"];

run("interop coordinators under the conformance kit", () => {
  afterAll(async () => {
    for (const adapter of adapters) await adapter.close();
  });

  for (const id of scenarios) {
    for (const coordinator of only ?? COORDINATOR_NAMES) {
      const inconsistent = Object.entries(EXPECTED[coordinator])
        .filter(([, outcome]) => outcome === "inconsistent")
        .map(([fault]) => fault);
      it(`${coordinator} on ${id} fails atomicity exactly where SPEC.md §7 says: ${inconsistent.join(", ") || "nowhere"}`, async ({ expect }) => {
        const scenario = await loadScenario(path.resolve(import.meta.dirname, `../../../scenarios/${id}`));
        const adapter = new InteropAdapter({ coordinator, ...(process.env["OUL_LOG"] ? { log: (line: string) => console.log(line) } : {}) });
        adapters.push(adapter);
        const report = await conformance(adapter, scenario, { shrinkBudget: 0 });
        const shown = formatReport(report, scenario).join("\n");
        if (process.env["OUL_LOG"]) console.log(shown);
        const scripted = report.runs[0]!;
        // Every fault was staged, none skipped.
        expect(scripted.trace.notes.filter((n) => n.startsWith("skipped")), shown).toEqual([]);
        const atomicity = scripted.checks.find((c) => c.name === "atomicity")!;
        // The faults whose payment atomicity reports partly settled.
        const broken = scripted.steps
          .filter((s) => "fault" in s)
          .filter((s) => atomicity.failures.some((f) => f.startsWith((s as { fault: { flow: { id: string } } }).fault.flow.id)))
          .map((s) => (s as { fault: { fault: string } }).fault.fault);
        expect(broken.sort(), shown).toEqual([...inconsistent].sort());
        // Nothing else fails: no payment without a fault is ever partly settled.
        expect(atomicity.failures.length, shown).toBe(inconsistent.length);
        expect(failing(scripted.checks), shown).toEqual(inconsistent.length ? ["atomicity"] : []);
        if (scenario.fx) expect(scripted.checks.find((c) => c.name === "fx-consistency")?.status, shown).toBe("pass");
      }, 900_000);
    }
  }
});
