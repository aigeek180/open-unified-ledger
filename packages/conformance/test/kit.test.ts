import path from "node:path";
import { convert, Decimal, minorUnit, money, parseRate, toDecimal } from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type CheckName,
  conformance,
  failing,
  formatReport,
  Generator,
  Model,
  Rng,
  roundingProbes,
  runChecks,
  runSteps,
  scriptedSteps,
  type Step,
} from "../src/index.ts";
import { type Defect, MemoryEngine } from "./memory-engine.ts";

/**
 * The kit against an engine in memory (SPEC.md §14): the clean engine
 * passes every check, scripted and seeded with every fault; each defect, the
 * same break as one of the sandbox's broken engines, fails the check named
 * for it, and shrinking finds a short sequence that still fails it. The
 * sandbox's real engine and its broken variants run on a chain in
 * sandbox.test.ts and broken.test.ts.
 */

const scenarios = new Map<string, Scenario>();
const scenario = (id: string) => scenarios.get(id)!;

beforeAll(async () => {
  for (const id of ["ca-interbank", "ca-us-pvp"]) {
    scenarios.set(id, await loadScenario(path.resolve(import.meta.dirname, `../../../scenarios/${id}`)));
  }
});

describe("the kit against a clean engine", () => {
  it("passes every check, scripted and seeded, with every fault", async () => {
    for (const id of ["ca-interbank", "ca-us-pvp"]) {
      const report = await conformance(new MemoryEngine(), scenario(id), { seeds: [1, 2, 3], steps: 30, faultRate: 0.3 });
      expect(report.passed, formatReport(report, scenario(id)).join("\n")).toBe(true);
      const scripted = report.runs[0]!;
      const status = Object.fromEntries(scripted.checks.map((c) => [c.name, c.status]));
      expect(status).toEqual({
        atomicity: "pass",
        "exactly-once": "pass",
        authority: "pass",
        eligibility: "pass",
        "supply-equals-liability": "pass",
        "liability-conservation": "pass",
        "books-equal-ledger": "pass",
        "fx-consistency": id === "ca-us-pvp" ? "pass" : "skipped",
        "repo-collateral": "skipped",
      });
      // Every fault was staged in the scripted run, none skipped.
      expect(scripted.trace.notes.filter((n) => n.startsWith("skipped"))).toEqual([]);
    }
  });

  it("proposes the same steps for the same seed", () => {
    const steps = (seed: number) => {
      const model = new Model(scenario("ca-us-pvp"));
      const generator = new Generator(model, new Rng(seed), new MemoryEngine().capabilities, 0.3);
      return Array.from({ length: 25 }, () => {
        const step = generator.next();
        if ("flow" in step) model.apply(step.flow, { status: "settled" });
        return step;
      });
    };
    const show = (s: Step[]) => JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(show(steps(7))).toBe(show(steps(7)));
    expect(show(steps(7))).not.toBe(show(steps(8)));
  });
});

/** Each defect, and every check the kit fails it on: the named check first. */
const BROKEN: readonly { defect: Defect; scenario: string; named: CheckName; fails: readonly CheckName[] }[] = [
  { defect: "split-legs", scenario: "ca-interbank", named: "atomicity", fails: ["atomicity", "supply-equals-liability", "books-equal-ledger"] },
  { defect: "no-once", scenario: "ca-interbank", named: "exactly-once", fails: ["exactly-once", "supply-equals-liability", "books-equal-ledger"] },
  { defect: "lax-mint", scenario: "ca-interbank", named: "authority", fails: ["authority", "supply-equals-liability", "books-equal-ledger"] },
  { defect: "open-deposit", scenario: "ca-interbank", named: "eligibility", fails: ["eligibility"] },
  { defect: "book-refused", scenario: "ca-interbank", named: "books-equal-ledger", fails: ["supply-equals-liability", "books-equal-ledger"] },
  { defect: "round-twice", scenario: "ca-us-pvp", named: "fx-consistency", fails: ["fx-consistency"] },
];

describe("the kit against each broken engine", () => {
  for (const broken of BROKEN) {
    it(`fails ${broken.defect} on ${broken.named}`, async () => {
      const s = scenario(broken.scenario);
      const report = await conformance(new MemoryEngine([broken.defect]), s, { shrinkBudget: 40 });
      const run = report.runs[0]!;
      expect(report.passed).toBe(false);
      expect(failing(run.checks), formatReport(report, s).join("\n")).toEqual(broken.fails);
      // Shrinking keeps the first failing check failing, on far fewer steps.
      expect(run.minimal?.check).toBe(broken.fails[0]);
      expect(run.minimal!.steps.length).toBeLessThan(run.steps.length / 4);
      const again = runChecks(await runSteps(new MemoryEngine([broken.defect]), s, run.minimal!.steps));
      expect(failing(again)).toContain(broken.named);
    });
  }

  it("finds each broken engine on seeded runs with faults too", async () => {
    for (const broken of BROKEN) {
      const s = scenario(broken.scenario);
      const report = await conformance(new MemoryEngine([broken.defect]), s, { scripted: false, seeds: [1, 2, 3, 4, 5, 6], steps: 30, faultRate: 0.4, shrinkBudget: 0 });
      const caught = report.runs.filter((r) => failing(r.checks).includes(broken.named));
      expect(caught.length, `${broken.defect} caught by ${broken.named} in a seeded run`).toBeGreaterThan(0);
    }
  });
});

describe("rounding probes", () => {
  it("land on, just below and just above half a minor unit, and expose rounding twice", () => {
    const probes = roundingProbes("CAD", "USD", "0.7315");
    expect(probes.length).toBe(6);
    const twice = (s: bigint) => {
      const exact = toDecimal(money("CAD", s)).times(parseRate("0.7315")).times(new Decimal(10).toPower(minorUnit("USD")));
      return BigInt(exact.toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
    };
    const once = (s: bigint) => convert(money("CAD", s), "0.7315", "USD").minor;
    expect(probes.some((s) => twice(s) !== once(s))).toBe(true);
  });

  it("are part of the scripted run in each direction", () => {
    const steps = scriptedSteps(scenario("ca-us-pvp"), new MemoryEngine().capabilities);
    const fx = steps.filter((s) => "flow" in s && s.flow.kind === "pay-fx");
    expect(fx.length).toBe(roundingProbes("CAD", "USD", "0.7315").length + roundingProbes("USD", "CAD", "1.3642").length);
  });
});
