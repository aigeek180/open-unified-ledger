import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { deployScenario, type Deployment, type Network, REPO_ROOT, writeDeployment } from "@oul/chain";
import type { Scenario } from "@oul/scenario";
import { type Check, Checker } from "./harness/checker.ts";
import { Harness } from "./harness/actions.ts";
import { type FaultKind, NotApplicable, runFault } from "./harness/faults.ts";
import { type Action, Model, Rng } from "./harness/model.ts";
import { launchServices, type Services } from "./launch.ts";

/** One step of a run: a flow or a fault, what it did, and whether it went as expected. */
export interface Step {
  readonly n: number;
  readonly kind: "action" | "fault";
  readonly label: string;
  readonly outcome: string;
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly at: string;
}

export interface RunOptions {
  readonly scenario: Scenario;
  readonly scenarioDir: string;
  readonly network: Network;
  readonly seed: number;
  readonly databaseUrl: string;
  /** Each service's output, as well as being written to the run's log file. */
  readonly print?: (line: string) => void;
  /** Called as each step finishes. */
  readonly onStep?: (step: Step) => void;
}

/**
 * A simulation run (SPEC.md §9): the scenario deployed afresh, every
 * participant's service as its own process, and every block checked against
 * the invariants as soon as every participant has processed it. The CLI
 * drives one to the end; serve mode keeps one open for the console.
 */
export class SimulationRun {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
  readonly seed: number;
  readonly logFile: string;
  readonly harness: Harness;
  readonly services: Services;
  readonly steps: Step[] = [];
  readonly failures: Check[] = [];
  settled = 0;
  refused = 0;
  faults = 0;
  blocksChecked = 0;
  checksRun = 0;
  checkedThrough: bigint;
  /** The latest whole-run checks, once run. */
  lastGlobal: Check[] | null = null;

  private readonly checker: Checker;
  private readonly log: WriteStream;
  private readonly onStep: ((step: Step) => void) | undefined;
  private stopping = false;
  private watcher: Promise<void> | undefined;

  private constructor(init: {
    options: RunOptions;
    deployment: Deployment;
    services: Services;
    checker: Checker;
    log: WriteStream;
    logFile: string;
  }) {
    const { options } = init;
    this.scenario = options.scenario;
    this.deployment = init.deployment;
    this.seed = options.seed;
    this.services = init.services;
    this.checker = init.checker;
    this.log = init.log;
    this.logFile = init.logFile;
    this.onStep = options.onStep;
    this.checkedThrough = BigInt(init.deployment.startBlock);
    this.harness = new Harness({
      scenario: options.scenario,
      deployment: init.deployment,
      network: options.network,
      services: init.services,
      model: new Model(options.scenario),
      rng: new Rng(options.seed),
    });
  }

  static async start(options: RunOptions): Promise<SimulationRun> {
    const { scenario, network } = options;
    const { deployment } = await deployScenario(scenario, network, { force: true });
    await writeDeployment(deployment);

    const runsDir = path.join(REPO_ROOT, "sim/runs");
    mkdirSync(runsDir, { recursive: true });
    const logFile = path.join(runsDir, `${scenario.id}-${options.seed}.log`);
    const log = createWriteStream(logFile);
    const services = launchServices(scenario, options.scenarioDir, {
      // Short deadlines, so a refused instruction's other side expires within the run.
      env: { OUL_DEADLINE_SECONDS: "45", OUL_POLL_MS: "500" },
      print: (line) => {
        log.write(`${line}\n`);
        options.print?.(line);
      },
    });
    const checker = new Checker(scenario, deployment, network);
    try {
      await checker.open(options.databaseUrl);
      await services.ready;
    } catch (error) {
      // Nothing will stop what was started if the run never begins: stop it here.
      await services.stop();
      await checker.close().catch(() => {});
      log.end();
      throw error;
    }
    const run = new SimulationRun({ options, deployment, services, checker, log, logFile });
    run.watcher = run.watch();
    return run;
  }

  // ---------------------------------------------------------------- per-block checks

  private async checkCaughtUpBlocks(): Promise<void> {
    const cursors = await this.checker.cursors();
    const everyone = [...cursors.values()].reduce((min, c) => (c < min ? c : min));
    while (this.checkedThrough < everyone && this.failures.length === 0) {
      this.checkedThrough++;
      const checks = await this.checker.atBlock(this.checkedThrough);
      this.blocksChecked++;
      this.checksRun += checks.length;
      this.failures.push(...checks.filter((c) => !c.ok));
    }
  }

  private async watch(): Promise<void> {
    while (!this.stopping) {
      await this.checkCaughtUpBlocks().catch((error) =>
        this.failures.push({ invariant: "-", what: "checker", ok: false, detail: String(error) }),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ---------------------------------------------------------------- steps

  private record(step: Omit<Step, "n" | "at">): Step {
    const full = { ...step, n: this.steps.length + 1, at: new Date().toISOString() };
    this.steps.push(full);
    if (!step.ok) this.failures.push({ invariant: "-", what: `step ${full.n}: ${step.label}`, ok: false, detail: step.outcome });
    this.onStep?.(full);
    return full;
  }

  /** Perform one flow to its outcome, keeping the model in step. */
  async action(action: Action): Promise<Step> {
    const label = this.harness.describe(action);
    try {
      const outcome = await this.harness.perform(action);
      if (outcome.startsWith("refused")) this.refused++;
      else this.settled++;
      return this.record({ kind: "action", label, outcome, ok: true, skipped: false });
    } catch (error) {
      return this.record({ kind: "action", label, outcome: (error as Error).message, ok: false, skipped: false });
    }
  }

  /**
   * For a scenario with repo (SPEC.md §5.7–§5.10): the banks that may lend
   * and borrow fund wholesale and buy every collateral bond at issue, so the
   * run has collateral to pledge. Deterministic, so seeds still reproduce.
   */
  async prelude(): Promise<void> {
    const spec = this.scenario.repo;
    if (!spec) return;
    const model = this.harness.model;
    const bonds = this.scenario.instruments.bonds.filter((b) => spec.collateral.includes(b.symbol));
    const agents = new Set(bonds.map((b) => b.agent));
    const parties = this.harness.banks.filter((b) => !agents.has(b));
    for (const bank of parties) {
      if (this.failures.length) return;
      for (const [currency, rtgs] of model.banks.get(bank)!.rtgs) await this.action({ kind: "fund", bank, currency, amount: rtgs / 10n });
    }
    for (const bond of bonds) {
      if (this.failures.length) return;
      await this.action({ kind: "bond-issue", bond: bond.symbol, agent: bond.agent, allocations: parties.map((bank) => ({ bank, units: 20_000n })) });
    }
  }

  /** Inject one fault; it checks the outcome it expects while the per-block checks run underneath. */
  async fault(kind: FaultKind): Promise<Step> {
    const label = `FAULT ${kind}`;
    try {
      const outcome = await runFault(this.harness, kind);
      this.faults++;
      return this.record({ kind: "fault", label, outcome, ok: true, skipped: false });
    } catch (error) {
      if (error instanceof NotApplicable) {
        return this.record({ kind: "fault", label, outcome: `skipped: ${error.message}`, ok: true, skipped: true });
      }
      return this.record({ kind: "fault", label, outcome: (error as Error).message, ok: false, skipped: false });
    }
  }

  /** A failure from outside the steps, such as a service exiting. */
  fail(what: string): void {
    this.failures.push({ invariant: "-", what, ok: false });
  }

  /**
   * Let every participant catch up to the head, check the blocks left, then
   * the whole run (invariants 4 to 7 and 9). Within `timeoutMs` or as far as
   * they got.
   */
  async checkAll(timeoutMs = 60_000): Promise<Check[]> {
    const head = await this.checker.head();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cursors = await this.checker.cursors();
      if ([...cursors.values()].every((c) => c >= head)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await this.checkCaughtUpBlocks();
    const global = await this.checker.global();
    this.checksRun += global.length;
    this.failures.push(...global.filter((c) => !c.ok));
    this.lastGlobal = global;
    return global;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.watcher?.catch(() => {});
    await this.services.stop();
    await this.checker.close();
    this.log.end();
  }
}
