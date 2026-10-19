import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { REPO_ROOT } from "@oul/chain";
import { loadScenario, type Scenario } from "@oul/scenario";
import { serviceUrl } from "@oul/service";

const COLORS = [36, 33, 35, 32, 34, 31];

export async function scenarioFromArg(arg: string | undefined): Promise<{ scenario: Scenario; dir: string }> {
  const candidate = arg ?? "ca-interbank";
  const dir = existsSync(path.join(REPO_ROOT, "scenarios", candidate))
    ? path.join(REPO_ROOT, "scenarios", candidate)
    : path.resolve(candidate);
  return { scenario: await loadScenario(dir), dir };
}

export interface Services {
  /** Resolves once every service answers /health. */
  readonly ready: Promise<void>;
  /** Stop every service and wait for them to exit. */
  stop(): Promise<void>;
  /** Stop one service with a signal (SIGKILL to crash it) and wait for it to exit. */
  kill(participant: string, signal?: NodeJS.Signals): Promise<void>;
  /** Start one stopped service again and wait until it answers. */
  restart(participant: string): Promise<void>;
  /** Called if a service exits while not stopping and not killed on purpose. */
  onUnexpectedExit?: (participant: string, code: number | null) => void;
}

export interface LaunchOptions {
  readonly print?: (line: string) => void;
  /** Extra environment for every service, e.g. a short OUL_DEADLINE_SECONDS. */
  readonly env?: NodeJS.ProcessEnv;
}

/** How long services get to answer /health: on start, and after a restart, which on a loaded machine takes longer. */
const START_TIMEOUT_MS = 120_000;
const RESTART_TIMEOUT_MS = 180_000;

/**
 * Every service process this process has started and not seen exit. Each is
 * killed when this process exits, however it exits: at the end, on a thrown
 * error or an unhandled rejection (Node exits and runs its exit handlers), on
 * `process.exit`, or on SIGINT, SIGTERM or SIGHUP. A signal that something
 * else here also handles is left to it; its stop still ends in an exit.
 */
const running = new Set<ChildProcess>();
let cleanupInstalled = false;

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", () => {
    for (const child of running) child.kill("SIGKILL");
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      if (process.listenerCount(signal) > 1) return;
      for (const child of running) child.kill("SIGTERM");
      process.exit(code);
    });
  }
}

async function healthy(
  scenario: Scenario,
  ids: readonly string[],
  timeoutMs: number,
  lastLines: (id: string) => readonly string[] = () => [],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(ids);
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      const said = [...pending].map((id) => {
        const lines = lastLines(id);
        return lines.length ? `${id} last logged:\n${lines.map((l) => `    ${l}`).join("\n")}` : `${id} logged nothing`;
      });
      throw new Error(`Not healthy after ${timeoutMs / 1000}s: ${[...pending].join(", ")}\n  ${said.join("\n  ")}`);
    }
    for (const id of [...pending]) {
      const ok = await fetch(`${serviceUrl(scenario, id)}/health`).then((r) => r.ok).catch(() => false);
      if (ok) pending.delete(id);
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Start the central bank's and every bank's service as separate processes,
 * each with its own participant id, as separate institutions would run them.
 * Their output goes to `print`, prefixed with the participant.
 */
export function launchServices(scenario: Scenario, scenarioDir: string, options: LaunchOptions = {}): Services {
  const print = options.print ?? console.log;
  const participants = scenario.participants.filter((p) => p.kind === "central-bank" || p.kind === "bank");
  const width = Math.max(...participants.map((p) => p.id.length));
  const children = new Map<string, ChildProcess>();
  const intended = new Set<string>();
  /** Each service's last lines of output, for saying why one did not come up. */
  const recent = new Map<string, string[]>();
  let stopping = false;
  installCleanup();

  const start = (id: string) => {
    const index = participants.findIndex((p) => p.id === id);
    const participant = participants[index]!;
    const entry = path.join(REPO_ROOT, "services", participant.kind === "bank" ? "bank" : "central-bank", "src/main.ts");
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...options.env, OUL_PARTICIPANT: id, OUL_SCENARIO: scenarioDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(id, child);
    running.add(child);
    recent.set(id, []);
    const label = `\x1b[${COLORS[index % COLORS.length]}m${id.padEnd(width)}\x1b[0m │`;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream! }).on("line", (line) => {
        const lines = recent.get(id)!;
        lines.push(line);
        if (lines.length > 12) lines.shift();
        print(`${label} ${line}`);
      });
    }
    child.on("exit", (code) => {
      running.delete(child);
      if (!stopping && !intended.has(id)) services.onUnexpectedExit?.(id, code);
    });
  };

  const exited = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });

  const services: Services = {
    ready: healthy(
      scenario,
      participants.map((p) => p.id),
      START_TIMEOUT_MS,
      (id) => recent.get(id) ?? [],
    ),
    stop: async () => {
      stopping = true;
      await Promise.all(
        [...children.values()].map((child) => {
          const done = exited(child);
          child.kill("SIGTERM");
          return done;
        }),
      );
    },
    kill: async (id, signal = "SIGKILL") => {
      const child = children.get(id);
      if (!child) throw new Error(`No service for ${id}`);
      intended.add(id);
      const done = exited(child);
      child.kill(signal);
      await done;
    },
    restart: async (id) => {
      intended.delete(id);
      start(id);
      await healthy(scenario, [id], RESTART_TIMEOUT_MS, (p) => recent.get(p) ?? []);
    },
  };

  for (const participant of participants) start(participant.id);
  return services;
}
