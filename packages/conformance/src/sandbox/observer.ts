import { contracts, idToUetr, participantIdHash } from "@oul/chain";
import {
  type Abi,
  type Address,
  type Hex,
  type Log,
  parseEventLogs,
  type PublicClient,
} from "viem";
import type { Directory, HolderStatus, Holding, Movement, Observation, Settlement } from "../adapter.ts";

/**
 * What one ledger says at one block (SPEC.md §14, `observe`), read from a
 * node and nothing else: every transaction that moved a directory token, as
 * its ERC-20 `Transfer` events report it, with the instruction id it settled
 * and the approvals it carried, checked here; then every token's balances,
 * supply and holder status after the block. A block in which none of the
 * watched contracts logged anything changes no balance, so its state is the
 * block before's.
 */

const { WholesaleToken, DepositToken, ParticipantRegistry, Bond, IdentityRegistry } = contracts;
const ALLOWED = 2; // ERC20Restricted.Restriction.ALLOWED
const BANK = 2; // ParticipantRegistry.Kind.Bank

/** What a transaction settled, according to the contract it called. */
export interface Identified {
  readonly id: string | null;
  readonly approvers: readonly string[];
}

/**
 * Tells, for one transaction that moved tokens, which instruction it
 * settled and whose approval it carried: the settlement engine's
 * `InstructionSettled`, or interop mode's conditional settlement.
 */
export type Identify = (tx: { hash: Hex; logs: readonly Log[] }) => Promise<Identified>;

export interface ObserverOptions {
  readonly ledger: string;
  readonly client: PublicClient;
  readonly directory: Directory;
  /** The registry the ledger's tokens answer to, for who is an active bank. */
  readonly registry: Address;
  /** Contracts whose logs say what a transaction settled: the engine, a conditional settlement. */
  readonly settlers: readonly Address[];
  readonly settlerAbi: Abi;
  readonly identify: Identify;
}

export class ChainObserver {
  private readonly o: ObserverOptions;
  private readonly tokens: [string, { address: Address; kind: string; issuer: string }][];
  /** Every address the directory names or that has received a token: whose balances an observation gives. */
  private readonly holders = new Set<string>();
  private last: Observation | undefined;

  constructor(options: ObserverOptions) {
    this.o = options;
    this.tokens = Object.entries(options.directory.tokens)
      .filter(([, t]) => t.ledger === options.ledger)
      .map(([key, t]) => [key, { address: t.address as Address, kind: t.kind, issuer: t.issuer }]);
    for (const p of Object.values(options.directory.participants)) this.holders.add(p.address.toLowerCase());
    for (const c of Object.values(options.directory.customers)) this.holders.add(c.address.toLowerCase());
  }

  async observe(block: bigint): Promise<Observation> {
    const { client } = this.o;
    const tokenByAddress = new Map(this.tokens.map(([key, t]) => [t.address.toLowerCase(), key]));
    const [header, logs] = await Promise.all([
      client.getBlock({ blockNumber: block }),
      client.getLogs({ address: [...this.tokens.map(([, t]) => t.address), ...this.o.settlers, this.o.registry], fromBlock: block, toBlock: block }),
    ]);
    const byTx = new Map<Hex, Log[]>();
    for (const log of logs) {
      if (!log.transactionHash) continue;
      byTx.set(log.transactionHash, [...(byTx.get(log.transactionHash) ?? []), log]);
    }
    const settlements: Settlement[] = [];
    for (const [hash, txLogs] of byTx) {
      const transfers = parseEventLogs({ abi: WholesaleToken.abi, logs: txLogs, eventName: "Transfer", strict: false });
      const movements: Movement[] = transfers
        .filter((t) => tokenByAddress.has(t.address.toLowerCase()))
        .map((t) => {
          const { from, to, value } = t.args as { from: Address; to: Address; value: bigint };
          const zero = /^0x0+$/;
          for (const a of [from, to]) if (!zero.test(a)) this.holders.add(a.toLowerCase());
          return {
            token: tokenByAddress.get(t.address.toLowerCase())!,
            from: zero.test(from) ? null : from.toLowerCase(),
            to: zero.test(to) ? null : to.toLowerCase(),
            amount: value,
          };
        });
      if (movements.length === 0) continue;
      const { id, approvers } = await this.o.identify({ hash, logs: txLogs });
      settlements.push({ ledger: this.o.ledger, block, tx: hash, index: txLogs[0]!.transactionIndex ?? 0, id, approvers, movements });
    }
    settlements.sort((a, b) => a.index - b.index);

    const unchanged = this.last && this.last.block === block - 1n && logs.length === 0;
    const state = unchanged ? this.last! : await this.state(block);
    const observation: Observation = {
      ledger: this.o.ledger,
      block,
      time: header.timestamp,
      settlements,
      balances: state.balances,
      supplies: state.supplies,
      holders: state.holders,
    };
    this.last = observation;
    return observation;
  }

  /** Every token's balances, supply and holder status after `block`. */
  private async state(block: bigint): Promise<Pick<Observation, "balances" | "supplies" | "holders">> {
    const { client, directory, registry } = this.o;
    const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address, abi, functionName, args, blockNumber: block } as never) as Promise<unknown>;
    const holders = [...this.holders] as Address[];
    const banks = new Map<string, boolean>(
      await Promise.all(holders.map(async (h) => [h, (await read(registry, ParticipantRegistry.abi, "isActiveOfKind", [h, BANK])) as boolean] as const)),
    );
    const participantAt = new Map(Object.entries(directory.participants).map(([id, p]) => [p.address.toLowerCase(), id]));
    const balances: Holding[] = [];
    const statuses: HolderStatus[] = [];
    const supplies: Record<string, bigint> = {};
    await Promise.all(
      this.tokens.map(async ([key, token]) => {
        supplies[key] = (await read(token.address, WholesaleToken.abi, "totalSupply")) as bigint;
        await Promise.all(
          holders.map(async (holder) => {
            const [amount, frozen, admitted] = await Promise.all([
              read(token.address, WholesaleToken.abi, "balanceOf", [holder]) as Promise<bigint>,
              read(token.address, WholesaleToken.abi, "getFrozenTokens", [holder]) as Promise<bigint>,
              this.admitted(token, holder, banks.get(holder) ?? false, participantAt.get(holder), read),
            ]);
            balances.push({ token: key, holder, amount });
            statuses.push({ token: key, holder, admitted, frozen });
          }),
        );
      }),
    );
    return { balances, supplies, holders: statuses };
  }

  /**
   * Whether the token's issuer admits `holder`, from the issuer's own
   * records rather than the token's transfer checks: a deposit token's
   * allowlist, a wholesale token's reserve accounts for active banks, a
   * bond's identity registry.
   */
  private async admitted(
    token: { address: Address; kind: string },
    holder: Address,
    activeBank: boolean,
    participant: string | undefined,
    read: (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => Promise<unknown>,
  ): Promise<boolean> {
    if (token.kind === "deposit") return Number(await read(token.address, DepositToken.abi, "getRestriction", [holder])) === ALLOWED;
    // A bond's holder is admitted by its identity registry (ERC-3643): bound to an identity carrying valid claims.
    if (token.kind === "bond") {
      const identityRegistry = (await read(token.address, Bond.abi, "identityRegistry")) as Address;
      return (await read(identityRegistry, IdentityRegistry.abi, "isVerified", [holder])) as boolean;
    }
    if (!activeBank || !participant) return false;
    return (await read(token.address, WholesaleToken.abi, "hasReserveAccount", [participantIdHash(participant)])) as boolean;
  }
}

/** The settlement engine's instruction id from a transaction's logs, if it settled one. */
export function engineId(logs: readonly Log[], engine: Address): Hex | undefined {
  const events = parseEventLogs({ abi: contracts.SettlementEngine.abi, logs: logs as Log[], eventName: "InstructionSettled", strict: false });
  const event = events.find((e) => e.address.toLowerCase() === engine.toLowerCase());
  return (event?.args as { id?: Hex } | undefined)?.id;
}

/** An instruction id as the kit names it: the UETR, where the id is one. */
export function kitId(id: Hex): string {
  try {
    return idToUetr(id);
  } catch {
    return id;
  }
}

