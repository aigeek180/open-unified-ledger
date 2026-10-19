import path from "node:path";
import { anvilPath } from "@oul/chain/testing";
import { loadScenario, type Scenario } from "@oul/scenario";
import { afterAll, describe, type ExpectStatic, it } from "vitest";
import { conformance, formatReport, type KitReport } from "../src/index.ts";
import { SandboxAdapter } from "../src/sandbox/index.ts";
import { expectFaultsReachedTheEngine } from "./expect.ts";

/**
 * The kit against the sandbox's own engine (SPEC.md §14): the real
 * contracts on a fresh Anvil for each run, and every participant's real
 * runtime with its books in Postgres. It must pass every check on the
 * scripted run, with every fault, in one currency, across two, and with a
 * bond's whole life; and on seeded runs with faults mixed in. `pnpm
 * conformance` runs the same on the Besu network.
 */

// Each run has its own Anvil and its own schemas, so the three scenarios run at once.
// Two at a time (vitest.config.ts): each engine holds Postgres connections for every participant's books.
const run = anvilPath() ? describe.concurrent : describe.skip;
const load = (id: string) => loadScenario(path.resolve(import.meta.dirname, `../../../scenarios/${id}`));
const adapters: SandboxAdapter[] = [];

function expectPassed(expect: ExpectStatic, report: KitReport, scenario: Scenario) {
  if (process.env["OUL_LOG"]) console.log(formatReport(report, scenario).join("\n"));
  expect(report.passed, formatReport(report, scenario).join("\n")).toBe(true);
  for (const r of report.runs) expect(r.trace.notes.filter((n) => n.startsWith("skipped"))).toEqual([]);
  expectFaultsReachedTheEngine(expect, report);
}


run("the conformance kit against the sandbox's engine", () => {
  afterAll(async () => {
    for (const adapter of adapters) await adapter.close();
  });

  const kit = async (id: string, options: Parameters<typeof conformance>[2]) => {
    const scenario = await load(id);
    const adapter = new SandboxAdapter();
    adapters.push(adapter);
    const report = await conformance(adapter, scenario, options);
    return { scenario, report };
  };

  it("passes every check on ca-interbank, scripted with every fault and on seeded runs", async ({ expect }) => {
    const { scenario, report } = await kit("ca-interbank", { seeds: [1, 2], steps: 15, faultRate: 0.3, shrinkBudget: 0 });
    expectPassed(expect, report, scenario);
    const scripted = report.runs[0]!;
    expect(Object.fromEntries(scripted.checks.map((c) => [c.name, c.status]))).toEqual({
      atomicity: "pass",
      "exactly-once": "pass",
      authority: "pass",
      eligibility: "pass",
      "supply-equals-liability": "pass",
      "liability-conservation": "pass",
      "books-equal-ledger": "pass",
      "fx-consistency": "skipped",
      "repo-collateral": "skipped",
    });
    // Every fault refused what it sent around the participants, with the engine's own reason.
    const notes = scripted.trace.notes.join("\n");
    expect(notes).toMatch(/resubmitted on chain: AlreadySettled/);
    expect(notes).toMatch(/approval for other legs: InvalidApproval; past its deadline: InstructionExpired/);
    expect(notes).toMatch(/signature: MissingApproval/);
    expect(notes).toMatch(/frozen: refused by the engine: ERC20InsufficientUnfrozenBalance/);
    expect(notes).toMatch(/allowlist: refused by the engine: ERC20UserRestricted/);
  }, 600_000);

  it("passes every check on ca-us-pvp, across two currencies at rounding edges", async ({ expect }) => {
    const { scenario, report } = await kit("ca-us-pvp", { seeds: [3], steps: 15, faultRate: 0.3, shrinkBudget: 0 });
    expectPassed(expect, report, scenario);
    expect(report.runs[0]!.checks.find((c) => c.name === "fx-consistency")?.status).toBe("pass");
  }, 600_000);

  it("passes every check on ca-bond-dvp, through a bond's whole life", async ({ expect }) => {
    const { scenario, report } = await kit("ca-bond-dvp", { seeds: [4], steps: 15, faultRate: 0.3, shrinkBudget: 0 });
    expectPassed(expect, report, scenario);
    const flows = report.runs[0]!.trace.flows;
    const kinds = flows.filter((f) => f.outcome.status === "settled").map((f) => f.flow.kind);
    const refused = flows.filter((f) => f.flow.kind.startsWith("bond-") && f.outcome.status === "refused").map((f) => `${f.flow.kind}: ${f.outcome.reason}`);
    expect(kinds.filter((k) => k === "bond-payment").length, refused.join("\n")).toBe(10);
    expect(kinds).toContain("bond-trade");
  }, 600_000);

  it("passes every check on ca-repo, through a repo's whole life", async ({ expect }) => {
    const { scenario, report } = await kit("ca-repo", { seeds: [5], steps: 20, faultRate: 0.3, shrinkBudget: 0 });
    expectPassed(expect, report, scenario);
    const scripted = report.runs[0]!;
    expect(scripted.checks.find((c) => c.name === "repo-collateral")).toMatchObject({ status: "pass", summary: expect.stringMatching(/records in books equal to the ledger/) });
    const settled = scripted.trace.flows.filter((f) => f.outcome.status === "settled").map((f) => f.flow.kind);
    const refused = scripted.trace.flows.filter((f) => f.flow.kind.startsWith("repo-") && f.outcome.status === "refused").map((f) => `${f.flow.kind}: ${f.outcome.reason}`);
    for (const kind of ["repo-open", "repo-margin", "repo-substitute", "repo-close"] as const) expect(settled, refused.join("\n")).toContain(kind);
  }, 600_000);
});
