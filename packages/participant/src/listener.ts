import { idToUetr } from "@oul/chain";
import { centralBankAccounts, credit, debit, type Line, mirrorGroup, money, normalSide } from "@oul/domain";
import type { LedgerTx } from "@oul/ledger";
import { type Address, type Hex, parseEventLogs } from "viem";
import { appendAudit } from "./audit.ts";
import { engineEvents, type RuntimeContext, tokenEvents } from "./context.ts";
import { entryKey, isRepoFlow } from "./flows.ts";
import { applyRepoSettlement } from "./repo.ts";
import { reconcile } from "./reconciler.ts";
import { getInstruction, readCursor, recordBreak, updateInstruction, writeCursor } from "./store.ts";

/** At most this many blocks per tick, so one tick stays one bounded transaction. */
const MAX_RANGE = 500n;

interface Movement {
  readonly txHash: Hex;
  readonly block: bigint;
  /** The engine instruction this transaction settled, if it was one. */
  uetr?: string;
  /** Net change per mirrored account, debits positive. */
  readonly deltas: Map<string, bigint>;
}

/**
 * Follow committed blocks from the cursor (SPEC.md §4.3). QBFT blocks are
 * final when committed, so there is nothing to roll back. For each settled
 * instruction that moved a balance this participant mirrors:
 *   - if we booked it, check the chain moved exactly what the pending entry
 *     says, then post the entry with the block it settled in;
 *   - if we did not, post it when it is fully derivable from the chain (the
 *     central bank observing wholesale moving between banks, or a bank
 *     redeeming), otherwise record an unexplained movement.
 * The cursor advances in the same transaction as the postings, then the
 * books are reconciled against the chain at the last block processed.
 */
export async function listenTick(rt: RuntimeContext): Promise<void> {
  const cursor = (await readCursor(rt.books.database)) ?? BigInt(rt.deployment.startBlock);
  const latest = await rt.client.getBlockNumber();
  if (latest <= cursor) return;
  const from = cursor + 1n;
  const to = latest - cursor > MAX_RANGE ? cursor + MAX_RANGE : latest;

  const logs = await rt.client.getLogs({
    address: [rt.deployment.contracts.engine, ...rt.watchedTokens],
    fromBlock: from,
    toBlock: to,
  });
  const events = parseEventLogs({ abi: [...engineEvents, ...tokenEvents], logs, strict: false });
  const engine = rt.deployment.contracts.engine.toLowerCase();
  const watched = new Set(rt.watchedTokens.map((t) => t.toLowerCase()));

  const movements = new Map<Hex, Movement>();
  const movementOf = (txHash: Hex, block: bigint) => {
    let m = movements.get(txHash);
    if (!m) {
      m = { txHash, block, deltas: new Map() };
      movements.set(txHash, m);
    }
    return m;
  };
  for (const event of events) {
    if (event.transactionHash == null || event.blockNumber == null) continue;
    const address = event.address.toLowerCase();
    if (address === engine && event.eventName === "InstructionSettled") {
      movementOf(event.transactionHash, event.blockNumber).uetr = idToUetr((event.args as { id: Hex }).id);
    } else if (watched.has(address) && event.eventName === "Transfer") {
      const { from: sender, to: receiver, value } = event.args as { from: Address; to: Address; value: bigint };
      const m = movementOf(event.transactionHash, event.blockNumber);
      await applyBalanceChange(rt, m.deltas, event.address, sender, -value);
      await applyBalanceChange(rt, m.deltas, event.address, receiver, value);
    }
  }

  await rt.lock.run(() =>
    rt.books.transaction(async (tx) => {
      for (const movement of movements.values()) {
        await book(rt, tx, movement);
      }
      await writeCursor(tx.db, to);
    }),
  );
  await reconcile(rt, to);
}

/** Add a holder's balance change to the account it mirrors, if it mirrors one. */
async function applyBalanceChange(
  rt: RuntimeContext,
  deltas: Map<string, bigint>,
  token: Address,
  holder: Address,
  change: bigint,
): Promise<void> {
  const mirror = rt.accountFor(token, holder);
  if (!mirror) return;
  const spec = await rt.books.accountSpec(mirror.account);
  // An asset grows with a debit; a liability (what the issuer owes the holder) with a credit.
  const value = change * mirror.factor;
  const signed = normalSide(spec.type) === "debit" ? value : -value;
  deltas.set(mirror.account, (deltas.get(mirror.account) ?? 0n) + signed);
}

function nonZero(deltas: Map<string, bigint>): Map<string, bigint> {
  return new Map([...deltas].filter(([, v]) => v !== 0n));
}

/**
 * The net of an entry's mirrored lines per on-chain balance, debits positive.
 * Accounts that share one on-chain balance net together: repo collateral
 * received and pledged with the bond holding (SPEC.md §5.7).
 */
function mirroredNet(lines: readonly Line[], mirrored: Set<string>): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const line of lines) {
    if (!mirrored.has(line.account)) continue;
    const signed = line.side === "debit" ? line.amount.minor : -line.amount.minor;
    const group = mirrorGroup(line.account);
    net.set(group, (net.get(group) ?? 0n) + signed);
  }
  return nonZero(net);
}

const sameMap = (a: Map<string, bigint>, b: Map<string, bigint>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

async function book(rt: RuntimeContext, tx: LedgerTx, movement: Movement): Promise<void> {
  const deltas = nonZero(movement.deltas);
  const row = movement.uetr ? await getInstruction(tx.db, movement.uetr) : undefined;

  if (row) {
    const entry = await tx.entryByKey(row.entryKey);
    if (entry?.status === "posted" && entry.ledgerBlock === movement.block) return; // already booked: a reprocessed range
    if (entry?.status === "posted") {
      // The engine settles an id once; a second settlement is a break, not a reason to book anything twice.
      await recordBreak(tx.db, {
        block: movement.block,
        kind: "mismatch",
        uetr: movement.uetr,
        txHash: movement.txHash,
        detail: { settledAgain: true, firstBlock: entry.ledgerBlock?.toString() ?? null, actual: Object.fromEntries(deltas) },
      });
      rt.log(`break: instruction ${movement.uetr} settled again in block ${movement.block}`);
      return;
    }
    const mirrored = new Set<string>();
    for (const line of entry?.lines ?? []) {
      if ((await rt.books.accountSpec(line.account)).mirrored) mirrored.add(line.account);
    }
    const expected = mirroredNet(entry?.lines ?? [], mirrored);
    if (!entry || entry.status !== "pending" || !sameMap(expected, deltas)) {
      await recordBreak(tx.db, {
        block: movement.block,
        kind: "mismatch",
        uetr: movement.uetr,
        txHash: movement.txHash,
        detail: {
          entryStatus: entry?.status ?? "missing",
          expected: Object.fromEntries(expected),
          actual: Object.fromEntries(deltas),
        },
      });
      rt.log(`break: instruction ${movement.uetr} does not match what was booked`);
      return;
    }
    await tx.settle(entry.id, { at: new Date(), ledgerBlock: movement.block });
    await updateInstruction(tx.db, row.uetr, { status: "settled", settledBlock: movement.block });
    // A repo's record moves with the settlement that moved its collateral, in the same transaction.
    if (isRepoFlow(row.flow)) await applyRepoSettlement(rt, tx.db, row.flow, movement.block);
    await appendAudit(tx.db, { actor: "runtime", action: "settled", subject: row.uetr, detail: { block: movement.block, txHash: movement.txHash } });
    rt.log(`settled ${row.flow.kind} ${row.uetr} in block ${movement.block}`);
    return;
  }

  if (deltas.size === 0) return;
  if (movement.uetr) {
    const earlier = await tx.entryByKey(entryKey(movement.uetr));
    if (earlier && earlier.ledgerBlock !== movement.block) {
      // Observed once already: the same instruction settled a second time is a break, never booked again.
      await recordBreak(tx.db, {
        block: movement.block,
        kind: "mismatch",
        uetr: movement.uetr,
        txHash: movement.txHash,
        detail: { settledAgain: true, firstBlock: earlier.ledgerBlock?.toString() ?? null, actual: Object.fromEntries(deltas) },
      });
      rt.log(`break: observed instruction ${movement.uetr} settled again in block ${movement.block}`);
      return;
    }
  }
  const derived = derive(rt, deltas);
  if (!derived) {
    await recordBreak(tx.db, {
      block: movement.block,
      kind: "unexplained",
      ...(movement.uetr ? { uetr: movement.uetr } : {}),
      txHash: movement.txHash,
      detail: { actual: Object.fromEntries(deltas) },
    });
    rt.log(`break: unexplained movement in ${movement.txHash}`);
    return;
  }
  await tx.post({
    idempotencyKey: movement.uetr ? entryKey(movement.uetr) : `chain:${movement.txHash}`,
    description: movement.uetr ? `Observed instruction ${movement.uetr}` : `Observed transaction ${movement.txHash}`,
    status: "posted",
    at: new Date(),
    ledgerBlock: movement.block,
    lines: derived,
  });
  rt.log(`posted observed movement in block ${movement.block}`);
}

/**
 * The central bank can book wholesale movements it did not initiate, because
 * the chain says everything about them: wholesale moving between banks is a
 * transfer between their lines, and a bank burning wholesale is a redemption
 * back to its settlement account. A bank books nothing it did not take part in.
 */
function derive(rt: RuntimeContext, deltas: Map<string, bigint>): Line[] | undefined {
  if (rt.kind !== "central-bank") return undefined;
  const currency = rt.currency;
  const net = [...deltas.values()].reduce((a, b) => a + b, 0n);
  const toLines = (entries: [string, bigint][]) =>
    entries.map(([account, signed]) =>
      signed > 0n ? debit(account, money(currency, signed)) : credit(account, money(currency, -signed)),
    );
  if (net === 0n) return toLines([...deltas]);
  const [only] = deltas;
  if (deltas.size === 1 && only && only[1] > 0n && only[0].startsWith(`${centralBankAccounts.wholesaleOutstanding}/`)) {
    const bank = only[0].slice(centralBankAccounts.wholesaleOutstanding.length + 1);
    return [...toLines([only]), credit(centralBankAccounts.settlementAccount(bank), money(currency, only[1]))];
  }
  return undefined;
}
