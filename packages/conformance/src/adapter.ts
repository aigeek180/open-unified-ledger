import type { CurrencyCode } from "@oul/domain";
import type { Scenario } from "@oul/scenario";
import type { FaultStep, FlowKind, KitFlow, PaymentParties } from "./flows.ts";

/**
 * What an engine under test implements so the conformance kit can check it
 * (SPEC.md §14). The kit supplies a scenario, asks for flows, and reads back
 * only what this interface exposes: what each ledger says at each block and,
 * if the engine keeps them, each participant's books as of a block. Every
 * check is stated against these answers alone; docs/conformance.md says, for
 * each check, which of them it needs and what it cannot see.
 *
 * Addresses are lower-case hex; amounts are integer token units (a cash
 * token's minor units, a bond's units), never a JavaScript number.
 */
export interface EngineAdapter {
  /** A short name for reports: "sandbox", or a broken engine's. */
  readonly name: string;
  /** The flows and faults this engine can run, and whether it keeps books. */
  readonly capabilities: Capabilities;
  /** A fresh deployment of `scenario`, set up and ready: who and what is where. */
  reset(scenario: Scenario): Promise<Directory>;
  /**
   * Start a flow and wait for its outcome at the engine: settled on a ledger,
   * or refused (by the engine, or by a participant before anything was sent).
   * The flow carries its own id, which the engine settles it under.
   */
  submit(flow: KitFlow): Promise<Outcome>;
  /** The latest block on a ledger. */
  head(ledger: string): Promise<bigint>;
  /** What a ledger says at a block (SPEC.md §14, `observe(block)`). */
  observe(ledger: string, block: bigint): Promise<Observation>;
  /**
   * A participant's books as of a block: what they say each on-ledger balance
   * it mirrors is. Present only for an engine that keeps books
   * (`capabilities.books`). Asked once the run is over, after `quiesce`.
   */
  books?(participant: string, block: bigint): Promise<Books>;
  /** Stage one of the faults the engine declares, and report what it did. */
  fault?(step: FaultStep): Promise<FaultReport>;
  /** Wait until every participant has caught up with every ledger's head. */
  quiesce(): Promise<void>;
  /** Release whatever `reset` started. */
  close(): Promise<void>;
}

export interface Capabilities {
  readonly flows: readonly FlowKind[];
  readonly faults: readonly FaultStep["fault"][];
  readonly books: boolean;
  /**
   * The payments the engine can make, when it cannot make every one between
   * any two banks: interop mode moves one payer's payments to one payee
   * across its two ledgers.
   */
  readonly routes?: readonly PaymentParties[];
}

/** Who and what a fresh deployment put where. */
export interface Directory {
  /** The ledgers the engine settles on, by name; one for a unified ledger. */
  readonly ledgers: readonly string[];
  /** On each ledger, the last block of setup: the kit observes from the block after it. */
  readonly startBlocks: Readonly<Record<string, bigint>>;
  /** Each central bank and bank of the scenario, by id. */
  readonly participants: Readonly<Record<string, { readonly address: string; readonly kind: "central-bank" | "bank" }>>;
  /** Each bank's customers, keyed `<bank>/<customer>`. */
  readonly customers: Readonly<Record<string, { readonly address: string; readonly bank: string }>>;
  /**
   * Every token, keyed by symbol, or `<symbol>@<ledger>` for a token the
   * scenario puts on more than one ledger.
   */
  readonly tokens: Readonly<Record<string, TokenInfo>>;
  /**
   * What setup gave banks and customers to pay with, for an engine that
   * funds them itself rather than through the kit's fund and tokenize flows.
   */
  readonly funded?: {
    readonly wholesale: readonly { readonly bank: string; readonly currency: CurrencyCode; readonly amount: bigint }[];
    readonly tokenized: readonly { readonly bank: string; readonly customer: string; readonly amount: bigint }[];
  };
}

export interface TokenInfo {
  readonly symbol: string;
  readonly ledger: string;
  readonly address: string;
  readonly kind: "wholesale" | "deposit" | "bond";
  /** The participant whose liability it is (a bond's agent, for a bond), and so whose approval mints it. */
  readonly issuer: string;
  readonly currency: CurrencyCode;
}

/** How a flow ended at the engine. */
export interface Outcome {
  readonly status: "settled" | "refused";
  /** Why it was refused: the engine's error, or the participant's reason. */
  readonly reason?: string;
  /** For a payment across currencies, the dealer's quote it was asked at. */
  readonly quote?: { readonly rate: string; readonly source: bigint; readonly target: bigint };
}

/** One movement of a token, as an ERC-20 transfer reports it: a mint has no `from`, a burn no `to`. */
export interface Movement {
  /** The token's key in the directory. */
  readonly token: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly amount: bigint;
}

/** One transaction that moved tokens, and the instruction it settled, if any. */
export interface Settlement {
  readonly ledger: string;
  readonly block: bigint;
  readonly tx: string;
  /** Its position among the block's transactions. */
  readonly index: number;
  /** The instruction id it settled, or null for a movement outside any instruction. */
  readonly id: string | null;
  /**
   * The participants whose approval it carried and the engine could check:
   * whoever sent it, and every valid co-signature over what it settled.
   */
  readonly approvers: readonly string[];
  readonly movements: readonly Movement[];
}

/** What a ledger says at a block: what settled in it, and balances, supplies and holders after it. */
export interface Observation {
  readonly ledger: string;
  readonly block: bigint;
  /** The block's timestamp, seconds since 1970. */
  readonly time: bigint;
  readonly settlements: readonly Settlement[];
  /**
   * Balances of every token on this ledger, for every address the directory
   * names and every address that has received the token.
   */
  readonly balances: readonly Holding[];
  /** Total supply of every token on this ledger, by key. */
  readonly supplies: Readonly<Record<string, bigint>>;
  /**
   * For each token and holder in `balances`: whether the token's issuer has
   * admitted the holder (a deposit token's allowlist, a wholesale token's
   * reserve accounts, a bond's identity registry), as the issuer records it, apart
   * from whatever the token enforces; and how much of its balance is frozen.
   */
  readonly holders: readonly HolderStatus[];
}

export interface Holding {
  readonly token: string;
  readonly holder: string;
  readonly amount: bigint;
}

export interface HolderStatus {
  readonly token: string;
  readonly holder: string;
  readonly admitted: boolean;
  readonly frozen: bigint;
}

/** A participant's books as of a block, in token units. */
export interface Books {
  /** Over every posted entry, debits minus credits per currency: zero when the books balance. */
  readonly imbalance: Readonly<Record<string, bigint>>;
  /** Every on-ledger balance these books mirror, and what the books say it is. */
  readonly holdings: readonly Holding[];
  /** Each token this participant issues: the liability its books record for it. */
  readonly issued: readonly { readonly token: string; readonly amount: bigint }[];
  /** A bank's deposit liabilities in its own currency, ordinary and tokenized together. */
  readonly deposits?: bigint;
  /**
   * For a bank party to repos (SPEC.md §5.7–§5.10): the collateral its record
   * shows for each repo open at the block, by the id of the flow that opened
   * it, as lender or as borrower.
   */
  readonly repos?: readonly { readonly repo: string; readonly role: "lender" | "borrower"; readonly collateral: readonly { readonly bond: string; readonly units: bigint }[] }[];
}

/** What a fault did: the flows it ran, and anything else it sent to the engine. */
export interface FaultReport {
  /** Flows the fault ran through the engine as any flow, with their outcomes. */
  readonly submitted: readonly { readonly flow: KitFlow; readonly outcome: Outcome }[];
  /**
   * Instructions the fault sent straight to the engine, around the
   * participants: a resubmission of one that settled, or one with approvals
   * that do not cover it. The kit judges whatever the engine did with them.
   */
  readonly attempts: readonly Attempt[];
  /** One line on what happened, for the report. */
  readonly note: string;
}

export interface Attempt {
  readonly flow: KitFlow;
  /** Whose approval the attempt carried, besides whoever sent it. */
  readonly carried: readonly string[];
  readonly outcome: Outcome;
}

/** A fault the adapter cannot stage now (nothing to act on), skipped rather than failed. */
export class FaultNotApplicable extends Error {
  override readonly name = "FaultNotApplicable";
}
