import type { Approval } from "@oul/chain";
import { formatMoney, type Line, normalSide } from "@oul/domain";
import type { Ledger } from "@oul/ledger";
import { appendAudit, type AuditInput } from "./audit.ts";
import { canonical } from "./canonical.ts";
import type { RuntimeContext } from "./context.ts";
import { FlowRejected } from "./errors.ts";
import { type CustodyAllocation, describeFlow, entryKey, type Flow, linesFor } from "./flows.ts";
import { insertProposal, type Requirement } from "./policy.ts";
import { getInstruction, type InstructionRow, insertInstruction } from "./store.ts";


/** Two flows are the same instruction if everything but the deadline matches. */
export function sameFlow(a: Flow, b: Flow): boolean {
  const { deadline: _a, ...restA } = a;
  const { deadline: _b, ...restB } = b;
  return canonical(restA) === canonical(restB);
}

/**
 * Refuse lines that would spend more than an account has available: every
 * line that moves an asset or liability against its normal side (a credit to
 * reserves or holdings, a debit to a customer's deposit) must be covered by
 * its available balance, which already nets out other pending entries.
 * Income, expense and equity accounts hold no value to spend and may move
 * either way.
 */
export async function assertCovered(books: Ledger, lines: readonly Line[]): Promise<void> {
  for (const line of lines) {
    const spec = await books.accountSpec(line.account);
    if (spec.type !== "asset" && spec.type !== "liability") continue;
    if (line.side === normalSide(spec.type)) continue;
    const { available } = await books.balance(line.account);
    if (available.minor < line.amount.minor) {
      throw new FlowRejected(
        "insufficient-funds",
        `${line.account} has ${formatMoney(available)} available; ${formatMoney(line.amount)} is needed`,
      );
    }
  }
}

/**
 * Book what this participant owes for a flow, before it settles: a pending
 * journal entry and the instruction row, in one transaction. Idempotent by
 * UETR: the same flow again returns the existing row; a different flow under
 * the same UETR is refused.
 */
export interface BookOptions {
  /** `proposed` to wait for the approvals a policy requires; otherwise by role, as before. */
  readonly status?: InstructionRow["status"];
  /** The proposal that holds it until its policy is met. */
  readonly proposal?: { readonly initiator: string; readonly requirement: Requirement };
  /** Audit entries to append in the same transaction (audit.ts), after the booking. */
  readonly audit?: readonly AuditInput[];
  /** A custodian's clients' shares of a coupon or redemption on its omnibus (§15). */
  readonly custody?: CustodyAllocation;
}

export async function bookPending(
  rt: RuntimeContext,
  flow: Flow,
  role: InstructionRow["role"],
  approvals: readonly Approval[] = [],
  options: BookOptions = {},
): Promise<{ row: InstructionRow; created: boolean }> {
  const lines = linesFor(flow, rt.participant, rt.flows, options.custody);
  if (lines.length === 0) {
    throw new FlowRejected("not-a-party", `${rt.participant} books nothing for this ${flow.kind}`);
  }
  return rt.lock.run(async () => {
    const existing = await getInstruction(rt.books.database, flow.uetr);
    if (existing) {
      if (!sameFlow(existing.flow, flow)) {
        throw new FlowRejected("conflicting-instruction", `UETR ${flow.uetr} is already used for a different instruction`);
      }
      return { row: existing, created: false };
    }
    await assertCovered(rt.books, lines);
    const row = {
      uetr: flow.uetr,
      role,
      flow,
      approvals,
      entryKey: entryKey(flow.uetr),
      status: options.status ?? (role === "submitter" ? ("ready" as const) : ("awaiting" as const)),
      deadline: new Date(flow.deadline * 1000),
    };
    await rt.books.transaction(async (tx) => {
      await tx.post({
        idempotencyKey: row.entryKey,
        description: describeFlow(flow),
        status: "pending",
        at: new Date(),
        lines,
      });
      await insertInstruction(tx.db, row);
      if (options.proposal) {
        await insertProposal(tx.db, { subject: flow.uetr, kind: "instruction", ...options.proposal });
      }
      for (const entry of options.audit ?? []) await appendAudit(tx.db, { subject: flow.uetr, ...entry });
    });
    rt.log(`booked ${flow.kind} ${flow.uetr} as ${role}`);
    return { row: (await getInstruction(rt.books.database, flow.uetr))!, created: true };
  });
}
