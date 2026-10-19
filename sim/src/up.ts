/**
 * Run every participant's service for a scenario, one process each, the way
 * they would run as separate institutions: `pnpm services:up [scenario]`.
 * Needs the network up and the scenario deployed (`pnpm network:up`,
 * `pnpm deploy`). Ctrl-C stops them all.
 */
import { readDeployment } from "@oul/chain";
import { serviceUrl } from "@oul/service";
import { launchServices, scenarioFromArg } from "./launch.ts";

const { scenario, dir } = await scenarioFromArg(process.argv[2]);
if (!(await readDeployment(scenario.id))) {
  console.error(`No deployment of ${scenario.id}. Run: pnpm network:up && pnpm deploy ${scenario.id}`);
  process.exit(1);
}

const services = launchServices(scenario, dir);
services.onUnexpectedExit = (participant, code) => {
  console.error(`${participant} exited (${code}); stopping the others`);
  void services.stop().then(() => process.exit(1));
};
const stop = () => void services.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  await services.ready;
} catch (error) {
  console.error((error as Error).message);
  await services.stop();
  process.exit(1);
}
const ids = scenario.participants.filter((p) => p.kind === "central-bank" || p.kind === "bank").map((p) => p.id);
console.log(`\nAll ${ids.length} services are up for ${scenario.id}:`);
for (const id of ids) console.log(`  ${id.padEnd(14)} ${serviceUrl(scenario, id)}`);
console.log("Ctrl-C stops them.\n");
