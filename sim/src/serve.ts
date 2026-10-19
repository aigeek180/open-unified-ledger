import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Network } from "@oul/chain";
import type { Scenario } from "@oul/scenario";
import { FAULTS, type FaultKind } from "./harness/faults.ts";
import { SimulationRun } from "./run.ts";

/**
 * The harness kept open for the console (SPEC.md §4.6, §9): `pnpm sim
 * <scenario> --serve`. It deploys afresh and starts the services as a run
 * does, checks every block as it commits, and takes work over HTTP, one job
 * at a time:
 *
 *   GET  /status          the run: counts, every step, failures, the latest whole-run checks
 *   POST /steps           {"count": 5, "faults": 0.25}: seeded random flows, with faults mixed in at that rate
 *   POST /faults/:kind    one fault, e.g. /faults/validator-down
 *   POST /check           catch up and check the whole run (invariants 4 to 7 and 9)
 *
 * A job answers 202 and runs in the background; another while it runs is a
 * 409. Errors are problem details, as the services' are. Local only: it
 * listens on 127.0.0.1 and stops and starts validators and services.
 */

export interface ServeOptions {
  readonly scenario: Scenario;
  readonly scenarioDir: string;
  readonly network: Network;
  readonly seed: number;
  readonly databaseUrl: string;
  readonly port: number;
  readonly verbose: boolean;
}

interface Job {
  readonly label: string;
  readonly since: string;
}

export async function serve(options: ServeOptions): Promise<void> {
  const { scenario, seed, port } = options;
  const log = (message: string) => console.log(`${new Date().toISOString()} [harness] ${message}`);
  log(`deploying ${scenario.id} afresh and starting its services (seed ${seed})`);
  const run = await SimulationRun.start({
    scenario,
    scenarioDir: options.scenarioDir,
    network: options.network,
    seed,
    databaseUrl: options.databaseUrl,
    onStep: (step) => log(`${step.n} ${step.label}: ${step.ok ? "" : "FAILED "}${step.outcome}`),
    ...(options.verbose ? { print: (line: string) => console.log(line) } : {}),
  });
  // With repo, the banks first buy the bonds they pledge.
  await run.prelude();
  const startedAt = new Date().toISOString();
  let stopping = false;
  run.services.onUnexpectedExit = (participant, code) => {
    if (!stopping) run.fail(`${participant}'s service exited (${code})`);
  };

  let job: Job | null = null;
  let lastGlobalAt: string | null = null;

  /** Start a job unless one is running; its errors become failures of the run. */
  const start = (label: string, work: () => Promise<void>): boolean => {
    if (job) return false;
    job = { label, since: new Date().toISOString() };
    log(`job: ${label}`);
    void work()
      .catch((error) => run.fail(`${label}: ${(error as Error).message}`))
      .finally(() => {
        job = null;
      });
    return true;
  };

  const status = () => ({
    scenario: { id: scenario.id, name: scenario.name },
    seed,
    startedAt,
    deployment: { startBlock: run.deployment.startBlock, deployedAt: run.deployment.deployedAt },
    busy: job,
    counts: { steps: run.steps.length, settled: run.settled, refused: run.refused, faults: run.faults },
    blocksChecked: run.blocksChecked,
    checksRun: run.checksRun,
    checkedThrough: run.checkedThrough.toString(),
    ok: run.failures.length === 0,
    failures: run.failures,
    lastGlobal: run.lastGlobal ? { at: lastGlobalAt, checks: run.lastGlobal } : null,
    faults: FAULTS,
    steps: [...run.steps].reverse().slice(0, 100),
  });

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => problem(response, 500, "internal", "Something went wrong", String(error)));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /status" || route === "GET /health") return json(response, 200, status());

    if (request.method !== "POST") return problem(response, 404, "not-found", "Not found", `No route ${route}`);
    const body = await readJson(request);
    const busy = () =>
      problem(response, 409, "busy", "The harness is busy", `Running "${job?.label}" since ${job?.since}; try again when it finishes`);

    if (url.pathname === "/steps") {
      const count = Number(body["count"] ?? 5);
      const rate = Number(body["faults"] ?? 0);
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        return problem(response, 400, "validation", "The request is invalid", "count: a whole number from 1 to 50");
      }
      if (!(rate >= 0 && rate <= 1)) return problem(response, 400, "validation", "The request is invalid", "faults: a rate from 0 to 1");
      const label = `${count} random flows${rate > 0 ? `, faults at ${rate}` : ""}`;
      const started = start(label, async () => {
        const { harness } = run;
        await harness.syncModel();
        for (let s = 0; s < count && !stopping; s++) {
          if (rate > 0 && harness.rng.next() < rate) await run.fault(harness.rng.pick(FAULTS));
          else await run.action(harness.model.next(harness.rng));
        }
      });
      return started ? json(response, 202, { accepted: label }) : busy();
    }

    const fault = url.pathname.match(/^\/faults\/([a-z-]+)$/)?.[1];
    if (fault !== undefined) {
      if (!FAULTS.includes(fault as FaultKind)) {
        return problem(response, 404, "not-found", "Not found", `No fault "${fault}"; one of ${FAULTS.join(", ")}`);
      }
      const started = start(`fault ${fault}`, async () => {
        await run.harness.syncModel();
        await run.fault(fault as FaultKind);
      });
      return started ? json(response, 202, { accepted: `fault ${fault}` }) : busy();
    }

    if (url.pathname === "/check") {
      const started = start("whole-run checks", async () => {
        await run.checkAll();
        lastGlobalAt = new Date().toISOString();
      });
      return started ? json(response, 202, { accepted: "whole-run checks" }) : busy();
    }

    return problem(response, 404, "not-found", "Not found", `No route ${route}`);
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  log(`serving on http://127.0.0.1:${port}: open the console's harness page (pnpm console)`);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    server.close();
    await run.stop();
    process.exit(run.failures.length === 0 ? 0 : 1);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

function problem(response: ServerResponse, status: number, type: string, title: string, detail?: string): void {
  response.writeHead(status, { "content-type": "application/problem+json" });
  response.end(JSON.stringify({ type: `urn:oul:problem:${type}`, title, status, ...(detail ? { detail } : {}) }));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
