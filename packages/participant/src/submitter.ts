import { contracts, ZERO_FEES } from "@oul/chain";
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hash, type Hex } from "viem";
import { appendAudit } from "./audit.ts";
import { rotationPending } from "./changes.ts";
import type { RuntimeContext } from "./context.ts";
import { legsOf } from "./flows.ts";
import { type InstructionRow, instructionsWithStatus, readCursor, updateInstruction } from "./store.ts";

const { SettlementEngine } = contracts;

/** Every custom error any of the contracts can raise, so a token's revert inside the engine still has a name. */
const ALL_ERRORS = Object.values(contracts).flatMap((c) => c.abi.filter((item) => item.type === "error"));

/** The error name if `error` is a contract revert, else undefined. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  if (revert.data?.errorName) return revert.data.errorName;
  if (revert.raw) {
    try {
      return decodeErrorResult({ abi: ALL_ERRORS, data: revert.raw as Hex }).errorName;
    } catch {
      // Not one of ours.
    }
  }
  return revert.reason ?? "reverted";
}

/**
 * Send ready instructions from the outbox, and catch submitted ones that
 * reverted. A revert the engine explains (a rule refused it) fails the
 * instruction and voids its pending entry; a network error leaves it ready
 * for the next tick. The instruction id makes a resend harmless: a duplicate
 * is refused with AlreadySettled, which counts as submitted.
 */
export async function submitTick(rt: RuntimeContext): Promise<void> {
  for (const row of await instructionsWithStatus(rt.books.database, ["ready"], "submitter")) {
    await submitOne(rt, row);
  }
  for (const row of await instructionsWithStatus(rt.books.database, ["submitted"], "submitter")) {
    if (!row.txHash) continue;
    const receipt = await rt.client.getTransactionReceipt({ hash: row.txHash as Hash }).catch(() => undefined);
    if (receipt?.status === "reverted") await fail(rt, row, "the settlement transaction reverted");
  }
}

async function submitOne(rt: RuntimeContext, row: InstructionRow): Promise<void> {
  if (rt.defects.has("split-legs")) return submitLegByLeg(rt, row);
  const instruction = legsOf(row.flow, rt.flows);
  const args = [{ ...instruction, legs: [...instruction.legs] }, [...row.approvals]] as const;
  const engine = rt.deployment.contracts.engine;
  try {
    await rt.client.simulateContract({
      address: engine,
      abi: SettlementEngine.abi,
      functionName: "settle",
      args,
      account: rt.account,
    });
  } catch (error) {
    const name = revertName(error);
    if (name === "AlreadySettled") {
      await updateInstruction(rt.books.database, row.uetr, { status: "submitted", lastError: null });
      return;
    }
    // Moving to a new key: the registry may have retired the old one a moment before the runtime switched.
    // The next tick sends it with the new key, so this is not the engine's refusal of the instruction.
    if (name === "NotASubmitter" && (await rotationPending(rt))) {
      await updateInstruction(rt.books.database, row.uetr, { attempt: true, lastError: `${name} while moving to a new key; retried` });
      return;
    }
    if (name) {
      await fail(rt, row, `refused by the engine: ${name}`);
      return;
    }
    await updateInstruction(rt.books.database, row.uetr, { attempt: true, lastError: String(error) });
    return;
  }
  try {
    const hash = await rt.wallet.writeContract({
      address: engine,
      abi: SettlementEngine.abi,
      functionName: "settle",
      args,
      account: rt.account,
      chain: rt.wallet.chain,
      ...ZERO_FEES,
    });
    await rt.books.database.transaction(async (tx) => {
      await updateInstruction(tx, row.uetr, { status: "submitted", txHash: hash, attempt: true, lastError: null });
      await appendAudit(tx, { actor: "runtime", action: "submitted", subject: row.uetr, detail: { txHash: hash, signer: rt.account.address } });
    });
    rt.log(`submitted ${row.flow.kind} ${row.uetr} in ${hash}`);
  } catch (error) {
    await updateInstruction(rt.books.database, row.uetr, { attempt: true, lastError: String(error) });
  }
}

async function fail(rt: RuntimeContext, row: InstructionRow, reason: string): Promise<void> {
  // The conformance kit's `book-refused` defect posts the entry as if it had settled, at the last block the
  // listener processed, so no later posting goes back before it.
  const bookAnyway = rt.defects.has("book-refused") ? ((await readCursor(rt.books.database)) ?? BigInt(rt.deployment.startBlock)) : undefined;
  await rt.lock.run(() =>
    rt.books.transaction(async (tx) => {
      const entry = await tx.entryByKey(row.entryKey);
      if (entry?.status === "pending") {
        if (bookAnyway === undefined) await tx.void(entry.id, { at: new Date() });
        else await tx.settle(entry.id, { at: new Date(), ledgerBlock: bookAnyway });
      }
      await updateInstruction(tx.db, row.uetr, { status: "failed", lastError: reason });
      await appendAudit(tx.db, { actor: "runtime", action: "refused", subject: row.uetr, detail: { reason } });
    }),
  );
  rt.log(`failed ${row.flow.kind} ${row.uetr}: ${reason}`);
}

/**
 * The conformance kit's `split-legs` defect: each leg sent alone through the
 * broken SplitLegsEngine's `settleLeg`, one transaction after another, so
 * legs already settled stay settled if a later one is refused.
 */
async function submitLegByLeg(rt: RuntimeContext, row: InstructionRow): Promise<void> {
  const instruction = legsOf(row.flow, rt.flows);
  const engine = rt.deployment.contracts.engine;
  let hash: Hash | undefined;
  for (const index of instruction.legs.keys()) {
    const args = [{ ...instruction, legs: [...instruction.legs] }, [...row.approvals], BigInt(index)] as const;
    try {
      await rt.client.simulateContract({ address: engine, abi: contracts.SplitLegsEngine.abi, functionName: "settleLeg", args, account: rt.account });
    } catch (error) {
      const name = revertName(error);
      if (name === "AlreadySettled") continue;
      if (name) return fail(rt, row, `refused by the engine: ${name}`);
      await updateInstruction(rt.books.database, row.uetr, { attempt: true, lastError: String(error) });
      return;
    }
    hash = await rt.wallet.writeContract({ address: engine, abi: contracts.SplitLegsEngine.abi, functionName: "settleLeg", args, account: rt.account, chain: rt.wallet.chain, ...ZERO_FEES });
    await rt.client.waitForTransactionReceipt({ hash });
  }
  await rt.books.database.transaction(async (tx) => {
    await updateInstruction(tx, row.uetr, { status: "submitted", attempt: true, lastError: null, ...(hash ? { txHash: hash } : {}) });
    await appendAudit(tx, { actor: "runtime", action: "submitted", subject: row.uetr, detail: { txHash: hash ?? null, signer: rt.account.address, legByLeg: true } });
  });
}
