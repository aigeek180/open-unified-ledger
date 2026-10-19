import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { REPO_ROOT } from "@oul/chain";
import { formatMoney, money } from "@oul/domain";
import {
  COORDINATORS,
  type CoordinatorName,
  EXPECTED,
  type Fault,
  faultStory,
} from "./coordinators.ts";
import { type InteropWorld, newTransfer, sleep } from "./ledgers.ts";
import { type Change, Recorder, type Summary } from "./recorder.ts";

/** One coordinator under one fault, start to finish, with every leg's state over time. */
export interface CaseResult {
  readonly coordinator: CoordinatorName;
  readonly fault: Fault;
  readonly story: string;
  readonly expected: "committed" | "aborted" | "inconsistent";
  readonly outcome: Summary["outcome"];
  readonly matches: boolean;
  readonly uetr: string;
  readonly amount: string;
  readonly currency: string;
  /** Across currencies, what the payee's bank is paid, at the dealer's rate. */
  readonly target?: { readonly amount: string; readonly currency: string };
  readonly startedAt: string;
  readonly durationMs: number;
  readonly summary: Summary;
  readonly changes: readonly Change[];
  readonly events: readonly { ms: number; actor: string; text: string }[];
}

export interface InteropReport {
  readonly scenario: string;
  readonly at: string;
  readonly chains: { readonly ledger1: number; readonly ledger2: number };
  /** What each part holds, for the console's lanes: the legs on the shared ledger, on ledger 1, on ledger 2. */
  readonly parts: { readonly shared: string; readonly ledger1: string; readonly ledger2: string };
  /** Across currencies: the dealer's name and the two currencies, ledger 1's and ledger 2's. */
  readonly fx?: { readonly dealer: string; readonly from: string; readonly to: string };
  readonly cases: readonly CaseResult[];
}

/** What each part of a transfer holds, in words, for this world. */
export function partLabels(world: InteropWorld): InteropReport["parts"] {
  if (!world.dealer) {
    return { shared: "Shared ledger · all three legs", ledger1: "Ledger 1 · payer's burn and wholesale", ledger2: "Ledger 2 · payee's mint" };
  }
  const [from, to] = [world.currency, world.targetCurrency];
  return {
    shared: `Shared ledger · all four legs, ${from} and ${to}`,
    ledger1: `Ledger 1 · ${from}: payer's burn, wholesale to the dealer`,
    ledger2: `Ledger 2 · ${to}: dealer's wholesale, payee's mint`,
  };
}

export const RUNS_DIR = path.join(REPO_ROOT, "sim/runs/interop");

export async function runCase(
  world: InteropWorld,
  coordinator: CoordinatorName,
  fault: Fault,
  options: { amount: bigint; uetr?: string; print?: (line: string) => void },
): Promise<CaseResult> {
  const transfer = newTransfer(world, options.amount, options.uetr);
  const startedAt = new Date().toISOString();
  const recorder = new Recorder(world, transfer.id, coordinator === "unified" ? "unified" : "split");
  const events: { ms: number; actor: string; text: string }[] = [];
  const note = (actor: string, text: string) => {
    events.push({ ms: recorder.elapsed(), actor, text });
    options.print?.(`[${coordinator}/${fault}] ${(recorder.elapsed() / 1000).toFixed(1).padStart(5)}s ${actor}: ${text}`);
  };
  recorder.start();
  await mkdir(RUNS_DIR, { recursive: true });
  try {
    await COORDINATORS[coordinator]({ world, transfer, fault, note, notaryLog: path.join(RUNS_DIR, "notary.log") });
  } catch (error) {
    note("runner", `stopped by an error: ${(error as Error).message}`);
  }
  // Give the last state changes a moment to be seen.
  for (let i = 0; i < 12 && !recorder.done(); i++) await sleep(500);
  await recorder.stop();
  const summary = recorder.summary();
  const expected = EXPECTED[coordinator][fault];
  return {
    coordinator,
    fault,
    story: faultStory(world, coordinator, fault),
    expected,
    outcome: summary.outcome,
    matches: summary.outcome === expected,
    uetr: transfer.uetr,
    amount: formatMoney(money(world.currency, options.amount)),
    currency: world.currency,
    ...(world.dealer ? { target: { amount: formatMoney(money(world.targetCurrency, transfer.target)), currency: world.targetCurrency } } : {}),
    startedAt,
    durationMs: recorder.elapsed(),
    summary,
    changes: recorder.changes,
    events,
  };
}

/** Keep a report where the console reads it: sim/runs/interop/latest.json, and one file per run. */
export async function saveReport(report: InteropReport): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const file = path.join(RUNS_DIR, `${report.at.replaceAll(":", "-")}.json`);
  await writeFile(file, body);
  await writeFile(path.join(RUNS_DIR, "latest.json"), body);
  return file;
}
