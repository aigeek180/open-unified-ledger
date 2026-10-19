/**
 * Interop mode's runner (SPEC.md §7):
 *
 *   pnpm interop [scenario]                                 every coordinator under every fault
 *   pnpm interop [scenario] --coordinator htlc              one coordinator under every fault
 *   pnpm interop [scenario] --fault participant-offline     every coordinator under one fault
 *   pnpm interop [scenario] --serial --verbose              one case at a time, narrating as it goes
 *
 * Needs both ledgers up and deployed (README: interop mode). Cases run at
 * once by default, each with its own UETR; each records every leg's state on
 * both ledgers over time, and must end as SPEC.md §7 says its coordinator
 * does: the unified mode in no failure window, the others in theirs. Writes
 * sim/runs/interop/latest.json for the console.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@oul/chain";
import { formatMoney, money, parseMoney } from "@oul/domain";
import { loadScenario } from "@oul/scenario";
import { COORDINATOR_NAMES, type CoordinatorName, FAULT_NAMES, type Fault } from "./coordinators.ts";
import { InteropWorld } from "./ledgers.ts";
import { type CaseResult, partLabels, runCase, saveReport } from "./run.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const scenarioArg = positional[0] ?? "ca-interbank";
const scenarioDir = existsSync(path.join(REPO_ROOT, "scenarios", scenarioArg)) ? path.join(REPO_ROOT, "scenarios", scenarioArg) : path.resolve(scenarioArg);
const only = option("coordinator") as CoordinatorName | undefined;
const fault = option("fault") as Fault | undefined;
const serial = args.includes("--serial");
const verbose = args.includes("--verbose");

if (only && !COORDINATOR_NAMES.includes(only)) throw new Error(`--coordinator is one of ${COORDINATOR_NAMES.join(", ")}`);
if (fault && !FAULT_NAMES.includes(fault)) throw new Error(`--fault is one of ${FAULT_NAMES.join(", ")}`);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const scenario = await loadScenario(scenarioDir);
const world = await InteropWorld.open(scenario);
const cases = (only ? [only] : COORDINATOR_NAMES).flatMap((c) => (fault ? [fault] : FAULT_NAMES).map((f) => [c, f] as const));
const amount = parseMoney(world.currency, "2500.00").minor;

console.log(bold(`\nInterop mode: ${scenario.id}, ledger 1 chain ${world.l1.network.chainId}, ledger 2 chain ${world.l2.network.chainId}`));
if (world.dealer) {
  const target = formatMoney(money(world.targetCurrency, world.targetOf(amount)));
  console.log(dim(`  across currencies: ${world.currency} on ledger 1, ${world.targetCurrency} on ledger 2, ${world.currency} ${formatMoney(money(world.currency, amount))} = ${world.targetCurrency} ${target} through ${world.dealer}`));
  console.log(dim("  where the ledgers end disagreeing, one currency was delivered and the other not: FX settlement risk"));
}
console.log(dim(`  ${cases.length} cases${serial ? ", one at a time" : ", at once"}; a few minutes of ledger time at most\n`));
await world.fund(amount * BigInt(cases.length + 1));

const print = verbose ? (line: string) => console.log(dim(line)) : undefined;
const results: CaseResult[] = [];
if (serial) {
  for (const [c, f] of cases) results.push(await runCase(world, c, f, { amount, ...(print ? { print } : {}) }));
} else {
  results.push(...(await Promise.all(cases.map(([c, f]) => runCase(world, c, f, { amount, ...(print ? { print } : {}) })))));
}

for (const r of results) {
  console.log(`${bold(`${r.coordinator} · ${r.fault}`)}  ${dim(r.story)}`);
  for (const e of r.events) console.log(dim(`  ${(e.ms / 1000).toFixed(1).padStart(5)}s  ${e.actor.padEnd(12)} ${e.text}`));
  const states = r.changes.map((c) => `${c.part} ${c.state} @${(c.ms / 1000).toFixed(1)}s (block ${c.block})`).join(" · ");
  console.log(`         ${states || "nothing moved on either ledger"}`);
  console.log(`         ${r.matches ? green(r.outcome) : red(`${r.outcome}, expected ${r.expected}`)}\n`);
}

const window = (r: CaseResult) =>
  r.summary.disagreedMs === null ? "—" : r.summary.disagreesAtEnd ? `open (${(r.summary.disagreedMs / 1000).toFixed(1)}s and counting)` : `${(r.summary.disagreedMs / 1000).toFixed(1)}s`;
console.log(bold("  coordinator  fault                  outcome         ledgers disagreed"));
for (const r of results) {
  const outcome = r.matches ? green(r.outcome.padEnd(14)) : red(r.outcome.padEnd(14));
  console.log(`  ${r.coordinator.padEnd(11)}  ${r.fault.padEnd(21)}  ${outcome}  ${window(r)}`);
}
const file = await saveReport({
  scenario: scenario.id,
  at: new Date().toISOString(),
  chains: { ledger1: world.l1.network.chainId, ledger2: world.l2.network.chainId },
  parts: partLabels(world),
  ...(world.dealer ? { fx: { dealer: world.nameOf(world.dealer), from: world.currency, to: world.targetCurrency } } : {}),
  cases: results,
});
console.log(dim(`\n  Saved ${path.relative(REPO_ROOT, file)} (and sim/runs/interop/latest.json for the console)`));
const misses = results.filter((r) => !r.matches);
if (misses.length > 0) {
  console.log(red(bold(`  ${misses.length} case(s) did not end as expected.`)));
  process.exit(1);
}
console.log(green(bold("  Every case ended as expected: the unified mode has no failure window; each cross-ledger mode has its own.\n")));
process.exit(0);
