/**
 * Network and deployment commands, run from the repository root:
 *
 *   pnpm network:generate [scenario]   write infra/besu/generated for a scenario's validators
 *   pnpm network:up / network:down     start or remove the Besu network
 *   pnpm deploy [scenario]             deploy the scenario's contracts, write deployments/<scenario>.json
 *                                      (to redeploy over a live one: pnpm run deploy <scenario> -- --force;
 *                                      pnpm takes a bare --force as its own flag)
 *   pnpm network:smoke [scenario]      settle the §5.1–5.3 flows on chain and print the result
 *
 * Interop mode's second ledger (SPEC.md §7), for a scenario with an `interop` block:
 *
 *   pnpm interop:generate [scenario]   write infra/besu/interop for the second ledger's validators
 *   pnpm interop:up / interop:down     start or remove it
 *   pnpm interop:deploy [scenario]     deploy interop mode's contracts on both ledgers
 *   pnpm interop:smoke [scenario]      settle one transfer across the two, by hashlock and by notary
 *
 * Confidential mode (SPEC.md §10), Paladin beside the shared ledger:
 *
 *   pnpm confidential:deploy [scenario]  deploy Paladin's base contracts, write infra/paladin/generated
 *   pnpm confidential:up / :down         start or remove one Paladin node per bank
 *   pnpm confidential:setup [scenario]   allowlist the nodes' keys, register them, deploy a Noto token per bank
 *   pnpm confidential:smoke [scenario]   mint and pay privately, then check who can see what
 *   pnpm confidential:pay [scenario]     an interbank payment over Noto deposits and wholesale, and a cancelled one
 *   pnpm confidential:compare [scenario] the same payment in each mode, and what each participant can see of it
 *
 * A scenario is an id under scenarios/ or a path to a scenario folder;
 * ca-interbank by default.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadScenario, type Scenario } from "@oul/scenario";
import {
  buildNetworkFiles,
  deployConfidentialBase,
  deployInterop,
  deployScenario,
  GENERATED_DIR,
  INTEROP_DIR,
  INTEROP_LEDGER,
  type LedgerLayout,
  readConfidentialDeployment,
  readDeployment,
  readInteropNetwork,
  readNetwork,
  REPO_ROOT,
  SHARED_LEDGER,
  setupConfidential,
  writeConfidentialDeployment,
  writeDeployment,
  writeInteropDeployment,
  writePaladinFiles,
} from "../src/index.ts";
import { confidentialCompare } from "./confidential-compare.ts";
import { confidentialPay } from "./confidential-pay.ts";
import { confidentialSmoke } from "./confidential-smoke.ts";
import { interopSmoke } from "./interop-smoke.ts";
import { smoke } from "./smoke.ts";

async function scenarioFrom(arg: string | undefined): Promise<Scenario> {
  const candidate = arg ?? "ca-interbank";
  const dir = existsSync(path.join(REPO_ROOT, "scenarios", candidate))
    ? path.join(REPO_ROOT, "scenarios", candidate)
    : path.resolve(candidate);
  return loadScenario(dir);
}

async function generate(scenario: Scenario, layout: LedgerLayout = SHARED_LEDGER, dir = GENERATED_DIR): Promise<void> {
  const files = buildNetworkFiles(scenario, layout);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const write = (name: string, content: string) => writeFile(path.join(dir, name), content);
  await write("genesis.json", `${JSON.stringify(files.genesis, null, 2)}\n`);
  await write("static-nodes.json", `${JSON.stringify(files.staticNodes, null, 2)}\n`);
  await write("compose.yaml", files.compose);
  await write("network.json", `${JSON.stringify(files.network, null, 2)}\n`);
  for (const node of files.nodes) {
    await mkdir(path.join(dir, node.participant), { recursive: true });
    await write(path.join(node.participant, "key"), node.key);
    await write(path.join(node.participant, "permissions_config.toml"), files.permissions);
  }
  console.log(
    `Generated a ${files.nodes.length}-validator QBFT network for ${scenario.id}${layout.ledger === "interop" ? "'s second ledger" : ""} (chain ${layout.chainId}) in ${path.relative(REPO_ROOT, dir)}`,
  );
  for (const node of files.network.nodes) {
    console.log(`  ${node.participant.padEnd(14)} validator ${node.validator}  rpc ${node.rpcUrl}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a) => !a.startsWith("--"));

switch (command) {
  case "generate":
    await generate(await scenarioFrom(positional[0]));
    break;
  case "deploy": {
    const scenario = await scenarioFrom(positional[0]);
    const network = await readNetwork();
    if (network.scenario !== scenario.id) {
      console.warn(`Note: the network was generated for ${network.scenario}, deploying ${scenario.id} to it.`);
    }
    const { deployment, reused } = await deployScenario(scenario, network, {
      force: flags.has("--force"),
      log: console.log,
    });
    if (!reused) console.log(`Wrote ${path.relative(REPO_ROOT, await writeDeployment(deployment))}`);
    break;
  }
  case "smoke":
    await smoke(await scenarioFrom(positional[0]), await readNetwork());
    break;
  case "generate-interop":
    await generate(await scenarioFrom(positional[0]), INTEROP_LEDGER, INTEROP_DIR);
    break;
  case "deploy-interop": {
    const scenario = await scenarioFrom(positional[0]);
    const network = await readNetwork();
    const deployment = await readDeployment(scenario.id);
    if (!deployment) throw new Error(`No deployment of ${scenario.id} on ledger 1: run \`pnpm deploy ${scenario.id}\` first`);
    const { deployment: interop, reused } = await deployInterop(scenario, { network, deployment }, await readInteropNetwork(), {
      force: flags.has("--force"),
      log: console.log,
    });
    if (!reused) console.log(`Wrote ${path.relative(REPO_ROOT, await writeInteropDeployment(interop))}`);
    break;
  }
  case "deploy-confidential": {
    const scenario = await scenarioFrom(positional[0]);
    const network = await readNetwork();
    const deployment = await readDeployment(scenario.id);
    if (!deployment) throw new Error(`No deployment of ${scenario.id}: run \`pnpm deploy ${scenario.id}\` first`);
    const base = await deployConfidentialBase(scenario, network, deployment, console.log);
    console.log(`Wrote ${path.relative(REPO_ROOT, await writeConfidentialDeployment(base))}`);
    console.log(`Wrote node configurations and certificates to ${path.relative(REPO_ROOT, await writePaladinFiles(scenario, base))}`);
    break;
  }
  case "setup-confidential": {
    const scenario = await scenarioFrom(positional[0]);
    const base = await readConfidentialDeployment(scenario.id);
    if (!base) throw new Error(`Run pnpm confidential:deploy ${scenario.id} first`);
    console.log(`Setting up confidential mode for ${scenario.id}`);
    const done = await setupConfidential(scenario, await readNetwork(), base, console.log);
    console.log(`Wrote ${path.relative(REPO_ROOT, await writeConfidentialDeployment(done))}`);
    break;
  }
  case "compare-confidential":
    await confidentialCompare(await scenarioFrom(positional[0]), await readNetwork());
    break;
  case "pay-confidential":
    await confidentialPay(await scenarioFrom(positional[0]), await readNetwork());
    break;
  case "smoke-confidential":
    await confidentialSmoke(await scenarioFrom(positional[0]), await readNetwork());
    break;
  case "smoke-interop":
    await interopSmoke(await scenarioFrom(positional[0]), await readNetwork(), await readInteropNetwork());
    break;
  default:
    console.error(
      "Usage: cli.ts <generate|deploy|smoke|generate-interop|deploy-interop|smoke-interop|deploy-confidential|setup-confidential|smoke-confidential|pay-confidential|compare-confidential> [scenario] [--force]",
    );
    process.exit(1);
}
