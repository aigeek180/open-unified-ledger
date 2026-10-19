/**
 * The conformance kit from the command line (SPEC.md §14):
 *   pnpm conformance [scenario] [--engine <name> | --coordinator <name>] [--anvil]
 *                    [--seed <n> | --seeds <from>..<to>] [--steps <n>] [--faults <rate>]
 *                    [--no-script] [--shrink <runs>]
 *
 * Runs the kit against an engine: the scripted run (every flow, then every
 * fault once), then a seeded run per seed. The engine is the sandbox's own
 * (`sandbox`, the default), one of its deliberately broken engines by name,
 * or `all`: the real engine, then every broken one whose break this
 * scenario can show, ending with whether the kit passed the real engine and
 * failed each broken one on the check named for it. By default on the running
 * network (`pnpm network:generate <scenario> && pnpm network:up`), each run
 * on a fresh deployment; `--anvil` runs each on a fresh local Anvil instead.
 * Prints every check of every run and, for a failing run, the smallest
 * sequence found that still fails and the command that reproduces it; keeps
 * the report in sim/runs/conformance/. Exits 1 if any check failed, or with
 * `all`, unless the real engine passed and every broken one was caught.
 *
 * `--coordinator <unified|htlc|notary|all>` runs interop mode's coordinators
 * under the kit instead (SPEC.md §7): the scenario's interop payment on both
 * ledgers (`pnpm interop:generate <scenario> && pnpm interop:up` beside the
 * shared network, or `--anvil`), under each of §7's faults. It exits 0 only
 * if atomicity fails exactly where §7 says each coordinator leaves the ledgers
 * disagreeing, and nothing else fails.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { readInteropNetwork, readNetwork, REPO_ROOT } from "@oul/chain";
import { COORDINATOR_NAMES, type CoordinatorName, EXPECTED } from "@oul/coordinator";
import { loadScenario } from "@oul/scenario";
import { type CheckName, conformance, failing, formatReport, type KitReport, reportJson, type RunResult } from "../src/index.ts";
import { InteropAdapter, type InteropOptions } from "../src/interop/index.ts";
import { BROKEN_ENGINES, type BrokenEngineName, SandboxAdapter, type SandboxOptions } from "../src/sandbox/index.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUED = new Set(["--engine", "--coordinator", "--seed", "--seeds", "--steps", "--faults", "--shrink"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""));

const id = positional[0] ?? "ca-interbank";
const dir = existsSync(path.join(REPO_ROOT, "scenarios", id)) ? path.join(REPO_ROOT, "scenarios", id) : path.resolve(id);
const scenario = await loadScenario(dir);
const engine = option("engine") ?? "sandbox";
const seedRange = option("seeds");
const seeds = seedRange
  ? (() => {
      const [from, to] = seedRange.split("..").map(Number);
      return Array.from({ length: to! - from! + 1 }, (_, i) => from! + i);
    })()
  : option("seed")
    ? [Number(option("seed"))]
    : [];
const steps = Number(option("steps") ?? 20);
const faultRate = Number(option("faults") ?? 0.25);
const shrinkBudget = Number(option("shrink") ?? 32);
const scripted = !args.includes("--no-script");
const onAnvil = args.includes("--anvil");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let chain: SandboxOptions["chain"] = { kind: "anvil" };
if (!onAnvil) {
  const network = await readNetwork().catch(() => undefined);
  if (!network) {
    console.error(`No network: run \`pnpm network:generate ${scenario.id} && pnpm network:up\`, or pass --anvil.`);
    process.exit(1);
  }
  if (network.scenario !== scenario.id) {
    // Besu lets only the generated scenario's participants send; another scenario with the same ones runs too.
    const generated = await loadScenario(path.join(REPO_ROOT, "scenarios", network.scenario)).catch(() => undefined);
    const ids = (s: typeof scenario) => s.participants.map((p) => p.id).sort().join(",");
    if (!generated || ids(generated) !== ids(scenario)) {
      console.error(`The network was generated for ${network.scenario}: run \`pnpm network:generate ${scenario.id} && pnpm network:up\` first.`);
      process.exit(1);
    }
  }
  chain = { kind: "network", network };
}

const coordinator = option("coordinator");
if (coordinator) await coordinators(coordinator);

/** Interop mode's coordinators under the kit, each on the scenario's two ledgers. */
async function coordinators(which: string): Promise<never> {
  const chosen = which === "all" ? [...COORDINATOR_NAMES] : [which as CoordinatorName];
  if (!chosen.every((c) => COORDINATOR_NAMES.includes(c))) {
    console.error(`Unknown coordinator "${which}". Coordinators: ${COORDINATOR_NAMES.join(", ")}, or all.`);
    process.exit(1);
  }
  let ledgers: InteropOptions["chain"] = { kind: "anvil" };
  if (chain?.kind === "network") {
    const network2 = await readInteropNetwork().catch(() => undefined);
    if (!network2 || network2.scenario !== scenario.id) {
      console.error(`No interop ledger for ${scenario.id}: run \`pnpm interop:generate ${scenario.id} && pnpm interop:up\` first, or pass --anvil.`);
      process.exit(1);
    }
    ledgers = { kind: "network", network1: chain.network, network2 };
  }
  const out = path.join(REPO_ROOT, "sim/runs/conformance");
  await mkdir(out, { recursive: true });
  const started = Date.now();
  const verdicts: string[] = [];
  let proven = true;
  for (const name of chosen) {
    const adapter = new InteropAdapter({ coordinator: name, chain: ledgers, log: (line) => console.log(dim(line)) });
    console.log(bold(`\nConformance kit: ${adapter.name} on ${scenario.id}`));
    let report: KitReport;
    try {
      report = await conformance(adapter, scenario, { scripted, seeds, steps, faultRate, shrinkBudget: 0, log: (line) => console.log(dim(line)) });
    } finally {
      await adapter.close();
    }
    for (const line of formatReport(report, scenario)) console.log(line);
    const file = path.join(out, `${scenario.id}.interop-${name}.${new Date().toISOString().replaceAll(":", "-")}.json`);
    await writeFile(file, `${reportJson(report)}\n`);
    const expected = Object.entries(EXPECTED[name]).filter(([, o]) => o === "inconsistent").map(([f]) => f).sort();
    for (const run of report.runs) {
      const atomicity = run.checks.find((c) => c.name === "atomicity")!;
      const faulted = run.steps.flatMap((s) => ("fault" in s && "flow" in s.fault ? [[s.fault.fault, s.fault.flow.id] as const] : []));
      const partial = faulted.filter(([, id]) => atomicity.failures.some((f) => f.startsWith(id))).map(([f]) => f).sort();
      const others = failing(run.checks).filter((c) => c !== "atomicity");
      const exact = (run.seed !== undefined || partial.join() === expected.join()) && atomicity.failures.length === partial.length && others.length === 0;
      proven &&= exact;
      verdicts.push(`  ${exact ? "✓" : "✗"} ${name.padEnd(8)} ${run.label}: atomicity failed on ${partial.join(", ") || "nothing"}${run.seed === undefined ? `; SPEC.md §7: ${expected.join(", ") || "nothing"}` : ""}${others.length ? `; also ${others.join(", ")}` : ""}`);
    }
  }
  console.log(bold(`\nInterop coordinators under the kit, on ${scenario.id}`));
  for (const v of verdicts) console.log(v);
  console.log(dim(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s`));
  process.exit(proven ? 0 : 1);
}

const names = ["sandbox", ...BROKEN_ENGINES.map((b) => b.name)];
if (engine !== "all" && !names.includes(engine)) {
  console.error(`Unknown engine "${engine}". Engines: ${names.join(", ")}, or all.`);
  process.exit(1);
}
// A broken engine whose break needs payments across currencies, or repo, shows only where the scenario has them.
const canShow = (n: string) => (n === "round-fx-twice" ? scenario.currencies.length > 1 : n === "repo-interest-360" ? scenario.repo !== undefined : true);
const engines = engine === "all" ? names.filter(canShow) : [engine];
const skippedHere = engine === "all" ? names.filter((n) => !engines.includes(n)) : [];

const out = path.join(REPO_ROOT, "sim/runs/conformance");
await mkdir(out, { recursive: true });
const started = Date.now();
const results: { name: string; report: KitReport }[] = [];
for (const name of engines) {
  const adapter = new SandboxAdapter({ chain, log: (line) => console.log(dim(line)), ...(name === "sandbox" ? {} : { broken: name as BrokenEngineName }) });
  console.log(bold(`\nConformance kit: ${adapter.name} on ${scenario.id}, ${onAnvil ? "a fresh Anvil per run" : `the network (chain ${chain.kind === "network" ? chain.network.chainId : ""})`}`));
  let report: KitReport;
  try {
    report = await conformance(adapter, scenario, { scripted, seeds, steps, faultRate, shrinkBudget, log: (line) => console.log(dim(line)) });
  } finally {
    await adapter.close();
  }
  const reproduce = (run: RunResult) => {
    const base = `pnpm conformance ${scenario.id} --engine ${name}${onAnvil ? " --anvil" : ""}`;
    return run.seed === undefined ? base : `${base} --no-script --seed ${run.seed} --steps ${steps} --faults ${faultRate}`;
  };
  console.log("");
  for (const line of formatReport(report, scenario, reproduce)) console.log(line);
  const file = path.join(out, `${scenario.id}.${name}.${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(file, `${reportJson(report)}\n`);
  console.log(dim(`  report kept in ${path.relative(REPO_ROOT, file)}`));
  results.push({ name, report });
}

if (engine !== "all") {
  console.log(dim(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s`));
  process.exit(results[0]!.report.passed ? 0 : 1);
}
console.log(bold(`\nThe kit on ${scenario.id}: the real engine, and each broken engine against the check named for it`));
let proven = true;
for (const { name, report } of results) {
  const failed = new Set(report.runs.flatMap((r) => failing(r.checks)));
  if (name === "sandbox") {
    proven &&= report.passed;
    console.log(`  ${report.passed ? "✓" : "✗"} sandbox${" ".repeat(10)}passed every check`);
    continue;
  }
  const broken = BROKEN_ENGINES.find((b) => b.name === name)!;
  const caught = failed.has(broken.check as CheckName);
  proven &&= caught;
  const also = [...failed].filter((c) => c !== broken.check);
  console.log(`  ${caught ? "✓" : "✗"} ${name.padEnd(16)} ${caught ? "failed" : "NOT failed"} on ${broken.check}${also.length ? `; also ${also.join(", ")}` : ""} (${broken.breaks})`);
}
for (const name of skippedHere) {
  const broken = BROKEN_ENGINES.find((b) => b.name === name)!;
  console.log(dim(`  – ${name.padEnd(16)} cannot show its break here: run it on ${broken.scenario}`));
}
console.log(dim(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s`));
process.exit(proven ? 0 : 1);
