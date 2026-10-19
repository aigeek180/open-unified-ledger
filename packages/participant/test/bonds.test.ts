import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { contracts, type Deployment, deployScenario, type Network, sandboxChain } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "@oul/chain/testing";
import { bankAccounts, formatMoney, money } from "@oul/domain";
import { loadScenario, type Scenario, withoutPolicies } from "@oul/scenario";
import pg from "pg";
import { createTestClient, http, publicActions } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, affirmAs, payNextAs, type BondFlow, Participant, type Peers } from "../src/index.ts";

/**
 * A bond's whole life through the participant runtime (SPEC.md §5.4–§5.6) on
 * a local chain: issued through Bank C to Banks A and B, traded, every coupon
 * paid with each holder verifying its own amount, and redeemed. Every
 * participant reconciles throughout, including invariants 8 and 10.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const BOND = "BOND-ISSUER-2031";
const run = anvilPath() ? describe : describe.skip;

run("bonds through the participant runtime", () => {
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
  const settledAt = (uetr: string, ...ids: string[]) =>
    until(async () => (await Promise.all(ids.map((id) => status(id, uetr)))).every((s) => s === "settled"));
  const posted = async (id: string, account: string) => (await of(id).rt.books.balance(account)).posted.minor;
  const cad = (minor: bigint) => formatMoney(money("CAD", minor));

  beforeAll(async () => {
    anvil = startAnvil();
    // Approval policies have their own test (policy.test.ts); here every flow goes straight on.
    scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-bond-dvp")));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-b", "bank-c"]) {
      const schema = `bond_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
      schemas.push(schema);
      participants.set(
        id,
        await Participant.open({ scenario, deployment, network, participant: id, databaseUrl: DATABASE_URL, schema, peers }),
      );
    }
    const a = await act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "CAD", amount: "7000000000" }, of);
    const b = await act(of("bank-b"), { kind: "fund", bank: "bank-b", currency: "CAD", amount: "5000000000" }, of);
    await settledAt(a.uetr, "bank-a", "central-bank");
    await settledAt(b.uetr, "bank-b", "central-bank");
  }, 90_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  async function reconcilesEverywhere() {
    for (const id of participants.keys()) {
      const reconciliation = await of(id).reconciliation();
      const failing = reconciliation?.checks.filter((c) => !c.ok);
      expect(failing, `${id} reconciles`).toEqual([]);
      expect((await of(id).rt.books.trialBalance()).totals.get("CAD")).toBe(0n);
    }
  }

  it("issues units only to buyers that affirmed them, against payment (5.4)", async () => {
    const uetr = randomUUID();
    const issue = {
      kind: "bond-issue",
      uetr,
      bond: BOND,
      price: "100000",
      allocations: [
        { bank: "bank-a", units: "60000" },
        { bank: "bank-b", units: "40000" },
      ],
    } as const;
    await affirmAs(of("bank-a"), issue);
    // Bank B has not affirmed: it will not pay, so nothing is issued.
    await expect(act(of("bank-c"), issue, of)).rejects.toMatchObject({ reason: "not-a-party" });
    expect(await of("bank-c").instruction(uetr)).toBeUndefined();

    await affirmAs(of("bank-b"), issue);
    const row = await act(of("bank-c"), issue, of);
    expect(row.approvals).toHaveLength(2);
    await settledAt(uetr, "bank-a", "bank-b", "bank-c");

    expect(cad(await posted("bank-a", bankAccounts.bondHolding(BOND)))).toBe("60000000.00");
    expect(cad(await posted("bank-b", bankAccounts.bondHolding(BOND)))).toBe("40000000.00");
    expect(cad(await posted("bank-c", bankAccounts.customerDeposit("issuer")))).toBe("120000000.00");
    await reconcilesEverywhere();
  });

  it("settles a trade delivery versus payment, the price-to-face difference a gain or loss (5.5)", async () => {
    const trade = { kind: "bond-trade", uetr: randomUUID(), bond: BOND, seller: "bank-a", buyer: "bank-b", units: "7000", price: "100150" } as const;
    await affirmAs(of("bank-b"), trade);
    const row = await act(of("bank-a"), trade, of);
    await settledAt(row.uetr, "bank-a", "bank-b");
    expect(cad(await posted("bank-a", bankAccounts.bondHolding(BOND)))).toBe("53000000.00");
    expect(cad(await posted("bank-b", bankAccounts.bondHolding(BOND)))).toBe("47000000.00");
    expect(cad(await posted("bank-a", bankAccounts.securitiesGains))).toBe("10500.00");
    expect(cad(await posted("bank-b", bankAccounts.securitiesGains))).toBe("-10500.00");
    await reconcilesEverywhere();
  });

  it("stops a bank whose KYC claim the central bank revoked receiving units, without touching what it holds (ERC-3643)", async () => {
    expect((await of("bank-b").bond(BOND)).verified).toBe(true);
    const identity = await of("bank-b").identity();
    expect(identity.claims).toEqual([expect.objectContaining({ issuer: "central-bank", valid: true })]);
    expect((await of("central-bank").identity()).issued.map((c) => c.subject).sort()).toEqual(["bank-a", "bank-b", "bank-c"]);

    const revoked = await of("central-bank").proposeChange({ action: "claim", op: "revoke", subject: "bank-b" }, "admin-1");
    expect(revoked.status).toBe("applied");
    expect((await of("bank-b").bond(BOND)).verified).toBe(false);
    expect((await of("bank-b").identity()).claims[0]?.valid).toBe(false);

    // A trade to Bank B is refused by the bond's compliance on chain, and voided in both books.
    const buy = { kind: "bond-trade", uetr: randomUUID(), bond: BOND, seller: "bank-a", buyer: "bank-b", units: "10", price: "100000" } as const;
    await affirmAs(of("bank-b"), buy);
    const refused = await act(of("bank-a"), buy, of);
    await until(async () => (await status("bank-a", refused.uetr)) === "failed");
    expect((await of("bank-a").instruction(refused.uetr))?.lastError).toMatch(/ReceiverNotVerified/);
    // Bank B still holds its units and still sells them.
    const sell = { kind: "bond-trade", uetr: randomUUID(), bond: BOND, seller: "bank-b", buyer: "bank-a", units: "1000", price: "100000" } as const;
    await affirmAs(of("bank-a"), sell);
    const sold = await act(of("bank-b"), sell, of);
    await settledAt(sold.uetr, "bank-a", "bank-b");
    expect(cad(await posted("bank-b", bankAccounts.bondHolding(BOND)))).toBe("46000000.00");
    await reconcilesEverywhere();
  });

  it("pays a coupon each holder verified, and keeps the rounding residual visible (5.6, invariant 8)", async () => {
    await createTestClient({ mode: "anvil", chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() }).mine({
      blocks: 1,
    });
    const row = await payNextAs(of("bank-c"), BOND);
    const flow = row.flow as Extract<BondFlow, { kind: "bond-coupon" }>;
    expect(flow.kind).toBe("bond-coupon");
    expect(flow.period).toBe(1);
    // 181 days at 3.25% on $1,000: 54,000 and 46,000 units, each rounded once.
    expect(flow.payments.map((p) => [p.bank, cad(BigInt(p.amount))])).toEqual([
      ["bank-a", "870287.67"],
      ["bank-b", "741356.16"],
    ]);
    expect(cad(BigInt(flow.issuerDebit))).toBe("1611643.84");
    await settledAt(row.uetr, "bank-a", "bank-b", "bank-c");

    expect(cad(await posted("bank-a", bankAccounts.interestIncome))).toBe("870287.67");
    expect(cad(await posted("bank-c", bankAccounts.roundingResidual))).toBe("-0.01");
    const invariant8 = (await of("bank-c").reconciliation())!.checks.filter((c) => c.invariant === 8);
    expect(invariant8).toEqual([
      expect.objectContaining({ account: `${BOND} payment 1`, books: "1611643.84", ok: true }),
    ]);
    await reconcilesEverywhere();
  });

  it("has every holder refuse a coupon it did not compute, or one already paid", async () => {
    const plan = (await payNextAs(of("bank-c"), BOND, randomUUID())).flow as Extract<BondFlow, { kind: "bond-coupon" }>;
    expect(plan.period).toBe(2);
    await settledAt(plan.uetr, "bank-a", "bank-b", "bank-c");

    const tampered = {
      ...plan,
      uetr: randomUUID(),
      period: 3,
      payments: plan.payments.map((p) => (p.bank === "bank-a" ? { ...p, amount: (BigInt(p.amount) + 1n).toString() } : p)),
    };
    await expect(of("bank-a").approve(tampered)).rejects.toMatchObject({ reason: "invalid-flow" });
    const again = { ...plan, uetr: randomUUID() };
    await expect(of("bank-a").approve(again)).rejects.toMatchObject({ reason: "conflicting-instruction" });
  });

  it("pays every remaining coupon and redeems at maturity, cancelling every unit", async () => {
    // Repaying face needs more wholesale than issue brought in after coupons: the agent tops up from RTGS.
    const funding = await act(of("bank-c"), { kind: "fund", bank: "bank-c", currency: "CAD", amount: "2000000000" }, of);
    await settledAt(funding.uetr, "bank-c", "central-bank");

    const issuerBefore = await posted("bank-c", bankAccounts.customerDeposit("issuer"));
    let last: BondFlow | undefined;
    let debited = 0n;
    for (let n = 0; n < 8; n++) {
      const row = await payNextAs(of("bank-c"), BOND);
      last = row.flow as BondFlow;
      debited += BigInt((last as { issuerDebit: string }).issuerDebit);
      await settledAt(row.uetr, "bank-a", "bank-b", "bank-c");
    }
    expect(last?.kind).toBe("bond-redeem");
    expect((last as Extract<BondFlow, { kind: "bond-redeem" }>).period).toBe(10);

    const bond = deployment.tokens[BOND]!.address;
    const client = createTestClient({ mode: "anvil", chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() }).extend(
      publicActions,
    );
    expect(await client.readContract({ address: bond, abi: contracts.Bond.abi, functionName: "totalSupply" })).toBe(0n);
    expect(await posted("bank-a", bankAccounts.bondHolding(BOND))).toBe(0n);
    expect(await posted("bank-b", bankAccounts.bondHolding(BOND))).toBe(0n);
    expect(await posted("bank-c", bankAccounts.customerDeposit("issuer"))).toBe(issuerBefore - debited);

    const invariant8 = (await of("bank-c").reconciliation())!.checks.filter((c) => c.invariant === 8);
    expect(invariant8).toHaveLength(10);
    expect(invariant8.every((c) => c.ok)).toBe(true);
    await reconcilesEverywhere();

    await expect(payNextAs(of("bank-c"), BOND)).rejects.toMatchObject({ reason: "invalid-flow" });
  });
});
