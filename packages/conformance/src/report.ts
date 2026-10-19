import type { Scenario } from "@oul/scenario";
import { describeStep } from "./flows.ts";
import type { KitReport, RunResult } from "./runner.ts";

/** A report in lines, for a terminal: each run's checks, what failed, and the smallest failing sequence. */
export function formatReport(report: KitReport, scenario: Scenario, command?: (run: RunResult) => string): string[] {
  const lines = [`Conformance: ${report.engine} on ${report.scenario}: ${report.passed ? "passed" : "FAILED"}`];
  for (const run of report.runs) {
    lines.push(`  ${run.label}: ${run.steps.length} steps in ${(run.durationMs / 1000).toFixed(1)}s`);
    for (const check of run.checks) {
      const mark = check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "–";
      lines.push(`    ${mark} ${check.name.padEnd(24)} (${check.invariants.padEnd(11)}) ${check.status === "fail" ? "" : check.summary}`);
      for (const failure of check.failures) lines.push(`        ${failure}`);
    }
    if (run.minimal) {
      const { minimal } = run;
      lines.push(
        `    smallest sequence found that fails ${minimal.check}: ${minimal.steps.length} of ${run.steps.length} steps, after ${minimal.replays} fresh runs${minimal.budgetSpent ? " (the shrinking budget ran out)" : ""}`,
      );
      for (const [n, step] of minimal.steps.entries()) lines.push(`      ${n + 1}. ${describeStep(step, scenario)}`);
    }
    if (command && run.checks.some((c) => c.status === "fail")) lines.push(`    reproduce: ${command(run)}`);
  }
  return lines;
}

/** A report as JSON, amounts as strings, without the raw observations. */
export function reportJson(report: KitReport): string {
  const runs = report.runs.map(({ trace, ...run }) => ({ ...run, notes: trace.notes }));
  return JSON.stringify({ ...report, runs }, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2);
}
