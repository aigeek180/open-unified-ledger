import path from "node:path";
import {
  bankAccounts,
  centralBankAccounts,
  detokenizeDeposit,
  fundWholesale,
  interbankTransfer,
  type Line,
  money,
  tokenizeDeposit,
} from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Ledger } from "../src/index.ts";
import { testLedger } from "./helpers.ts";

/**
 * The ca-interbank scenario's books, driven by random flows from SPEC.md §5.1
 * to §5.3, one flow per shared-ledger block. Checks, after every block:
 *
 *   Invariant 1: every participant's books balance.
 *   Invariant 4: tokenizing and detokenizing never change a bank's total
 *     deposits; only interbank transfers move deposits between banks.
 *   Invariant 2, off-chain half: the central bank's wholesale line for each
 *     bank equals that bank's wholesale reserves. (The chain half arrives
 *     with the contracts.)
 */

const scenarioDir = path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank");
const BANKS = ["bank-a", "bank-b"] as const;
type BankId = (typeof BANKS)[number];

type Flow =
  | { kind: "tokenize" | "detokenize"; bank: number; customer: number; fraction: number }
  | { kind: "transfer"; from: number; payer: number; payee: number; fraction: number };

const fraction = fc.integer({ min: 1, max: 1000 });
const flow: fc.Arbitrary<Flow> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("tokenize" as const, "detokenize" as const),
    bank: fc.nat(),
    customer: fc.nat(),
    fraction,
  }),
  fc.record({ kind: fc.constant("transfer" as const), from: fc.nat(), payer: fc.nat(), payee: fc.nat(), fraction }),
);

/** fraction / 1000 of a balance, at least one minor unit when possible. */
const share = (balance: bigint, f: number) => (balance * BigInt(f)) / 1000n;

async function openBooks(scenario: Scenario) {
  const books = new Map<string, Awaited<ReturnType<typeof testLedger>>>();
  for (const participant of ["central-bank", ...BANKS]) {
    const spec = scenario.ledgers.find((l) => l.participant === participant)!;
    const handle = await testLedger("flows");
    await handle.ledger.openAccounts(spec.chart);
    await handle.ledger.post({
      idempotencyKey: "opening",
      description: "Opening balances",
      status: "posted",
      at: new Date(Date.UTC(2026, 10, 2, 13, 0, 0)),
      lines: spec.opening,
    });
    books.set(participant, handle);
  }
  return books;
}

describe("ca-interbank flows across the participants' books", () => {
  it("keeps every participant balanced and deposits conserved, block by block", async () => {
    const scenario = await loadScenario(scenarioDir);
    const customers = new Map<BankId, string[]>(
      BANKS.map((b) => [b, scenario.ledgers.find((l) => l.participant === b)!.customers.map((c) => c.id)]),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(flow, { minLength: 1, maxLength: 20 }), async (flows) => {
        const books = await openBooks(scenario);
        const ledgerOf = (p: string): Ledger => books.get(p)!.ledger;
        try {
          let block = 0n;
          let now = Date.UTC(2026, 10, 2, 14, 0, 0);
          const post = async (participant: string, key: string, lines: Line[]) =>
            ledgerOf(participant).post({
              idempotencyKey: key,
              description: key,
              status: "posted",
              at: new Date(now),
              ledgerBlock: block,
              lines,
            });

          const totalDeposits = async (bank: BankId) =>
            (await ledgerOf(bank).balance(bankAccounts.customerDeposits)).posted.minor +
            (await ledgerOf(bank).balance(bankAccounts.tokenizedDeposits)).posted.minor;
          const expectedDeposits = new Map<BankId, bigint>();
          for (const bank of BANKS) expectedDeposits.set(bank, await totalDeposits(bank));

          // §5.1: each bank tokenizes a fifth of its reserves in block 1.
          block += 1n;
          now += 1000;
          for (const bank of BANKS) {
            const reserves = (await ledgerOf(bank).balance(bankAccounts.rtgsReserves("CAD"))).posted;
            const amount = money("CAD", reserves.minor / 5n);
            await post(bank, `fund-${bank}`, fundWholesale.bank(amount));
            await post("central-bank", `fund-${bank}`, fundWholesale.centralBank(bank, amount));
          }

          for (const [index, f] of flows.entries()) {
            block += 1n;
            now += 1000;
            const key = `flow-${index}`;
            if (f.kind === "transfer") {
              const fromBank = BANKS[f.from % 2]!;
              const toBank = BANKS[(f.from + 1) % 2]!;
              const payer = customers.get(fromBank)![f.payer % customers.get(fromBank)!.length]!;
              const payee = customers.get(toBank)![f.payee % customers.get(toBank)!.length]!;
              const tokens = (await ledgerOf(fromBank).balance(bankAccounts.tokenizedDeposit(payer))).posted.minor;
              const wholesale = (await ledgerOf(fromBank).balance(bankAccounts.wholesaleReserves("CAD"))).posted.minor;
              const minor = share(tokens < wholesale ? tokens : wholesale, f.fraction);
              if (minor <= 0n) continue;
              const amount = money("CAD", minor);
              // The three legs commit in one block; each participant posts its side.
              await post(fromBank, key, interbankTransfer.payerBank(payer, amount));
              await post(toBank, key, interbankTransfer.payeeBank(payee, amount));
              await post("central-bank", key, interbankTransfer.centralBank(fromBank, toBank, amount));
              expectedDeposits.set(fromBank, expectedDeposits.get(fromBank)! - minor);
              expectedDeposits.set(toBank, expectedDeposits.get(toBank)! + minor);
            } else {
              const bank = BANKS[f.bank % 2]!;
              const customer = customers.get(bank)![f.customer % customers.get(bank)!.length]!;
              const source =
                f.kind === "tokenize"
                  ? bankAccounts.customerDeposit(customer)
                  : bankAccounts.tokenizedDeposit(customer);
              const minor = share((await ledgerOf(bank).balance(source)).posted.minor, f.fraction);
              if (minor <= 0n) continue;
              const amount = money("CAD", minor);
              await post(
                bank,
                key,
                f.kind === "tokenize" ? tokenizeDeposit(customer, amount) : detokenizeDeposit(customer, amount),
              );
            }

            for (const participant of ["central-bank", ...BANKS]) {
              expect((await ledgerOf(participant).trialBalance()).totals.get("CAD")).toBe(0n);
            }
            for (const bank of BANKS) {
              expect(await totalDeposits(bank)).toBe(expectedDeposits.get(bank));
              expect(await ledgerOf(bank).balanceAtBlock(bankAccounts.wholesaleReserves("CAD"), block)).toEqual(
                await ledgerOf("central-bank").balanceAtBlock(centralBankAccounts.wholesaleLine(bank), block),
              );
            }
          }
        } finally {
          for (const handle of books.values()) await handle.dispose();
        }
      }),
      { numRuns: 15 },
    );
  });
});
