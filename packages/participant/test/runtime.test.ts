import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { contracts, type Deployment, deployScenario, devKeys, type Network, sandboxChain, ZERO_FEES } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "@oul/chain/testing";
import { bankAccounts, centralBankAccounts, credit, debit, money } from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createTestClient, createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, FlowRejected, Participant, type Peers } from "../src/index.ts";

/**
 * The participant runtime end to end on a local chain: Anvil, the real
 * contracts, and the central bank, Bank A and Bank B each running their own
 * books in their own schema, reaching each other through in-process peers.
 * The loops are driven by explicit ticks so every step is deterministic.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const CHAIN_ID = TEST_CHAIN_ID;
const run = anvilPath() ? describe : describe.skip;

run("participant runtime on a local chain", () => {
  let anvil: Anvil;
  let rpcUrl: string;
  let scenario: Scenario;
  let network: Network;
  let deployment: Deployment;
  const participants = new Map<string, Participant>();
  const schemas: string[] = [];
  const of = (id: string) => participants.get(id)!;

  const peers: Peers = {
    approve: (participant, flow) => of(participant).approve(flow),
    requestFunding: async (cb, flow) => {
      await of(cb).receiveFunding(flow);
    },
    quote: (dealer, request) => of(dealer).quote(request),
    requestChange: async (participant, request) => {
      await of(participant).receiveChange(request);
    },
    custodyWallet: (bank) => of(bank).custodyWallet(),
  };

  async function open(id: string, schema?: string) {
    const name = schema ?? `rt_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
    if (!schema) schemas.push(name);
    const participant = await Participant.open({
      scenario,
      deployment,
      network,
      participant: id,
      databaseUrl: DATABASE_URL,
      schema: name,
      peers,
      ...(process.env["OUL_LOG"] ? { log: console.log } : {}),
    });
    participants.set(id, participant);
    return { participant, schema: name };
  }

  /**
   * Tick every participant until `done` holds, then once more, so a listener
   * that ticked just before the deciding block was mined catches up to it.
   */
  async function until(done: () => Promise<boolean>, rounds = 20) {
    for (let i = 0; i < rounds; i++) {
      for (const p of participants.values()) await p.tick();
      if (await done()) {
        for (const p of participants.values()) await p.tick();
        return;
      }
    }
    const state = [];
    for (const [id, p] of participants) {
      const db = p.rt.books.database;
      const cursor = (await db.execute(sql`SELECT last_block::text AS b FROM chain_cursor`)).rows[0]?.["b"];
      const open = (await db.execute(sql`SELECT uetr, role, status, last_error FROM instructions WHERE status <> 'settled'`)).rows;
      const rec = await p.reconciliation();
      state.push({ id, cursor, open, breaks: await p.breaks(5), reconciled: rec && { block: String(rec.block), ok: rec.ok, failing: rec.checks.filter((c) => !c.ok) } });
    }
    const latest = await testClient().getBlockNumber();
    throw new Error(`Condition not reached at block ${latest}: ${JSON.stringify(state, null, 1)}`);
  }

  const status = async (id: string, uetr: string) => (await of(id).instruction(uetr))?.status;
  const posted = async (id: string, account: string) => (await of(id).rt.books.balance(account)).posted.minor;
  const testClient = () => createTestClient({ mode: "anvil", chain: sandboxChain(CHAIN_ID, rpcUrl), transport: http() }).extend(publicActions);

  beforeAll(async () => {
    anvil = startAnvil();
    rpcUrl = anvil.rpcUrl;
    scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank"));
    network = localNetwork(scenario, rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-b"]) await open(id);
  }, 60_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("funds banks with wholesale tokens through the central bank (5.1)", async () => {
    const a = await act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "CAD", amount: "100000000" }, of);
    const b = await act(of("bank-b"), { kind: "fund", bank: "bank-b", currency: "CAD", amount: "100000000" }, of);
    expect(a.role).toBe("party");
    expect((await of("central-bank").instruction(a.uetr))?.role).toBe("submitter");

    await until(
      async () =>
        (await status("bank-a", a.uetr)) === "settled" &&
        (await status("bank-b", b.uetr)) === "settled" &&
        (await status("central-bank", a.uetr)) === "settled" &&
        (await status("central-bank", b.uetr)) === "settled",
    );
    expect(await posted("bank-a", bankAccounts.wholesaleReserves("CAD"))).toBe(100000000n);
    expect(await posted("bank-a", bankAccounts.rtgsReserves("CAD"))).toBe(50000000000n - 100000000n);
    expect(await posted("central-bank", centralBankAccounts.wholesaleLine("bank-a"))).toBe(100000000n);
    expect(await posted("central-bank", centralBankAccounts.settlementAccount("bank-a"))).toBe(50000000000n - 100000000n);
  });

  it("tokenizes a customer deposit (5.2)", async () => {
    const row = await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "northwind-freight", amount: "500000" }, of);
    await until(async () => (await status("bank-a", row.uetr)) === "settled");
    expect(await posted("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).toBe(500000n);
    expect(await posted("bank-a", bankAccounts.customerDeposit("northwind-freight"))).toBe(2500000000n - 500000n);
  });

  it("settles an interbank payment co-signed by the payee bank, and the central bank books it from the chain (5.3)", async () => {
    const row = await act(of("bank-a"), {
      kind: "interbank",
      payerBank: "bank-a",
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "lakeside-steel",
      amount: "250000",
    }, of);
    expect(row.approvals).toHaveLength(1);
    expect((await of("bank-b").instruction(row.uetr))?.role).toBe("approver");

    await until(async () => (await status("bank-a", row.uetr)) === "settled" && (await status("bank-b", row.uetr)) === "settled");
    expect(await posted("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).toBe(250000n);
    expect(await posted("bank-a", bankAccounts.wholesaleReserves("CAD"))).toBe(100000000n - 250000n);
    expect(await posted("bank-b", bankAccounts.tokenizedDeposit("lakeside-steel"))).toBe(250000n);
    expect(await posted("bank-b", bankAccounts.wholesaleReserves("CAD"))).toBe(100000000n + 250000n);
    // The central bank took no part, yet its books follow the wholesale movement.
    expect(await posted("central-bank", centralBankAccounts.wholesaleLine("bank-a"))).toBe(100000000n - 250000n);
    expect(await posted("central-bank", centralBankAccounts.wholesaleLine("bank-b"))).toBe(100000000n + 250000n);

    for (const id of participants.keys()) {
      const reconciliation = await of(id).reconciliation();
      expect(reconciliation?.ok, `${id} reconciles`).toBe(true);
      expect((await of(id).rt.books.trialBalance()).totals.get("CAD")).toBe(0n);
    }
  });

  it("returns the same instruction for a retried UETR, and refuses a reused one", async () => {
    const uetr = randomUUID();
    const first = await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "harbour-foods", amount: "100", uetr }, of);
    const again = await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "harbour-foods", amount: "100", uetr }, of);
    expect(again.uetr).toBe(first.uetr);
    await expect(
      act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "harbour-foods", amount: "999", uetr }, of),
    ).rejects.toMatchObject({ reason: "conflicting-instruction" });
    await until(async () => (await status("bank-a", uetr)) === "settled");
    expect(await posted("bank-a", bankAccounts.tokenizedDeposit("harbour-foods"))).toBe(100n);
  });

  it("refuses to spend more than is available, before asking the payee bank", async () => {
    const attempt = act(of("bank-a"), {
      kind: "interbank",
      payerBank: "bank-a",
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "prairie-grain",
      amount: "250001",
    }, of);
    await expect(attempt).rejects.toBeInstanceOf(FlowRejected);
    await expect(attempt).rejects.toMatchObject({ reason: "insufficient-funds" });
  });

  it("voids the books when the engine refuses, and the payee's side expires", async () => {
    // Bank A freezes its customer's tokens on chain, behind its own books' back.
    const bankA = createWalletClient({
      account: privateKeyToAccount(devKeys.participant("bank-a")),
      chain: sandboxChain(CHAIN_ID, rpcUrl),
      transport: http(),
    }).extend(publicActions);
    const dcadA = deployment.tokens["dCAD-A"]!.address;
    const northwind = deployment.customers["bank-a/northwind-freight"]!.address;
    await bankA.waitForTransactionReceipt({
      hash: await bankA.writeContract({ address: dcadA, abi: contracts.DepositToken.abi, functionName: "setFrozenTokens", args: [northwind, 250000n], ...ZERO_FEES }),
    });

    const row = await act(of("bank-a"), {
      kind: "interbank",
      payerBank: "bank-a",
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "prairie-grain",
      amount: "1000",
    }, of);
    await until(async () => (await status("bank-a", row.uetr)) === "failed");
    expect((await of("bank-a").instruction(row.uetr))?.entryStatus).toBe("voided");
    expect(await status("bank-b", row.uetr)).toBe("awaiting");

    // Past the deadline the engine can never settle it, so the payee bank lets go.
    await testClient().increaseTime({ seconds: 3600 });
    await testClient().mine({ blocks: 1 });
    await until(async () => (await status("bank-b", row.uetr)) === "expired");
    expect((await of("bank-b").instruction(row.uetr))?.entryStatus).toBe("voided");
    expect(await posted("bank-b", bankAccounts.tokenizedDeposit("prairie-grain"))).toBe(0n);

    await bankA.waitForTransactionReceipt({
      hash: await bankA.writeContract({ address: dcadA, abi: contracts.DepositToken.abi, functionName: "setFrozenTokens", args: [northwind, 0n], ...ZERO_FEES }),
    });
  });

  it("resumes from its cursor after a restart without booking anything twice", async () => {
    const before = await of("bank-b").rt.books.trialBalance();
    const schema = of("bank-b").rt.books.schema;
    await of("bank-b").close();
    participants.delete("bank-b");

    const row = await act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "CAD", amount: "1000" }, of);
    await until(async () => (await status("bank-a", row.uetr)) === "settled");

    await open("bank-b", schema);
    await until(async () => (await of("bank-b").reconciliation())?.ok === true);
    const after = await of("bank-b").rt.books.trialBalance();
    expect(after.accounts).toEqual(before.accounts);
  });

  it("shows a corrupted journal entry and an unexplained on-chain movement as breaks", async () => {
    const books = of("bank-a").rt.books;
    const block = await testClient().getBlockNumber();
    const cad = (minor: bigint) => money("CAD", minor);
    // A balanced entry that claims a token movement the chain never made.
    await books.post({
      idempotencyKey: "corruption",
      description: "Deliberately wrong entry",
      status: "posted",
      at: new Date(),
      ledgerBlock: block,
      lines: [debit(bankAccounts.tokenizedDeposit("northwind-freight"), cad(100n)), credit(bankAccounts.customerDeposit("northwind-freight"), cad(100n))],
    });
    await testClient().mine({ blocks: 1 });
    await until(async () => (await of("bank-a").reconciliation())?.ok === false);
    const failing = (await of("bank-a").reconciliation())!.checks.filter((c) => !c.ok).map((c) => c.account);
    expect(failing).toContain(bankAccounts.tokenizedDeposit("northwind-freight"));

    // Bank A forces a transfer on chain with no instruction: its listener cannot explain it.
    const bankA = createWalletClient({
      account: privateKeyToAccount(devKeys.participant("bank-a")),
      chain: sandboxChain(CHAIN_ID, rpcUrl),
      transport: http(),
    }).extend(publicActions);
    await bankA.waitForTransactionReceipt({
      hash: await bankA.writeContract({
        address: deployment.tokens["dCAD-A"]!.address,
        abi: contracts.DepositToken.abi,
        functionName: "forcedTransfer",
        args: [deployment.customers["bank-a/northwind-freight"]!.address, deployment.customers["bank-a/harbour-foods"]!.address, 1000n],
        ...ZERO_FEES,
      }),
    });
    await until(async () => (await of("bank-a").breaks()).some((b) => b["kind"] === "unexplained"));
  });
});
