import type { ExpectStatic } from "vitest";
import type { KitReport } from "../src/index.ts";

/** Every fault's payment reached the engine: one refused by a participant first stages nothing. */
export function expectFaultsReachedTheEngine(expect: ExpectStatic, report: KitReport) {
  for (const r of report.runs) {
    const faults = r.trace.notes.filter((_, i) => "fault" in r.steps[i]!);
    expect(faults.filter((n) => /insufficient-funds|unknown-customer|invalid-flow|peer-unavailable/.test(n))).toEqual([]);
  }
}
