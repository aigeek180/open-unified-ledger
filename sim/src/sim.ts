/**
 * The simulation harness (SPEC.md §9):
 *   pnpm sim [scenario] [--seed <n>] [--steps <n>] [--faults <rate>] [--verbose]
 *   pnpm sim [scenario] --script faults [--seed <n>]
 *   pnpm sim [scenario] --serve [--seed <n>] [--port <n>]
 *
 * Deploys the scenario afresh on the running network (so a seed always
 * starts from the same state), starts every participant's service as its own
 * process, and runs a seeded random sequence of flows through their HTTP
 * APIs. Every block is checked against the invariants (SPEC.md §6) as soon
 * as every participant has processed it, and the whole run is checked at the
 * end. `--faults <rate>` mixes the faults of harness/faults.ts into the run;
 * `--script faults` runs each once after a short prelude. A failing run
 * prints the command that reproduces it. `--serve` keeps the run open and
 * takes flows, faults and checks over HTTP from the console (serve.ts).
 */
import path from "node:path";
import { readNetwork, REPO_ROOT, sandboxSlot } from "@oul/chain";
import { FAULTS } from "./harness/faults.ts";
import { scenarioFromArg } from "./launch.ts";
import { SimulationRun, type Step } from "./run.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const verbose = args.includes("--verbose");
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const seed = Number(option("seed") ?? Math.floor(Math.random() * 2 ** 31));
const steps = Number(option("steps") ?? 25);
const faultRate = Number(option("faults") ?? 0);
const script = option("script");
const { scenario, dir } = await scenarioFromArg(positional[0]);
const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const network = await readNetwork().catch(() => {
  console.error("No network: run `pnpm network:generate && pnpm network:up` first.");
  process.exit(1);
});

if (args.includes("--serve")) {
  const { serve } = await import("./serve.ts");
  await serve({ scenario, scenarioDir: dir, network, seed, databaseUrl: DATABASE_URL, port: Number(option("port") ?? 7099 + 100 * sandboxSlot()), verbose });
} else {
  await runToEnd();
}

async function runToEnd(): Promise<void> {
  const reproduce =
    script === "faults"
      ? `pnpm sim ${scenario.id} --script faults --seed ${seed}`
      : `pnpm sim ${scenario.id} --seed ${seed} --steps ${steps}${faultRate > 0 ? ` --faults ${faultRate}` : ""}`;
  console.log(
    bold(
      `\nSimulation: ${scenario.id}, seed ${seed}, ${script === "faults" ? "every fault once" : `${steps} steps${faultRate > 0 ? `, faults at ${faultRate}` : ""}`}`,
    ),
  );
  const print = (step: Step) => {
    if (step.ok) console.log(`  ${String(step.n).padStart(3)}  ${step.label.padEnd(70)} ${dim(step.outcome)}`);
  };
  const run = await SimulationRun.start({
    scenario,
    scenarioDir: dir,
    network,
    seed,
    databaseUrl: DATABASE_URL,
    onStep: print,
    ...(verbose ? { print: (line: string) => console.log(line) } : {}),
  });
  console.log(dim(`  fresh deployment from block ${run.deployment.startBlock}`));
  let finishing = false;
  run.services.onUnexpectedExit = (participant, code) => {
    if (finishing) return;
    run.fail(`${participant}'s service exited (${code})`);
  };

  // However the steps end (a thrown error too), the services this run started stop with it.
  try {
    const { harness } = run;
    const model = harness.model;
    // With repo, the banks first buy the bonds they pledge.
    await run.prelude();
    if (script === "faults") {
      // A deterministic prelude gives every fault something to act on, then each fault runs once.
      for (const bank of harness.banks) {
        if (run.failures.length) break;
        for (const [currency, rtgs] of model.banks.get(bank)!.rtgs) {
          await run.action({ kind: "fund", bank, currency, amount: rtgs / 20n });
        }
        for (const customer of model.banks.get(bank)!.deposits.keys()) {
          if (run.failures.length) break;
          await run.action({ kind: "tokenize", bank, customer, amount: model.banks.get(bank)!.deposits.get(customer)! / 2000n });
        }
      }
      // With repo, one is open while the faults run, and closes after them.
      if (scenario.repo && run.failures.length === 0) await run.action(model.next(harness.rng, { kinds: ["repo-open"] }));
      for (const kind of FAULTS) {
        if (run.failures.length) break;
        await run.fault(kind);
      }
      if (scenario.repo && run.failures.length === 0 && model.repos.length > 0) await run.action(model.next(harness.rng, { kinds: ["repo-close"] }));
    } else {
      for (let s = 1; s <= steps && run.failures.length === 0; s++) {
        if (faultRate > 0 && harness.rng.next() < faultRate) await run.fault(harness.rng.pick(FAULTS));
        else await run.action(model.next(harness.rng));
      }
    }

    // Let every participant catch up to the head, then check what remains and the whole run.
    if (run.failures.length === 0) {
      const global = await run.checkAll();
      if (run.failures.length === 0) {
        for (const check of global) console.log(dim(`  inv ${check.invariant.padEnd(8)} ${check.what}`));
      }
    }
  } catch (error) {
    run.fail(`the run stopped: ${(error as Error).message}`);
  } finally {
    finishing = true;
    await run.stop();
  }

  console.log(
    `\n  ${run.settled} flows settled, ${run.refused} refused, ${run.faults} faults survived, ${run.blocksChecked} blocks checked, ${run.checksRun} checks`,
  );
  if (run.failures.length > 0) {
    for (const f of run.failures) console.log(red(`  ✗ inv ${f.invariant}: ${f.what}${f.detail ? `: ${f.detail}` : ""}`));
    console.log(`\n  Reproduce: ${bold(reproduce)}`);
    console.log(dim(`  Service logs: ${path.relative(REPO_ROOT, run.logFile)}`));
    process.exit(1);
  }
  console.log(green(bold(`  Every invariant held. (${reproduce})\n`)));
  process.exit(0);
}
