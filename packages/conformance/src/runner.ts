import type { Scenario } from "@oul/scenario";
import { type Books, type Directory, type EngineAdapter, FaultNotApplicable, type Observation, type Outcome } from "./adapter.ts";
import { type CheckName, type CheckResult, runChecks } from "./checks.ts";
import { describeStep, type KitFlow, legsOf, type Step } from "./flows.ts";
import { Generator } from "./generator.ts";
import { Model, Rng } from "./model.ts";
import { scriptedSteps } from "./script.ts";
import type { FlowRecord, Trace } from "./trace.ts";

/**
 * Running the kit (SPEC.md §14): a fresh deployment, the steps one at a
 * time, each waiting for its outcome, the ledgers observed block by block as
 * they go, every participant's books read once the run is over, then every
 * check over what was recorded. A run that fails a check is shrunk: steps
 * are taken away while the same check still fails, each attempt on a fresh
 * deployment, to the smallest sequence found that reproduces it.
 */

export interface RunResult {
  /** "scripted", or "seed <n>". */
  readonly label: string;
  readonly seed?: number;
  readonly steps: readonly Step[];
  readonly trace: Trace;
  readonly checks: readonly CheckResult[];
  readonly durationMs: number;
  /** For a run that failed: the smallest sequence found that fails the first failing check. */
  readonly minimal?: Minimal;
}

export interface Minimal {
  readonly check: CheckName;
  readonly steps: readonly Step[];
  /** How many fresh runs shrinking took. */
  readonly replays: number;
  /** Whether shrinking stopped at its budget rather than at a sequence it could not shrink. */
  readonly budgetSpent: boolean;
}

export interface KitReport {
  readonly engine: string;
  readonly scenario: string;
  readonly runs: readonly RunResult[];
  /** Every check passed or was skipped, in every run. */
  readonly passed: boolean;
}

export interface KitOptions {
  /** Run the scripted sequence: every supported flow, then every declared fault once. Default true. */
  readonly scripted?: boolean;
  /** Seeded random runs, one per seed. */
  readonly seeds?: readonly number[];
  /** Steps per seeded run. Default 20. */
  readonly steps?: number;
  /** The share of seeded steps that are faults, among those the adapter declares. Default 0.25. */
  readonly faultRate?: number;
  /** Fresh runs shrinking may use per failing run; 0 turns it off. Default 32. */
  readonly shrinkBudget?: number;
  readonly log?: (line: string) => void;
}

/** One run in progress: the model, the records, and how far each ledger has been observed. */
class Run {
  readonly model: Model;
  readonly flows: FlowRecord[] = [];
  readonly notes: string[] = [];
  readonly steps: Step[] = [];
  private readonly observations = new Map<string, Observation[]>();
  private readonly adapter: EngineAdapter;
  private readonly scenario: Scenario;
  private readonly directory: Directory;

  constructor(adapter: EngineAdapter, scenario: Scenario, directory: Directory) {
    this.adapter = adapter;
    this.scenario = scenario;
    this.directory = directory;
    this.model = new Model(scenario);
    if (directory.funded) this.model.seed(directory.funded);
  }

  private legs(flow: KitFlow) {
    return legsOf(flow, this.scenario, { bondPayment: (bond) => this.model.nextBondPayment(bond), repo: (id) => this.model.repo(id) });
  }

  /** What a bond flow does to its agent's deposits: the issuer's account there, credited or debited. */
  private deposits(flow: KitFlow): Record<string, bigint> | undefined {
    if (flow.kind !== "bond-issue" && flow.kind !== "bond-payment") return undefined;
    const agent = this.scenario.instruments.bonds.find((b) => b.symbol === flow.bond)!.agent;
    if (flow.kind === "bond-issue") return { [agent]: flow.allocations.reduce((t, a) => t + a.units * flow.price, 0n) };
    const next = this.model.nextBondPayment(flow.bond);
    return next ? { [agent]: -next.issuerDebit } : undefined;
  }

  private record(flow: KitFlow, outcome: Outcome, source: FlowRecord["source"], legs = this.legs(flow), deposits = this.deposits(flow)) {
    this.flows.push({ flow, outcome, legs, source, step: this.steps.length - 1, ...(deposits ? { deposits } : {}) });
    this.model.apply(flow, outcome);
  }

  async step(step: Step): Promise<string> {
    this.steps.push(step);
    let note: string;
    if ("flow" in step) {
      const [legs, deposits] = [this.legs(step.flow), this.deposits(step.flow)];
      const outcome = await this.adapter.submit(step.flow);
      this.record(step.flow, outcome, "kit", legs, deposits);
      note = outcome.status === "settled" ? "settled" : `refused: ${outcome.reason ?? "no reason given"}`;
    } else if (!this.adapter.fault || !this.adapter.capabilities.faults.includes(step.fault.fault)) {
      note = `skipped: the engine does not stage ${step.fault.fault}`;
    } else {
      try {
        const report = await this.adapter.fault(step.fault);
        for (const { flow, outcome } of report.submitted) this.record(flow, outcome, "fault");
        for (const attempt of report.attempts) this.record(attempt.flow, attempt.outcome, "attempt");
        note = report.note;
      } catch (error) {
        if (!(error instanceof FaultNotApplicable)) throw error;
        note = `skipped: ${error.message}`;
      }
    }
    this.notes.push(note);
    await this.observe();
    return note;
  }

  /** Observe every block on every ledger from the last observed (or the end of setup) to the head. */
  async observe(): Promise<void> {
    for (const ledger of this.directory.ledgers) {
      const list = this.observations.get(ledger) ?? [];
      this.observations.set(ledger, list);
      const head = await this.adapter.head(ledger);
      const start = this.directory.startBlocks[ledger] ?? 0n;
      for (let block = list.length === 0 ? start : list.at(-1)!.block + 1n; block <= head; block++) {
        list.push(await this.adapter.observe(ledger, block));
      }
    }
  }

  /** Let every participant catch up, observe to the end, and read the books where tokens moved. */
  async finish(): Promise<Trace> {
    await this.adapter.quiesce();
    await this.observe();
    const books = new Map<string, Map<bigint, Books>>();
    const ledger = this.directory.ledgers[0]!;
    if (this.adapter.capabilities.books && this.adapter.books) {
      const list = this.observations.get(ledger)!;
      const blocks = [list[0]!.block, ...list.slice(1).filter((o) => o.settlements.length > 0).map((o) => o.block), list.at(-1)!.block];
      for (const participant of Object.keys(this.directory.participants)) {
        const byBlock = new Map<bigint, Books>();
        for (const block of new Set(blocks)) byBlock.set(block, await this.adapter.books(participant, block));
        books.set(participant, byBlock);
      }
    }
    return {
      scenario: this.scenario,
      directory: this.directory,
      capabilities: this.adapter.capabilities,
      steps: this.steps,
      flows: this.flows,
      notes: this.notes,
      observations: this.observations,
      books,
    };
  }
}

/** Run fixed steps on a fresh deployment. */
export async function runSteps(adapter: EngineAdapter, scenario: Scenario, steps: readonly Step[], log?: (line: string) => void): Promise<Trace> {
  return runOn(adapter, scenario, await adapter.reset(scenario), steps, log);
}

/** The scripted run (script.ts) on a fresh deployment, built for what its setup funded. */
export async function runScripted(adapter: EngineAdapter, scenario: Scenario, log?: (line: string) => void): Promise<Trace> {
  const directory = await adapter.reset(scenario);
  return runOn(adapter, scenario, directory, scriptedSteps(scenario, adapter.capabilities, directory.funded), log);
}

async function runOn(adapter: EngineAdapter, scenario: Scenario, directory: Directory, steps: readonly Step[], log?: (line: string) => void): Promise<Trace> {
  const run = new Run(adapter, scenario, directory);
  await run.observe();
  for (const [n, step] of steps.entries()) {
    const note = await run.step(step);
    log?.(`  ${String(n + 1).padStart(3)}. ${describeStep(step, scenario)}: ${note}`);
  }
  return run.finish();
}

/** Run `count` steps drawn from `seed` on a fresh deployment, each drawn after the one before settles. */
export async function runSeeded(
  adapter: EngineAdapter,
  scenario: Scenario,
  options: { seed: number; steps: number; faultRate: number },
  log?: (line: string) => void,
): Promise<Trace> {
  const run = new Run(adapter, scenario, await adapter.reset(scenario));
  await run.observe();
  const generator = new Generator(run.model, new Rng(options.seed), adapter.capabilities, options.faultRate);
  for (let n = 0; n < options.steps; n++) {
    const step = generator.next();
    const note = await run.step(step);
    log?.(`  ${String(n + 1).padStart(3)}. ${describeStep(step, scenario)}: ${note}`);
  }
  return run.finish();
}

/**
 * The smallest sequence found that still fails `check`, within `budget`
 * fresh runs: first the shortest failing prefix, by bisection (what comes
 * after the step that breaks the engine cannot matter), then delta
 * debugging over what is left, removing ever smaller chunks while the check
 * still fails. Each candidate runs on a fresh deployment.
 */
export async function shrink(
  adapter: EngineAdapter,
  scenario: Scenario,
  steps: readonly Step[],
  check: CheckName,
  budget: number,
  log?: (line: string) => void,
): Promise<Minimal> {
  let replays = 0;
  const fails = async (candidate: readonly Step[]) => {
    replays++;
    const results = runChecks(await runSteps(adapter, scenario, candidate));
    return results.find((r) => r.name === check)?.status === "fail";
  };
  // The whole sequence fails; find the shortest prefix that still does.
  let [low, high] = [1, steps.length];
  while (low < high && replays < budget) {
    const middle = Math.floor((low + high) / 2);
    if (await fails(steps.slice(0, middle))) high = middle;
    else low = middle + 1;
  }
  let current = steps.slice(0, high);
  log?.(`  shortest failing prefix: ${current.length} steps`);
  for (let size = Math.max(1, Math.floor(current.length / 2)); size >= 1 && replays < budget; ) {
    let removed = false;
    for (let start = 0; start < current.length && replays < budget; start += size) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if (candidate.length === 0 || !(await fails(candidate))) continue;
      current = candidate;
      removed = true;
      log?.(`  shrunk to ${current.length} steps`);
      start -= size;
    }
    if (!removed) size = Math.floor(size / 2);
    else size = Math.min(size, Math.max(1, Math.floor(current.length / 2)));
  }
  return { check, steps: current, replays, budgetSpent: replays >= budget };
}

/** The conformance kit against one engine and one scenario: the scripted run and each seeded run. */
export async function conformance(adapter: EngineAdapter, scenario: Scenario, options: KitOptions = {}): Promise<KitReport> {
  const log = options.log;
  const runs: RunResult[] = [];
  const plans: { label: string; seed?: number }[] = [
    ...(options.scripted === false ? [] : [{ label: "scripted" }]),
    ...(options.seeds ?? []).map((seed) => ({ label: `seed ${seed}`, seed })),
  ];
  for (const plan of plans) {
    log?.(`${adapter.name} on ${scenario.id}, ${plan.label}:`);
    const started = Date.now();
    const trace =
      plan.seed === undefined
        ? await runScripted(adapter, scenario, log)
        : await runSeeded(adapter, scenario, { seed: plan.seed, steps: options.steps ?? 20, faultRate: options.faultRate ?? 0.25 }, log);
    const checks = runChecks(trace);
    const first = checks.find((c) => c.status === "fail");
    const budget = options.shrinkBudget ?? 32;
    const minimal = first && budget > 0 ? await shrink(adapter, scenario, trace.steps, first.name, budget, log) : undefined;
    runs.push({
      label: plan.label,
      ...(plan.seed === undefined ? {} : { seed: plan.seed }),
      steps: trace.steps,
      trace,
      checks,
      durationMs: Date.now() - started,
      ...(minimal ? { minimal } : {}),
    });
  }
  return {
    engine: adapter.name,
    scenario: scenario.id,
    runs,
    passed: runs.every((r) => r.checks.every((c) => c.status !== "fail")),
  };
}
