import { type AccountSpec, credit, debit, money } from "@oul/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  type Ledger,
  LedgerRuleError,
  UnknownAccountError,
} from "../src/index.ts";
import { clock, testLedger } from "./helpers.ts";

const cad = (minor: bigint) => money("CAD", minor);

const chart: AccountSpec[] = [
  { code: "cash", name: "Cash", type: "asset", currency: "CAD", control: false, mirrored: false },
  { code: "tokens", name: "Tokens", type: "asset", currency: "CAD", control: false, mirrored: true },
  { code: "deposits", name: "Deposits", type: "liability", currency: "CAD", control: true, mirrored: false },
  { code: "deposits/a", name: "Deposit A", type: "liability", currency: "CAD", control: false, mirrored: false, parent: "deposits" },
  { code: "equity", name: "Equity", type: "equity", currency: "CAD", control: false, mirrored: false },
  { code: "usd-cash", name: "USD cash", type: "asset", currency: "USD", control: false, mirrored: false },
];

describe("ledger rules enforced by the database", () => {
  let ledger: Ledger;
  let raw: Awaited<ReturnType<typeof testLedger>>["raw"];
  let dispose: () => Promise<void>;
  const time = clock();

  beforeEach(async () => {
    ({ ledger, raw, dispose } = await testLedger("rules"));
    await ledger.openAccounts(chart);
  });
  afterEach(async () => dispose());

  async function postCashDeposit(key: string, minor = 100n) {
    return ledger.post({
      idempotencyKey: key,
      description: "Deposit",
      status: "posted",
      at: time.tick(),
      lines: [debit("cash", cad(minor)), credit("deposits/a", cad(minor))],
    });
  }

  async function accountId(code: string): Promise<string> {
    const { rows } = await raw.query<{ id: string }>("SELECT id FROM accounts WHERE code = $1", [code]);
    return rows[0]!.id;
  }

  /** Insert an entry and lines with raw SQL, as a buggy writer might. */
  async function rawEntry(lines: { account: string; side: string; amount: number; currency?: string }[]) {
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries (idempotency_key, payload_hash, description, status, created_at, posted_at)
         VALUES (gen_random_uuid()::text, 'x', 'raw', 'posted', $1, $1) RETURNING id`,
        [time.tick()],
      );
      for (const line of lines) {
        await client.query(
          "INSERT INTO journal_lines (entry_id, account_id, currency, side, amount) VALUES ($1, $2, $3, $4, $5)",
          [rows[0]!.id, await accountId(line.account), line.currency ?? "CAD", line.side, line.amount],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  it("rejects an unbalanced entry at commit, even written with raw SQL", async () => {
    await expect(
      rawEntry([
        { account: "cash", side: "debit", amount: 100 },
        { account: "deposits/a", side: "credit", amount: 99 },
      ]),
    ).rejects.toThrow(/unbalanced/);
    await expect(rawEntry([{ account: "cash", side: "debit", amount: 100 }])).rejects.toThrow(
      /at least two/,
    );
  });

  it("rejects lines on a control account or in another currency", async () => {
    await expect(
      rawEntry([
        { account: "cash", side: "debit", amount: 100 },
        { account: "deposits", side: "credit", amount: 100 },
      ]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      rawEntry([
        { account: "usd-cash", side: "debit", amount: 100, currency: "CAD" },
        { account: "deposits/a", side: "credit", amount: 100 },
      ]),
    ).rejects.toThrow(/foreign key/);
  });

  it("never changes or deletes lines and entries", async () => {
    await postCashDeposit("k1");
    await expect(raw.query("UPDATE journal_lines SET amount = amount + 1")).rejects.toThrow(/never changed/);
    await expect(raw.query("DELETE FROM journal_lines")).rejects.toThrow(/never changed/);
    await expect(raw.query("DELETE FROM journal_entries")).rejects.toThrow(/never deleted/);
    await expect(raw.query("TRUNCATE journal_lines")).rejects.toThrow(/append-only/);
    await expect(raw.query("UPDATE journal_entries SET description = 'edited'")).rejects.toThrow(
      /posted and can no longer change/,
    );
    await expect(raw.query("DELETE FROM accounts WHERE code = 'cash'")).rejects.toThrow(/never deleted/);
  });

  it("refuses lines added to an entry after its transaction", async () => {
    const { id } = await postCashDeposit("k1");
    await expect(
      raw.query(
        "INSERT INTO journal_lines (entry_id, account_id, currency, side, amount) VALUES ($1, $2, 'CAD', 'debit', 5)",
        [id.toString(), await accountId("cash")],
      ),
    ).rejects.toThrow(/transaction that creates their entry/);
  });

  it("moves an entry pending to posted or voided, once", async () => {
    const { id } = await ledger.post({
      idempotencyKey: "hold",
      description: "Hold",
      status: "pending",
      at: time.tick(),
      lines: [debit("deposits/a", cad(40n)), credit("cash", cad(40n))],
    });
    await ledger.void(id, { at: time.tick() });
    await ledger.void(id, { at: time.tick() }); // replay is a no-op
    await expect(ledger.settle(id, { at: time.tick() })).rejects.toThrow(LedgerRuleError);
    expect((await ledger.entry(id)).status).toBe("voided");
  });

  it("refuses an instant earlier than one already recorded", async () => {
    await postCashDeposit("k1");
    await expect(
      ledger.post({
        idempotencyKey: "backdated",
        description: "Backdated",
        status: "posted",
        at: new Date(Date.UTC(2020, 0, 1)),
        lines: [debit("cash", cad(1n)), credit("deposits/a", cad(1n))],
      }),
    ).rejects.toThrow(/earlier than the last recorded instant/);
  });

  it("requires a block on a posted entry touching a mirrored account, in order", async () => {
    const tokenize = (key: string, block?: bigint) =>
      ledger.post({
        idempotencyKey: key,
        description: "Tokenize",
        status: "posted",
        at: time.tick(),
        lines: [debit("tokens", cad(10n)), credit("cash", cad(10n))],
        ...(block === undefined ? {} : { ledgerBlock: block }),
      });
    await expect(tokenize("no-block")).rejects.toThrow(/must carry the block/);
    await tokenize("block-7", 7n);
    await expect(tokenize("block-6", 6n)).rejects.toThrow(/earlier than the last recorded block/);
    expect((await ledger.balanceAtBlock("tokens", 6n)).minor).toBe(0n);
    expect((await ledger.balanceAtBlock("tokens", 7n)).minor).toBe(10n);
  });

  it("gives every balance after a block, entries without a block in their place in time", async () => {
    const tokenize = (key: string, block: bigint) =>
      ledger.post({
        idempotencyKey: key,
        description: "Tokenize",
        status: "posted",
        at: time.tick(),
        lines: [debit("tokens", cad(10n)), credit("cash", cad(10n))],
        ledgerBlock: block,
      });
    await postCashDeposit("before");
    await tokenize("block-3", 3n);
    await postCashDeposit("between");
    await tokenize("block-5", 5n);
    const pending = await ledger.post({
      idempotencyKey: "pending",
      description: "Pending",
      status: "pending",
      at: time.tick(),
      lines: [debit("tokens", cad(7n)), credit("cash", cad(7n))],
    });
    const at = async (block: bigint) => {
      const trial = await ledger.trialBalanceAtBlock(block);
      expect(trial.totals.get("CAD")).toBe(0n);
      const of = (code: string) => trial.accounts.find((a) => a.code === code)!.posted.minor;
      return { tokens: of("tokens"), deposits: of("deposits/a") };
    };
    // "between" was posted after block 3's entry and before block 5's: it counts from block 3 on.
    expect(await at(2n)).toEqual({ tokens: 0n, deposits: 100n });
    expect(await at(3n)).toEqual({ tokens: 10n, deposits: 200n });
    expect(await at(4n)).toEqual({ tokens: 10n, deposits: 200n });
    expect(await at(9n)).toEqual({ tokens: 20n, deposits: 200n });
    await ledger.settle(pending.id, { at: time.tick(), ledgerBlock: 6n });
    expect(await at(5n)).toEqual({ tokens: 20n, deposits: 200n });
    expect(await at(6n)).toEqual({ tokens: 27n, deposits: 200n });
  });

  it("returns the first result for a retried key, and refuses a reused one", async () => {
    const first = await postCashDeposit("same");
    const input = {
      idempotencyKey: "concurrent",
      description: "Concurrent",
      status: "posted" as const,
      at: time.tick(),
      lines: [debit("cash", cad(5n)), credit("deposits/a", cad(5n))],
    };
    const results = await Promise.all([ledger.post(input), ledger.post(input), ledger.post(input)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    await expect(
      ledger.post({ ...input, idempotencyKey: "same" }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect((await ledger.balance("deposits/a")).posted.minor).toBe(105n);
    expect(first.replayed).toBe(false);
  });

  it("refuses unknown accounts and conflicting account definitions", async () => {
    await expect(
      ledger.post({
        idempotencyKey: "unknown",
        description: "Unknown",
        status: "posted",
        at: time.tick(),
        lines: [debit("nowhere", cad(1n)), credit("cash", cad(1n))],
      }),
    ).rejects.toThrow(UnknownAccountError);
    await ledger.openAccounts(chart); // the same chart again is a no-op
    await expect(
      ledger.openAccounts([{ ...chart[0]!, type: "expense" }]),
    ).rejects.toThrow(/different definition/);
  });
});
