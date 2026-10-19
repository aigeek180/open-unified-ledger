/**
 * Seeded runs in a batch (SPEC.md §9):
 *
 *   pnpm sim:seeds [scenario] --from 1 --to 1000 [--steps 20] [--faults 0.25] [--keep-going]
 *   pnpm sim:seeds [scenario] --summary
 *
 * Runs `pnpm sim` once per seed, one at a time on the one network, and
 * appends each result to sim/runs/seeds/<scenario>.jsonl: the seed, the
 * settings, the code it ran against (the commit, and any uncommitted
 * changes), the outcome, the counts, how long it took, and the command that
 * reproduces it. A seed already recorded with the same settings against the
 * same code is skipped, so a stopped batch resumes where it left off, and new
 * code runs its seeds afresh. The first failure stops the
 * batch unless --keep-going. Ctrl-C finishes the seed in progress and stops;
 * a second Ctrl-C stops it at once. Before each seed the network must be
 * producing blocks and Postgres must answer; if either is down the batch
 * stops without recording anything, since a seed that could not run proves
 * nothing either way. --summary prints what the records show, which is all
 * the repository claims.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { readNetwork, REPO_ROOT } from "@oul/chain";

interface SeedRecord {
  readonly scenario: string;
  readonly seed: number;
  readonly steps: number;
  readonly faults: number;
  /** The commit the seed ran against, and the paths changed since it; absent in records from before they were kept. */
  readonly commit?: string;
  readonly changes?: readonly string[];
  readonly ok: boolean;
  readonly settled: number | null;
  readonly refused: number | null;
  readonly faultsSurvived: number | null;
  readonly blocks: number | null;
  readonly checks: number | null;
  readonly durationMs: number;
  readonly at: string;
  readonly reproduce: string;
  /** For a failure: the lines that say what broke. */
  readonly failure?: readonly string[];
  /** Processes of the seed were still running when it ended, and were killed. */
  readonly leftovers?: true;
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const scenario = positional[0] ?? "ca-interbank";
const steps = Number(option("steps") ?? 20);
const faults = Number(option("faults") ?? 0.25);
const from = Number(option("from") ?? 1);
const to = Number(option("to") ?? from + 99);
const keepGoing = args.includes("--keep-going");
const file = path.join(REPO_ROOT, "sim/runs/seeds", `${scenario}.jsonl`);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

async function records(): Promise<SeedRecord[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SeedRecord);
}

/** The code a seed runs against: the commit, and the paths changed since it (run records are not tracked). */
function codeVersion(): { commit: string; changes: string[] } {
  const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  const commit = git("rev-parse", "HEAD").trim();
  const changes = git("status", "--porcelain")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  return { commit, changes };
}
const version = codeVersion();
const versionKey = (r: Pick<SeedRecord, "commit" | "changes">) =>
  r.commit ? `${r.commit.slice(0, 9)}${r.changes?.length ? ` with uncommitted changes to ${r.changes.length} files` : ""}` : "code version not recorded";
const sameRun = (r: SeedRecord) =>
  r.steps === steps && r.faults === faults && r.commit === version.commit && (r.changes ?? []).join("|") === version.changes.join("|");

if (args.includes("--summary")) {
  const all = await records();
  if (all.length === 0) {
    console.log(`No seeds recorded for ${scenario} (${path.relative(REPO_ROOT, file)}).`);
    process.exit(0);
  }
  const groups = new Map<string, SeedRecord[]>();
  for (const r of all) {
    const key = `${versionKey(r)}, --steps ${r.steps} --faults ${r.faults}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  console.log(bold(`\nSeeds recorded for ${scenario}`));
  for (const [settings, rs] of groups) {
    const held = rs.filter((r) => r.ok);
    const failed = rs.filter((r) => !r.ok);
    const time = rs.reduce((t, r) => t + r.durationMs, 0);
    const seeds = rs.map((r) => r.seed).sort((a, b) => a - b);
    console.log(`  ${settings}: ${rs.length} seeds (${seeds[0]}–${seeds.at(-1)}), ${held.length} held every invariant, ${failed.length} failed; ${hours(time)} of runs`);
    const sum = (k: "settled" | "faultsSurvived" | "checks") => rs.reduce((t, r) => t + (r[k] ?? 0), 0);
    console.log(dim(`    ${sum("settled")} flows settled, ${sum("faultsSurvived")} faults survived, ${sum("checks")} invariant checks`));
    for (const f of failed) console.log(red(`    seed ${f.seed} failed: ${f.reproduce}`));
  }
  process.exit(0);
}

/** Whether the network is producing blocks and Postgres answers; the reason if not. */
async function preflight(): Promise<string | undefined> {
  const network = await readNetwork().catch(() => undefined);
  if (!network) return "no network has been generated (pnpm network:generate)";
  const url = network.nodes[0]!.rpcUrl;
  const height = async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    return BigInt(((await response.json()) as { result: string }).result);
  };
  try {
    const first = await height();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if ((await height()) <= first) return `the network at ${url} is not producing blocks`;
  } catch {
    return `the network at ${url} does not answer (pnpm network:up)`;
  }
  const db = await new Promise<boolean>((resolve) => {
    const socket = connect(55442, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
  });
  return db ? undefined : "Postgres on port 55442 does not answer (pnpm db:up)";
}

/** One seed: run `pnpm sim`, parse its closing lines, and record the outcome. */
function runSeed(seed: number): Promise<SeedRecord> {
  const reproduce = `pnpm sim ${scenario} --seed ${seed} --steps ${steps} --faults ${faults}`;
  const started = Date.now();
  return new Promise((resolve) => {
    // Each seed in a process group of its own, with the services it starts: Ctrl-C here reaches this batch
    // alone, and whatever the seed left running, however it ended, is swept away with the group.
    const child = spawn("node", [path.join(REPO_ROOT, "sim/src/sim.ts"), scenario, "--seed", String(seed), "--steps", String(steps), "--faults", String(faults)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    current = child;
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) => {
      current = undefined;
      const leftovers = sweep(child.pid);
      const text = stripAnsi(output);
      const counts = text.match(/(\d+) flows settled, (\d+) refused, (\d+) faults survived, (\d+) blocks checked, (\d+) checks/);
      const n = (i: number) => (counts ? Number(counts[i]) : null);
      const ok = code === 0;
      resolve({
        scenario,
        seed,
        steps,
        faults,
        commit: version.commit,
        changes: version.changes,
        ok,
        settled: n(1),
        refused: n(2),
        faultsSurvived: n(3),
        blocks: n(4),
        checks: n(5),
        durationMs: Date.now() - started,
        at: new Date().toISOString(),
        reproduce,
        ...(leftovers ? { leftovers: true } : {}),
        ...(ok ? {} : { failure: text.split("\n").filter((l) => l.includes("✗") || /error/i.test(l)).slice(0, 12) }),
      });
    });
  });
}

/**
 * Kill whatever is left of a seed's process group, its services included,
 * and say whether anything was. A seed's `pnpm sim` stops its services
 * on every way out it has; this catches what it could not, a SIGKILL say.
 */
function sweep(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
  } catch {
    return false; // the group is gone: nothing left
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Gone between the check and the kill.
  }
  return true;
}

let current: ReturnType<typeof spawn> | undefined;
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) {
    if (current?.pid) {
      try {
        process.kill(-current.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    process.exit(130);
  }
  stopping = true;
  console.log(dim("\n  finishing the seed in progress, then stopping (Ctrl-C again to stop now)"));
});

await mkdir(path.dirname(file), { recursive: true });
const done = new Set((await records()).filter(sameRun).map((r) => r.seed));
const todo = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i).filter((s) => !done.has(s));
console.log(bold(`\nSeeds ${from}–${to} for ${scenario}, --steps ${steps} --faults ${faults}`));
console.log(dim(`  code: ${versionKey(version)}`));
console.log(dim(`  ${done.size} already recorded with these settings against this code; ${todo.length} to run, about ${hours(todo.length * 95_000)} at about 95 seconds each`));
console.log(dim(`  results: ${path.relative(REPO_ROOT, file)}`));

let ran = 0;
let failed = 0;
const batchStarted = Date.now();
for (const seed of todo) {
  if (stopping) break;
  const unavailable = await preflight();
  if (unavailable) {
    console.log(red(`  stopping before seed ${seed}: ${unavailable}. Nothing was recorded for it; run the same command again to resume.`));
    process.exit(2);
  }
  const record = await runSeed(seed);
  await appendFile(file, `${JSON.stringify(record)}\n`);
  ran++;
  const counts = record.settled === null ? "" : dim(` ${record.settled} settled, ${record.faultsSurvived} faults, ${record.checks} checks`);
  console.log(`  seed ${String(seed).padStart(4)}  ${record.ok ? green("held") : red("FAILED")}  ${Math.round(record.durationMs / 1000)}s${counts}`);
  if (record.leftovers) console.log(red("      processes of this seed were still running when it ended: killed"));
  if (!record.ok) {
    failed++;
    for (const line of record.failure ?? []) console.log(red(`      ${line.trim()}`));
    console.log(`      reproduce: ${bold(record.reproduce)}`);
    if (!keepGoing) break;
  }
}
console.log(
  `\n  ${ran} seeds run in ${hours(Date.now() - batchStarted)}, ${ran - failed} held, ${failed} failed. ${dim("pnpm sim:seeds --summary for every seed recorded")}`,
);
process.exit(failed > 0 ? 1 : 0);
