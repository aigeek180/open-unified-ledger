import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { contracts, custodyAddress, type Deployment, deployScenario, type Network, sandboxChain } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "@oul/chain/testing";
import { bankAccounts, formatMoney, money } from "@oul/domain";
import { loadScenario, type Scenario, withoutPolicies } from "@oul/scenario";
import pg from "pg";
import { createTestClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, affirmAs, type BondFlow, Participant, type Peers, payNextAs } from "../src/index.ts";

/**
 * Client custody (SPEC.md §15) in the runtime, on a local chain with
 * ca-bond-dvp: Bank A buys the bond for its clients at its omnibus wallet,
 * keeps each client's position in its own books, and the positions always
 * sum to the omnibus's units on chain (invariant 13). Coupons and the
 * redemption reach the clients by their positions at the record block,
 * rounded once, the residual shown; a client whose KYC claim Bank A revoked
 * gets no new position; and a lost omnibus wallet is recovered to a new one
 * with its units, nothing booked and nothing broken.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const BOND = "BOND-ISSUER-2031";
const run = anvilPath() ? describe : describe.skip;

run("client custody", () => {
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

  async function until(done: () => Promise<boolean>, rounds = 30) {
    for (let i = 0; i < rounds; i++) {
      for (const p of participants.values()) await p.tick();
      if (await done()) {
        for (const p of participants.values()) await p.tick();
        return;
      }
    }
    throw new Error("Condition not reached");
  }
  const status = async (id: string, uetr: string) => (await of(id).instruction(uetr))?.status;
  const settledAt = (uetr: string, ...ids: string[]) => until(async () => (await Promise.all(ids.map((id) => status(id, uetr)))).every((s) => s === "settled"));
  const posted = async (id: string, account: string) => (await of(id).rt.books.balance(account)).posted.minor;
  const cad = (minor: bigint) => formatMoney(money("CAD", minor));
  const mine = () => createTestClient({ mode: "anvil", chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() }).mine({ blocks: 1 });
  const units = async (wallet: `0x${string}`) =>
    of("bank-a").rt.client.readContract({ address: deployment.tokens[BOND]!.address, abi: contracts.Bond.abi, functionName: "balanceOf", args: [wallet] });
  async function custodyHolds() {
    const checks = (await of("bank-a").reconciliation())!.checks.filter((c) => c.invariant === 13);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c, c.account).toMatchObject({ ok: true });
    expect(await of("bank-a").breaks()).toEqual([]);
    return checks;
  }

  beforeAll(async () => {
    anvil = startAnvil();
    scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-bond-dvp")));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-b", "bank-c"]) {
      const schema = `cust_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
      schemas.push(schema);
      participants.set(id, await Participant.open({ scenario, deployment, network, participant: id, databaseUrl: DATABASE_URL, schema, peers }));
    }
    for (const [bank, amount] of [["bank-a", "7000000000"], ["bank-b", "5000000000"], ["bank-c", "2000000000"]] as const) {
      const row = await act(of(bank), { kind: "fund", bank, currency: "CAD", amount }, of);
      await settledAt(row.uetr, bank, "central-bank");
    }
  }, 120_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("issues to Bank A's own book and to its clients at its omnibus wallet, positions equal to the units on chain", async () => {
    const omnibus = await of("bank-a").custodyWallet();
    expect(omnibus).toBe(custodyAddress("bank-a"));
    const custody = (client: string) => ({ client, wallet: omnibus });
    const issue = {
      kind: "bond-issue",
      uetr: randomUUID(),
      bond: BOND,
      price: "100000",
      allocations: [
        { bank: "bank-a", units: "50000" },
        { bank: "bank-a", units: "3000", custody: custody("alder-pension") },
        { bank: "bank-a", units: "2001", custody: custody("birchline-insurance") },
        { bank: "bank-b", units: "44999" },
      ],
    } as const;
    await affirmAs(of("bank-a"), issue);
    await affirmAs(of("bank-b"), issue);
    const row = await act(of("bank-c"), issue, of);
    await settledAt(row.uetr, "bank-a", "bank-b", "bank-c");

    expect(await units(omnibus)).toBe(5001n);
    expect(cad(await posted("bank-a", bankAccounts.bondHolding(BOND)))).toBe("50000000.00");
    expect(cad(await posted("bank-a", bankAccounts.custodyHolding(BOND)))).toBe("5001000.00");
    expect(cad(await posted("bank-a", bankAccounts.custodyPosition(BOND, "alder-pension")))).toBe("3000000.00");
    // The clients paid from their own deposits.
    expect(cad(await posted("bank-a", bankAccounts.customerDeposit("alder-pension")))).toBe("27000000.00");
    expect(cad(await posted("bank-a", bankAccounts.customerDeposit("birchline-insurance")))).toBe("17999000.00");
    await until(async () => (await of("bank-a").reconciliation())?.ok === true);
    expect(await custodyHolds()).toEqual([expect.objectContaining({ books: "5001000.00", chain: "5001000.00" })]);
  });

  it("buys and sells for a client against another bank, delivery versus payment at the omnibus", async () => {
    const omnibus = await of("bank-a").custodyWallet();
    const buy = { kind: "bond-trade", uetr: randomUUID(), bond: BOND, seller: "bank-b", buyer: "bank-a", units: "1000", price: "100200", buyerCustody: { client: "birchline-insurance", wallet: omnibus } } as const;
    await affirmAs(of("bank-a"), buy);
    const bought = await act(of("bank-b"), buy, of);
    await settledAt(bought.uetr, "bank-a", "bank-b");
    const sell = { kind: "bond-trade", uetr: randomUUID(), bond: BOND, seller: "bank-a", buyer: "bank-b", units: "508", price: "99900", sellerCustody: { client: "alder-pension", wallet: omnibus } } as const;
    await affirmAs(of("bank-b"), sell);
    const sold = await act(of("bank-a"), sell, of);
    await settledAt(sold.uetr, "bank-a", "bank-b");

    expect(await units(omnibus)).toBe(5493n);
    expect(cad(await posted("bank-a", bankAccounts.custodyPosition(BOND, "birchline-insurance")))).toBe("3001000.00");
    expect(cad(await posted("bank-a", bankAccounts.custodyPosition(BOND, "alder-pension")))).toBe("2492000.00");
    // Bank A's own book did not move; the clients' deposits did.
    expect(cad(await posted("bank-a", bankAccounts.bondHolding(BOND)))).toBe("50000000.00");
    expect(cad(await posted("bank-a", bankAccounts.customerDeposit("birchline-insurance")))).toBe("16997000.00");
    expect(cad(await posted("bank-a", bankAccounts.customerDeposit("alder-pension")))).toBe("27507492.00");
    await until(async () => (await of("bank-a").reconciliation())?.ok === true);
    await custodyHolds();
  });

  it("takes no new position for a client whose KYC claim it revoked, and keeps what the client holds", async () => {
    const revoked = await of("bank-a").proposeChange({ action: "claim", op: "revoke", subject: "bank-a/birchline-insurance" }, "admin-1");
    expect(revoked.status).toBe("applied");
    const buy = { kind: "bond-trade", uetr: randomUUID(), bond: BOND, seller: "bank-b", buyer: "bank-a", units: "10", price: "100000", buyerCustody: { client: "birchline-insurance", wallet: await of("bank-a").custodyWallet() } } as const;
    await expect(affirmAs(of("bank-a"), buy)).rejects.toMatchObject({ reason: "invalid-flow" });
    expect(cad(await posted("bank-a", bankAccounts.custodyPosition(BOND, "birchline-insurance")))).toBe("3001000.00");
  });

  it("allocates a coupon on the omnibus to the clients by their positions at the record block, the residual shown", async () => {
    await mine();
    const row = await payNextAs(of("bank-c"), BOND);
    const flow = row.flow as Extract<BondFlow, { kind: "bond-coupon" }>;
    const omnibus = flow.payments.find((p) => p.wallet);
    expect(omnibus).toMatchObject({ bank: "bank-a", units: "5493", wallet: await of("bank-a").custodyWallet() });
    await settledAt(row.uetr, "bank-a", "bank-b", "bank-c");

    // 181 days at 3.25% on $1,000: 16.116438… a unit. The omnibus is paid on 5,493 units, rounded once;
    // each client on its own units, rounded once; the cent between is Bank A's residual, shown.
    expect(cad(BigInt(omnibus!.amount))).toBe("88527.60");
    const entry = await of("bank-a").entry(row.uetr);
    const credit = (account: string) => entry!.lines.find((l) => l.account === account && l.side === "credit")?.amount.minor ?? 0n;
    expect(cad(credit(bankAccounts.customerDeposit("alder-pension")))).toBe("40162.16");
    expect(cad(credit(bankAccounts.customerDeposit("birchline-insurance")))).toBe("48365.43");
    const residual = entry!.lines.filter((l) => l.account === bankAccounts.roundingResidual);
    expect(residual.map((l) => [l.side, cad(l.amount.minor)])).toEqual([["credit", "0.01"]]);
    await until(async () => (await of("bank-a").reconciliation())?.ok === true);
    const checks = await custodyHolds();
    expect(checks).toContainEqual(expect.objectContaining({ account: `${BOND} payment 1 to clients`, books: "88527.59 allocated + 0.01 residual", chain: "88527.60", ok: true }));
  });

  it("recovers a lost omnibus wallet to a new one with its units, the clients' positions untouched", async () => {
    const lost = await of("bank-a").custodyWallet();
    const change = await of("bank-a").proposeChange({ action: "recovery", op: "custody-wallet" }, "admin-1");
    await until(async () => (await of("bank-a").change(change.id))?.status === "applied");
    const replacement = await of("bank-a").custodyWallet();
    expect(replacement).toBe(custodyAddress("bank-a", 2));
    expect(await units(lost)).toBe(0n);
    expect(await units(replacement)).toBe(5493n);
    // The agent and the registry's operator each applied their part under their own policy.
    expect((await of("bank-c").changes()).map((c) => [c.action, c.status])).toContainEqual(["recovery", "applied"]);
    expect((await of("central-bank").changes()).map((c) => [c.action, c.status])).toContainEqual(["bind-address", "applied"]);
    await mine();
    await until(async () => (await of("bank-a").reconciliation())?.ok === true);
    await custodyHolds();
    expect(cad(await posted("bank-a", bankAccounts.custodyPosition(BOND, "birchline-insurance")))).toBe("3001000.00");
    expect((await of("bank-a").custody()).wallets.map((w) => w.status)).toEqual(["lost", "active"]);
  });

  it("pays the next coupon at the new wallet, and redeems the clients' units with them", async () => {
    // Pay through to maturity; the omnibus holding is paid at its new wallet, the redemption burns it there.
    let row = await payNextAs(of("bank-c"), BOND);
    for (;;) {
      const flow = row.flow as Extract<BondFlow, { kind: "bond-coupon" | "bond-redeem" }>;
      expect(flow.payments.find((p) => p.wallet)?.wallet).toBe(custodyAddress("bank-a", 2));
      await settledAt(row.uetr, "bank-a", "bank-b", "bank-c");
      if (flow.kind === "bond-redeem") break;
      await mine();
      row = await payNextAs(of("bank-c"), BOND);
    }
    expect(await units(custodyAddress("bank-a", 2))).toBe(0n);
    expect(cad(await posted("bank-a", bankAccounts.custodyHolding(BOND)))).toBe("0.00");
    expect(cad(await posted("bank-a", bankAccounts.custodyPosition(BOND, "alder-pension")))).toBe("0.00");
    await until(async () => (await of("bank-a").reconciliation())?.ok === true);
    await custodyHolds();
  });
});
