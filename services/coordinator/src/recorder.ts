import type { Hex } from "viem";
import { type InteropWorld, type Ledger, type LockState, sleep } from "./ledgers.ts";

/**
 * Every leg's state over time (SPEC.md §7). A transfer has parts, each
 * settled or released as one on its own ledger: the unified baseline has one
 * part on the shared ledger; the split transfer has ledger 1's part (the
 * payer's burn and the wholesale transfer) and ledger 2's (the payee's mint).
 * The recorder polls each part's state on its ledger and keeps every change,
 * with the block, the ledger's clock and the time since the run began.
 */

export type PartKey = "shared" | "ledger1" | "ledger2";

export interface Change {
  readonly part: PartKey;
  readonly state: LockState;
  /** Milliseconds since the run began. */
  readonly ms: number;
  readonly block: string;
  /** The ledger's clock, seconds since 1970. */
  readonly chainTime: string;
}

/** How a run ended: both ledgers moved, neither did, they disagree, or a part is still held. */
export type Outcome = "committed" | "aborted" | "inconsistent" | "stuck";

export interface Summary {
  readonly outcome: Outcome;
  readonly final: Readonly<Record<string, LockState>>;
  /**
   * How long one part had settled while another had not: the window in which
   * the two ledgers disagreed. Zero for the unified baseline; null when no
   * part settled.
   */
  readonly disagreedMs: number | null;
  /** Whether that disagreement was still open when the run ended. */
  readonly disagreesAtEnd: boolean;
  /** When the last part reached its final state. */
  readonly finalAtMs: number | null;
}

interface Part {
  readonly key: PartKey;
  readonly ledger: Ledger;
  readonly read: () => Promise<LockState>;
}

export class Recorder {
  readonly changes: Change[] = [];
  private readonly parts: Part[];
  private readonly startedAt = Date.now();
  private readonly current = new Map<PartKey, LockState>();
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(world: InteropWorld, id: Hex, mode: "unified" | "split") {
    this.parts =
      mode === "unified"
        ? [{ key: "shared", ledger: world.l1, read: async () => ((await world.settledAt(id)) > 0n ? "settled" : "none") }]
        : [
            { key: "ledger1", ledger: world.l1, read: async () => (await world.l1.lockOf(id)).state },
            { key: "ledger2", ledger: world.l2, read: async () => (await world.l2.lockOf(id)).state },
          ];
    for (const part of this.parts) this.current.set(part.key, "none");
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  start(): void {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        await this.poll().catch(() => {});
        await sleep(250);
      }
    })();
  }

  async stop(): Promise<void> {
    await this.poll().catch(() => {});
    this.running = false;
    await this.loop;
  }

  private async poll(): Promise<void> {
    for (const part of this.parts) {
      const state = await part.read();
      if (state === this.current.get(part.key)) continue;
      const block = await part.ledger.client.getBlock();
      this.current.set(part.key, state);
      this.changes.push({ part: part.key, state, ms: this.elapsed(), block: block.number.toString(), chainTime: block.timestamp.toString() });
    }
  }

  /** Every part has reached settled or released, or the unified part settled. */
  done(): boolean {
    return [...this.current.values()].every((s) => s === "settled" || s === "released");
  }

  summary(): Summary {
    const final = Object.fromEntries(this.current) as Record<string, LockState>;
    const states = [...this.current.values()];
    const settled = states.filter((s) => s === "settled").length;
    let outcome: Outcome;
    if (states.some((s) => s === "locked")) outcome = "stuck";
    else if (settled === states.length) outcome = "committed";
    else if (settled === 0) outcome = "aborted";
    else outcome = "inconsistent";

    const settledAt = this.parts
      .map((p) => this.changes.find((c) => c.part === p.key && c.state === "settled")?.ms)
      .filter((ms): ms is number => ms !== undefined);
    const disagreesAtEnd = settled > 0 && settled < states.length;
    const disagreedMs =
      settledAt.length === 0 ? null : (disagreesAtEnd ? this.elapsed() : Math.max(...settledAt)) - Math.min(...settledAt);
    const terminal = this.changes.filter((c) => c.state === "settled" || c.state === "released").map((c) => c.ms);
    return {
      outcome,
      final,
      disagreedMs,
      disagreesAtEnd,
      finalAtMs: this.done() && terminal.length ? Math.max(...terminal) : null,
    };
  }
}
