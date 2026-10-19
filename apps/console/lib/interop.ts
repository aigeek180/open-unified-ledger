import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Interop runs as `pnpm interop` saved them (services/coordinator, SPEC.md
 * §7): the console reads the files and draws them; it runs nothing itself.
 */

// Read at request time from the repository, never bundled or traced.
const RUNS = process.env["OUL_INTEROP_RUNS"] ?? path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../sim/runs/interop");

export type PartKey = "shared" | "ledger1" | "ledger2";
export type LockState = "none" | "locked" | "settled" | "released";
export type Outcome = "committed" | "aborted" | "inconsistent" | "stuck";

export interface InteropCase {
  coordinator: "unified" | "htlc" | "notary";
  fault: "none" | "coordinator-crash" | "message-loss" | "participant-offline" | "late-commit";
  story: string;
  expected: "committed" | "aborted" | "inconsistent";
  outcome: Outcome;
  matches: boolean;
  uetr: string;
  amount: string;
  currency: string;
  /** Across currencies, what the payee's bank is paid, at the dealer's rate. */
  target?: { amount: string; currency: string };
  startedAt: string;
  durationMs: number;
  summary: {
    outcome: Outcome;
    final: Record<string, LockState>;
    disagreedMs: number | null;
    disagreesAtEnd: boolean;
    finalAtMs: number | null;
  };
  changes: { part: PartKey; state: LockState; ms: number; block: string; chainTime: string }[];
  events: { ms: number; actor: string; text: string }[];
}

export interface InteropReport {
  scenario: string;
  at: string;
  chains: { ledger1: number; ledger2: number };
  /** What each part holds, in words; runs saved before parts were named fall back to PART_LABEL. */
  parts?: Record<PartKey, string>;
  /** Across currencies (SPEC.md §13): the dealer's name, ledger 1's currency and ledger 2's. */
  fx?: { dealer: string; from: string; to: string };
  cases: InteropCase[];
}

export const runsDir = RUNS;

/** Saved runs, newest first, by the file names `pnpm interop` gives them. */
export async function listReports(): Promise<string[]> {
  const files = await readdir(/* turbopackIgnore: true */ RUNS).catch(() => [] as string[]);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}T[\d-]+(\.\d+)?Z\.json$/.test(f))
    .sort()
    .reverse();
}

/** A saved run by file name, or the latest. Undefined if there is none. */
export async function readReport(file?: string): Promise<InteropReport | undefined> {
  const name = file && (await listReports()).includes(file) ? file : "latest.json";
  try {
    return JSON.parse(await readFile(path.join(/* turbopackIgnore: true */ RUNS, name), "utf8")) as InteropReport;
  } catch {
    return undefined;
  }
}

export const caseKey = (c: Pick<InteropCase, "coordinator" | "fault">) => `${c.coordinator}.${c.fault}`;

export const COORDINATOR_LABEL: Record<InteropCase["coordinator"], string> = {
  unified: "Unified",
  htlc: "HTLC",
  notary: "Notary 2PC",
};

export const FAULT_LABEL: Record<InteropCase["fault"], string> = {
  none: "No fault",
  "coordinator-crash": "Coordinator crash",
  "message-loss": "Message loss",
  "participant-offline": "Participant offline",
  "late-commit": "Late commit",
};

export const PART_LABEL: Record<PartKey, string> = {
  shared: "Shared ledger · all three legs",
  ledger1: "Ledger 1 · payer's burn and wholesale",
  ledger2: "Ledger 2 · payee's mint",
};
