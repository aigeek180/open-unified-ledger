import { contracts, uetrToId } from "@oul/chain";
import { appendAudit } from "./audit.ts";
import type { RuntimeContext } from "./context.ts";
import { setProposalStatus } from "./policy.ts";
import { instructionsWithStatus, updateInstruction } from "./store.ts";

/**
 * Void what can never settle. Once a block's timestamp is past an
 * instruction's deadline and the engine has not settled it, the engine will
 * refuse it forever, so its pending entry is voided and the instruction marked
 * expired. This is also how an approver or a party learns that an instruction
 * it booked was abandoned: from durable state, not from a message.
 */
export async function sweepTick(rt: RuntimeContext): Promise<void> {
  const open = await instructionsWithStatus(rt.books.database, ["proposed", "ready", "submitted", "awaiting"]);
  if (open.length === 0) return;
  const block = await rt.client.getBlock();
  const now = Number(block.timestamp);
  for (const row of open) {
    if (row.deadline.getTime() / 1000 >= now) continue;
    const settledAt = (await rt.client.readContract({
      address: rt.deployment.contracts.engine,
      abi: contracts.SettlementEngine.abi,
      functionName: "settledAt",
      args: [uetrToId(row.uetr)],
      blockNumber: block.number,
    })) as bigint;
    if (settledAt !== 0n) continue; // settled: the listener books it
    await rt.lock.run(() =>
      rt.books.transaction(async (tx) => {
        const entry = await tx.entryByKey(row.entryKey);
        if (entry?.status === "pending") await tx.void(entry.id, { at: new Date() });
        await updateInstruction(tx.db, row.uetr, { status: "expired", lastError: row.status === "proposed" ? "deadline passed waiting for approval" : "deadline passed unsettled" });
        if (row.status === "proposed") await setProposalStatus(tx.db, row.uetr, "expired");
        await appendAudit(tx.db, { actor: "runtime", action: "expired", subject: row.uetr, detail: { was: row.status } });
      }),
    );
    rt.log(`expired ${row.flow.kind} ${row.uetr}`);
  }
}
