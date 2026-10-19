import {
  type AccountSpec,
  type AccountType,
  credit,
  debit,
  type Line,
  money,
  normalSide,
} from "@oul/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IdempotencyConflictError } from "../src/index.ts";
import { testLedger } from "./helpers.ts";

/**
 * Model-based property test: random sequences of postings, settlements,
 * voids, retries and key reuse run against the real ledger and against a
 * plain in-memory model. Afterwards every balance, pending total and
 * available balance must agree, at every instant the run passed through, and
 * every as-of answer given during the run must still be the same answer.
 */

const chart: AccountSpec[] = [
  { code: "reserves", name: "Reserves", type: "asset", currency: "CAD", control: false, mirrored: false },
  { code: "loans", name: "Loans", type: "asset", currency: "CAD", control: false, mirrored: false },
  { code: "deposits", name: "Deposits", type: "liability", currency: "CAD", control: true, mirrored: false },
  { code: "deposits/a", name: "Deposit A", type: "liability", currency: "CAD", control: false, mirrored: false, parent: "deposits" },
  { code: "deposits/b", name: "Deposit B", type: "liability", currency: "CAD", control: false, mirrored: false, parent: "deposits" },
  { code: "interest", name: "Interest expense", type: "expense", currency: "CAD", control: false, mirrored: false },
  { code: "equity", name: "Equity", type: "equity", currency: "CAD", control: false, mirrored: false },
];
const leaves = chart.filter((a) => !a.control).map((a) => a.code);
const typeOf = new Map(chart.map((a) => [a.code, a.type]));
const childrenOf = (code: string) => [code, ...chart.filter((a) => a.parent === code).map((a) => a.code)];

type Command =
  | { kind: "post"; status: "pending" | "posted"; legs: [number, number, bigint][]; advance: number }
  | { kind: "settle"; pick: number; advance: number }
  | { kind: "void"; pick: number; advance: number }
  | { kind: "retry"; pick: number }
  | { kind: "reuse"; pick: number };

const leaf = fc.nat({ max: leaves.length - 1 });
const advance = fc.nat({ max: 3 });
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("post" as const),
      status: fc.constantFrom("pending" as const, "posted" as const),
      legs: fc.array(fc.tuple(leaf, leaf, fc.bigInt({ min: 1n, max: 10n ** 12n })), { minLength: 1, maxLength: 3 }),
      advance,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("settle" as const), pick: fc.nat(), advance }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("void" as const), pick: fc.nat(), advance }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("retry" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reuse" as const), pick: fc.nat() }) },
);

interface ModelEntry {
  id: bigint;
  key: string;
  input: Parameters<Awaited<ReturnType<typeof testLedger>>["ledger"]["post"]>[0];
  lines: Line[];
  createdAt: number;
  postedAt?: number;
  voidedAt?: number;
}

function modelBalance(entries: ModelEntry[], code: string, asOf: number) {
  const codes = new Set(childrenOf(code));
  let net = 0n;
  let pendingDebits = 0n;
  let pendingCredits = 0n;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!codes.has(line.account)) continue;
      const signed = line.side === "debit" ? line.amount.minor : -line.amount.minor;
      if (entry.postedAt !== undefined && entry.postedAt <= asOf) net += signed;
      const pending =
        entry.createdAt <= asOf &&
        (entry.postedAt === undefined || entry.postedAt > asOf) &&
        (entry.voidedAt === undefined || entry.voidedAt > asOf);
      if (pending && line.side === "debit") pendingDebits += line.amount.minor;
      if (pending && line.side === "credit") pendingCredits += line.amount.minor;
    }
  }
  const type = typeOf.get(code) as AccountType;
  const debitNormal = normalSide(type) === "debit";
  const posted = debitNormal ? net : -net;
  return {
    posted,
    pendingDebits,
    pendingCredits,
    available: posted - (debitNormal ? pendingCredits : pendingDebits),
  };
}

describe("ledger against an in-memory model", () => {
  it("agrees on every balance at every instant, and as-of answers never change", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 25 }), async (commands) => {
        const { ledger, dispose } = await testLedger("model");
        try {
          await ledger.openAccounts(chart);
          const entries: ModelEntry[] = [];
          const instants: number[] = [];
          const answers: { code: string; asOf: number; posted: bigint; available: bigint }[] = [];
          let now = Date.UTC(2026, 10, 2, 14, 0, 0);
          let counter = 0;

          for (const cmd of commands) {
            if (cmd.kind === "post") {
              now += cmd.advance * 1000;
              const lines = cmd.legs.flatMap(([d, c, minor]) => {
                const amount = money("CAD", minor);
                return [debit(leaves[d]!, amount), credit(leaves[c]!, amount)];
              });
              const input = {
                idempotencyKey: `entry-${counter++}`,
                description: `Entry ${counter}`,
                status: cmd.status,
                at: new Date(now),
                lines,
              };
              const result = await ledger.post(input);
              expect(result.replayed).toBe(false);
              entries.push({
                id: result.id,
                key: input.idempotencyKey,
                input,
                lines,
                createdAt: now,
                ...(cmd.status === "posted" ? { postedAt: now } : {}),
              });
            } else if (cmd.kind === "settle" || cmd.kind === "void") {
              const pending = entries.filter((e) => e.postedAt === undefined && e.voidedAt === undefined);
              const target = pending[cmd.pick % Math.max(pending.length, 1)];
              if (!target) continue;
              now += cmd.advance * 1000;
              if (cmd.kind === "settle") {
                await ledger.settle(target.id, { at: new Date(now) });
                target.postedAt = now;
              } else {
                await ledger.void(target.id, { at: new Date(now) });
                target.voidedAt = now;
              }
            } else if (cmd.kind === "retry") {
              const target = entries[cmd.pick % Math.max(entries.length, 1)];
              if (!target) continue;
              const result = await ledger.post(target.input);
              expect(result).toEqual({ id: target.id, replayed: true });
            } else {
              const target = entries[cmd.pick % Math.max(entries.length, 1)];
              if (!target) continue;
              await expect(
                ledger.post({ ...target.input, description: `${target.input.description} (changed)` }),
              ).rejects.toThrow(IdempotencyConflictError);
            }

            // Ask one question as of an instant the clock has passed: that
            // answer is final and must be the same at the end of the run. (An
            // answer for the current instant is provisional by design, since
            // more entries may still be recorded at it.)
            const watermark = (await ledger.watermark()).instant?.getTime();
            const final = instants.filter((t) => watermark !== undefined && t < watermark);
            const asOf = final[counter % Math.max(final.length, 1)];
            if (asOf !== undefined) {
              const code = chart[counter % chart.length]!.code;
              const answer = await ledger.balance(code, { asOf: new Date(asOf) });
              answers.push({ code, asOf, posted: answer.posted.minor, available: answer.available.minor });
            }
            instants.push(now);
          }

          for (const asOf of [...new Set(instants)]) {
            for (const { code } of chart) {
              const actual = await ledger.balance(code, { asOf: new Date(asOf) });
              const expected = modelBalance(entries, code, asOf);
              expect({
                posted: actual.posted.minor,
                pendingDebits: actual.pendingDebits.minor,
                pendingCredits: actual.pendingCredits.minor,
                available: actual.available.minor,
              }).toEqual(expected);
            }
          }

          for (const answer of answers) {
            const again = await ledger.balance(answer.code, { asOf: new Date(answer.asOf) });
            expect({ posted: again.posted.minor, available: again.available.minor }).toEqual({
              posted: answer.posted,
              available: answer.available,
            });
          }

          // Invariant 1: posted debits equal posted credits across the books.
          const trial = await ledger.trialBalance();
          expect(trial.totals.get("CAD") ?? 0n).toBe(0n);
        } finally {
          await dispose();
        }
      }),
      { numRuns: 40 },
    );
  });
});
