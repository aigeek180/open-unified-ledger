import type { Scenario } from "@oul/scenario";
import type { Books, Capabilities, Directory, Observation, Outcome, Settlement } from "./adapter.ts";
import type { KitFlow, Leg, Party, Step } from "./flows.ts";

/**
 * Everything one run of the kit recorded: the steps it took, every flow it
 * asked for or a fault sent, with the engine's outcome and the legs the kit
 * expected, what each ledger said at every block from the end of setup to
 * the end of the run, and, for an engine that keeps books, each
 * participant's books at every block where something moved. The checks
 * read this and nothing else.
 */
export interface Trace {
  readonly scenario: Scenario;
  readonly directory: Directory;
  readonly capabilities: Capabilities;
  readonly steps: readonly Step[];
  readonly flows: readonly FlowRecord[];
  /** Per step, what happened: a fault's note, or why a step was skipped. */
  readonly notes: readonly string[];
  /** Per ledger, one observation per block, in order, from the last block of setup to the head. */
  readonly observations: ReadonlyMap<string, readonly Observation[]>;
  /** Per participant, its books at the last block of setup and at every block where tokens moved, on the first ledger. */
  readonly books: ReadonlyMap<string, ReadonlyMap<bigint, Books>>;
}

export interface FlowRecord {
  readonly flow: KitFlow;
  readonly outcome: Outcome;
  /** What the flow must move (SPEC.md §5), as the kit computed it before asking. */
  readonly legs: readonly Leg[];
  /**
   * What the flow does to banks' deposit liabilities beyond its deposit
   * tokens' legs: at a bond's agent, the issuer's proceeds credited and its
   * payments debited (SPEC.md §5.4, §5.6).
   */
  readonly deposits?: Readonly<Record<string, bigint>>;
  /** Who asked: the kit, a fault running a flow as any flow, or a fault sending it around the participants. */
  readonly source: "kit" | "fault" | "attempt";
  /** The step that asked for it. */
  readonly step: number;
}

/** Lookups every check needs, built once per trace. */
export class TraceIndex {
  readonly trace: Trace;
  /** The first record for each id: an attempt that resends an id is the same instruction. */
  readonly byId = new Map<string, FlowRecord>();
  /** Every settlement under each id, in ledger order, then block, then position. */
  readonly settlementsById = new Map<string, Settlement[]>();
  readonly unattributed: Settlement[] = [];
  private readonly parties = new Map<string, Party>();
  private readonly symbols = new Map<string, string>();

  constructor(trace: Trace) {
    this.trace = trace;
    for (const record of trace.flows) if (!this.byId.has(record.flow.id)) this.byId.set(record.flow.id, record);
    for (const ledger of trace.directory.ledgers) {
      for (const observation of (trace.observations.get(ledger) ?? []).slice(1)) {
        for (const s of [...observation.settlements].sort((a, b) => a.index - b.index)) {
          if (s.id === null) this.unattributed.push(s);
          else this.settlementsById.set(s.id, [...(this.settlementsById.get(s.id) ?? []), s]);
        }
      }
    }
    const { directory } = trace;
    for (const [id, p] of Object.entries(directory.participants)) this.parties.set(p.address.toLowerCase(), id);
    for (const [ref, c] of Object.entries(directory.customers)) this.parties.set(c.address.toLowerCase(), ref);
    for (const [key, t] of Object.entries(directory.tokens)) this.symbols.set(key, t.symbol);
  }

  get directory(): Directory {
    return this.trace.directory;
  }

  /** The party at an address, if the directory names it. */
  partyAt(address: string | null): Party | undefined {
    return address === null ? undefined : this.parties.get(address.toLowerCase());
  }

  /** The participant at an address, if it is one (not a customer). */
  participantAt(address: string | null): string | undefined {
    const party = this.partyAt(address);
    return party && this.directory.participants[party] ? party : undefined;
  }

  addressOf(party: Party): string {
    const address = this.directory.participants[party]?.address ?? this.directory.customers[party]?.address;
    if (!address) throw new RangeError(`The directory names no party "${party}"`);
    return address.toLowerCase();
  }

  symbolOf(token: string): string {
    return this.symbols.get(token) ?? token;
  }

  /** The token with this symbol on the ledger books follow: the first ledger. */
  bookToken(symbol: string): string | undefined {
    const ledger = this.directory.ledgers[0];
    return Object.entries(this.directory.tokens).find(([, t]) => t.symbol === symbol && t.ledger === ledger)?.[0];
  }

  observation(ledger: string, block: bigint): Observation | undefined {
    const list = this.trace.observations.get(ledger) ?? [];
    const first = list[0];
    if (!first) return undefined;
    return list[Number(block - first.block)];
  }

  /** Describe a movement for a report: token, from and to by party where the directory names them. */
  describe(m: { token: string; from: string | null; to: string | null; amount: bigint }): string {
    const who = (a: string | null) => (a === null ? "∅" : (this.partyAt(a) ?? a));
    return `${m.amount} ${this.symbolOf(m.token)} ${who(m.from)}→${who(m.to)}`;
  }
}
