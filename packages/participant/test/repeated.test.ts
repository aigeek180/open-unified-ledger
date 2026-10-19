import { randomBytes } from "node:crypto";
import path from "node:path";
import { contracts, type Deployment, deployScenario, devKeys, type Network, sandboxChain, ZERO_FEES } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil } from "@oul/chain/testing";
import { bankAccounts, centralBankAccounts } from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import { sql } from "drizzle-orm";
import pg from "pg";
import { type Abi, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, legsOf, Participant, type Peers } from "../src/index.ts";

/**
 * What the runtime does when the engine settles an instruction it already
 * settled, as the conformance kit's broken NoOnceEngine does (SPEC.md §14):
 * every participant that sees it records a break and books nothing twice,
 * and its listener moves on. The real engine refuses the second settlement
 * (AlreadySettled), so this can only be shown on a broken one.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;

run("an instruction settled twice by a broken engine", () => {
  let anvil: Anvil;
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
  const tickAll = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) for (const p of participants.values()) await p.tick();
  };
  const cursor = async (id: string) =>
    BigInt(String((await of(id).rt.books.database.execute(sql`SELECT last_block::text AS b FROM chain_cursor`)).rows[0]!["b"]));
  const posted = async (id: string, account: string) => (await of(id).rt.books.balance(account)).posted.minor;

  beforeAll(async () => {
    anvil = startAnvil();
    scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank"));
    network = localNetwork(scenario, anvil.rpcUrl);
    const engine = { abi: contracts.NoOnceEngine.abi as Abi, bytecode: contracts.NoOnceEngine.bytecode as Hex };
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n, replace: { engine } }));
    const tag = randomBytes(4).toString("hex");
    for (const id of ["central-bank", "bank-a", "bank-b"]) {
      const schema = `rp_${tag}_${id.replaceAll("-", "_")}`;
      schemas.push(schema);
      participants.set(id, await Participant.open({ scenario, deployment, network, participant: id, databaseUrl: DATABASE_URL, schema, peers }));
    }
  }, 60_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("is a break at every participant that sees it, booked once, and the listeners carry on", async () => {
    await act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "CAD", amount: "1000000" }, of);
    await tickAll();
    await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "northwind-freight", amount: "50000" }, of);
    await tickAll();
    const row = await act(of("bank-a"), {
      kind: "interbank",
      payerBank: "bank-a",
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "lakeside-steel",
      amount: "20000",
    }, of);
    await tickAll();
    expect((await of("bank-a").instruction(row.uetr))?.status).toBe("settled");

    // Bank A sends the settled instruction to the engine again, with the same approvals; this engine takes it.
    const wallet = createWalletClient({
      account: privateKeyToAccount(devKeys.participant("bank-a")),
      chain: sandboxChain(network.chainId, anvil.rpcUrl),
      transport: http(),
    });
    const instruction = legsOf(row.flow, { scenario, deployment });
    const client = createPublicClient({ chain: sandboxChain(network.chainId, anvil.rpcUrl), transport: http() });
    const hash = await wallet.writeContract({
      address: deployment.contracts.engine,
      abi: contracts.NoOnceEngine.abi,
      functionName: "settle",
      args: [{ ...instruction, legs: [...instruction.legs] }, [...row.approvals]],
      ...ZERO_FEES,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    await tickAll();

    for (const id of ["central-bank", "bank-a", "bank-b"]) {
      expect(await cursor(id), `${id}'s listener moved on`).toBeGreaterThanOrEqual(receipt.blockNumber);
      const breaks = await of(id).breaks();
      expect(breaks.some((b) => b["uetr"] === row.uetr && (b["detail"] as { settledAgain?: boolean }).settledAgain), `${id} records the second settlement`).toBe(true);
    }
    // Each booked the payment once; the chain moved it twice.
    expect(await posted("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).toBe(30000n);
    expect(await posted("bank-b", bankAccounts.tokenizedDeposit("lakeside-steel"))).toBe(20000n);
    expect(await posted("central-bank", centralBankAccounts.wholesaleLine("bank-b"))).toBe(20000n);
    expect((await of("bank-a").reconciliation())?.ok).toBe(false);
  }, 120_000);
});
