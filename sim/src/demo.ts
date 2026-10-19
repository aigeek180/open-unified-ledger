/**
 * One command for a reader (SPEC.md §9):
 *
 *   pnpm demo [scenario]     ca-interbank by default
 *   pnpm demo all            every scenario in turn
 *   pnpm demo <scenario> --no-explore
 *
 * Starts Postgres and the Besu network if they are not running (generating
 * the network if it is missing or was generated for other validators),
 * deploys the scenario afresh, and runs every one of its flows with their
 * checks (sim/src/e2e.ts: §5's flows over the services' APIs, the invariants
 * at every participant, the ISO 20022 messages against the official XSDs,
 * and a deliberately corrupted entry caught). For one scenario it then keeps
 * the scenario's services and the console running, with their addresses,
 * until Ctrl-C, so the run can be explored.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { deployScenario, GENERATED_DIR, readNetwork, REPO_ROOT, writeDeployment } from "@oul/chain";
import type { Scenario } from "@oul/scenario";
import { serviceUrl } from "@oul/service";
import { launchServices, scenarioFromArg } from "./launch.ts";

const SCENARIOS = ["ca-interbank", "ca-bond-dvp", "ca-us-pvp", "ca-repo"];
const CONSOLE_URL = "http://localhost:7090";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "ca-interbank";
const explore = !args.includes("--no-explore") && target !== "all";
const ids = target === "all" ? SCENARIOS : [target];

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

/** Run a command to completion with its output shown; reject if it fails. */
function run(command: string, commandArgs: string[], options: { quiet?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: REPO_ROOT, stdio: options.quiet ? ["ignore", "ignore", "inherit"] : "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${commandArgs.join(" ")} exited with ${code}`))));
  });
}

/** The validators a network was generated for, if any. */
async function generatedValidators(): Promise<string[] | undefined> {
  if (!existsSync(path.join(GENERATED_DIR, "network.json"))) return undefined;
  return (await readNetwork()).nodes.map((n) => n.participant).sort();
}

async function ensureNetwork(scenario: Scenario): Promise<void> {
  const wanted = scenario.participants.filter((p) => p.validator).map((p) => p.id).sort();
  const have = await generatedValidators();
  if (!have || have.join(",") !== wanted.join(",")) {
    if (have) {
      console.log(dim(`  the network was generated for other validators (${have.join(", ")}); regenerating for ${scenario.id}`));
      await run("pnpm", ["-s", "network:down"], { quiet: true });
    }
    await run("pnpm", ["-s", "network:generate", scenario.id]);
  }
  await run("docker", ["compose", "-f", path.join(GENERATED_DIR, "compose.yaml"), "up", "-d", "--quiet-pull"], { quiet: true });
}

console.log(bold(`\nOpen Unified Ledger demo: ${ids.join(", ")}\n`));
console.log(dim("  starting Postgres and the Besu network if they are not running"));
await run("docker", ["compose", "-f", path.join(REPO_ROOT, "infra/compose.yaml"), "up", "-d", "--wait", "postgres"], { quiet: true });

let last: { scenario: Scenario; dir: string } | undefined;
for (const id of ids) {
  const loaded = await scenarioFromArg(id);
  await ensureNetwork(loaded.scenario);
  console.log(bold(`\n${loaded.scenario.name} (${id})`));
  // A fresh deployment, so the books start from the scenario's opening balances.
  const { deployment } = await deployScenario(loaded.scenario, await readNetwork(), { force: true, log: (m) => console.log(dim(m)) });
  await writeDeployment(deployment);
  try {
    await run("node", [path.join(REPO_ROOT, "sim/src/e2e.ts"), id]);
  } catch (error) {
    console.log(red(bold(`\nThe ${id} demo failed: ${(error as Error).message}`)));
    process.exit(1);
  }
  last = loaded;
}
console.log(green(bold(`Demo finished in ${elapsed()}: every flow settled, every participant reconciled, every message valid.`)));

if (!explore || !last) process.exit(0);

// Keep the last scenario running to explore: its services, on the deployment the flows just used, and the console.
const { scenario, dir } = last;
console.log(bold(`\nExplore ${scenario.id}`));
const services = launchServices(scenario, dir, { print: () => {} });
await services.ready;
// The console reads the directory from the first participant's service, wherever this sandbox put it.
const consoleServer = spawn("pnpm", ["--filter", "@oul/console", "dev"], {
  cwd: REPO_ROOT,
  stdio: "ignore",
  env: { ...process.env, OUL_CONSOLE_ENTRY: serviceUrl(scenario, scenario.participants[0]!.id) },
});
for (let i = 0; i < 120; i++) {
  const up = await fetch(`${CONSOLE_URL}/p/${scenario.participants[0]!.id}`).then((r) => r.ok).catch(() => false);
  if (up) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const cb = scenario.participants.find((p) => p.kind === "central-bank")!.id;
console.log(`  console       ${CONSOLE_URL}/p/${cb}`);
for (const p of scenario.participants.filter((x) => x.kind === "central-bank" || x.kind === "bank")) {
  console.log(`  ${p.name.padEnd(13)} ${serviceUrl(scenario, p.id)}`);
}
console.log(dim("  The console shows each participant's books, its instructions and their timelines, and its ISO 20022 messages."));
console.log(dim("  Ctrl-C stops the services and the console; `pnpm network:down` stops the network."));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  consoleServer.kill("SIGTERM");
  await services.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
