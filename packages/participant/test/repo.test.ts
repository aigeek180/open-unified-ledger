import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { type Deployment, deployScenario, type Network, sandboxChain } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "@oul/chain/testing";
import { bankAccounts, formatMoney, money } from "@oul/domain";
import { readMessage, validate } from "@oul/iso20022";
import { loadScenario, type Scenario, withoutPolicies } from "@oul/scenario";
import pg from "pg";
import { createTestClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, affirmAs, type Flow, Participant, type Peers, payNextAs } from "../src/index.ts";
import { planClose, planManufactured, planMargin, planSubstitution } from "../src/repo.ts";

/**
 * A repo's whole life through the participant runtime (SPEC.md §5.7–§5.10)
 * on a local chain: Bank A lends to Bank B against bonds Bank B bought at
 * issue; the lender calls margin and the borrower delivers it; a coupon paid
 * on collateral goes to the lender, which passes it on; the borrower
 * substitutes one bond for the other; and the repo closes, repaying principal
 * plus interest. Every participant reconciles throughout, invariant 14
 * included.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const LONG = "BOND-ISSUER-2031";
const SHORT = "BOND-ISSUER-2029";
const run = anvilPath() ? describe : describe.skip;

run("repo through the participant runtime", () => {
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
    marginCall: async (participant, call) => {
      await of(participant).receiveMarginCall(call);
    },
  };
  const testClient = () => createTestClient({ mode: "anvil", chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() });

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
  const units = (n: bigint) => n * 100_000n; // $1,000.00 face, in minor units

  async function reconcilesEverywhere() {
    for (const id of participants.keys()) {
      const reconciliation = await of(id).reconciliation();
      const failing = reconciliation?.checks.filter((c) => !c.ok);
      expect(failing, `${id} reconciles`).toEqual([]);
      expect((await of(id).rt.books.trialBalance()).totals.get("CAD")).toBe(0n);
    }
  }
  const invariant14 = async (id: string) => (await of(id).reconciliation())!.checks.filter((c) => c.invariant === 14);

  let repo: string;
  const terms = { lender: "bank-a", borrower: "bank-b", cash: "1000000000", rate: "0.0275", haircut: "0.02", startDate: "2027-04-26", endDate: "2027-05-10" } as const;

  beforeAll(async () => {
    anvil = startAnvil();
    // Approval policies have their own test (policy.test.ts); here every flow goes straight on.
    scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-repo")));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-b", "bank-c"]) {
      const schema = `repo_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
      schemas.push(schema);
      participants.set(id, await Participant.open({ scenario, deployment, network, participant: id, databaseUrl: DATABASE_URL, schema, peers }));
    }
    for (const [bank, amount] of [["bank-a", "4000000000"], ["bank-b", "6000000000"], ["bank-c", "1000000000"]] as const) {
      const funded = await act(of(bank), { kind: "fund", bank, currency: "CAD", amount }, of);
      await settledAt(funded.uetr, bank, "central-bank");
    }
    // Bank B buys 30,000 units of the long bond and 20,000 of the short one at issue; Bank A 5,000 of the long one.
    for (const [bond, allocations] of [
      [LONG, [{ bank: "bank-b", units: "30000" }, { bank: "bank-a", units: "5000" }]],
      [SHORT, [{ bank: "bank-b", units: "20000" }]],
    ] as const) {
      const issue = { kind: "bond-issue", uetr: randomUUID(), bond, price: "100000", allocations } as const;
      for (const a of allocations) await affirmAs(of(a.bank), issue);
      const row = await act(of("bank-c"), issue, of);
      await settledAt(row.uetr, "bank-c", ...allocations.map((a) => a.bank));
    }
  }, 120_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("opens only on terms the lender affirmed and collateral that covers the cash (5.7)", async () => {
    repo = randomUUID();
    // 10,300 units marked at $1,000.00 with a 2% haircut cover $10,000,000.
    const open = { kind: "repo-open", uetr: repo, ...terms, bond: LONG, units: "10300", mark: "100000" } as const;
    await expect(act(of("bank-b"), open, of)).rejects.toMatchObject({ reason: "not-a-party" });
    expect(await of("bank-b").instruction(repo)).toBeUndefined();

    const short = { ...open, uetr: randomUUID(), units: "10000" };
    await expect(affirmAs(of("bank-a"), short)).rejects.toMatchObject({ reason: "invalid-flow", message: expect.stringMatching(/do not cover/) });

    await affirmAs(of("bank-a"), open);
    const row = await act(of("bank-b"), open, of);
    expect(row.approvals).toHaveLength(1);
    await settledAt(repo, "bank-a", "bank-b");

    // Neither side treats it as a sale: the borrower keeps the units in its holdings.
    expect(cad(await posted("bank-a", bankAccounts.reverseRepos))).toBe("10000000.00");
    expect(cad(await posted("bank-a", bankAccounts.collateralReceivedIn(LONG)))).toBe("10300000.00");
    expect(cad(await posted("bank-a", bankAccounts.bondHolding(LONG)))).toBe("5000000.00");
    expect(cad(await posted("bank-b", bankAccounts.repoBorrowings))).toBe("10000000.00");
    expect(cad(await posted("bank-b", bankAccounts.bondHolding(LONG)))).toBe("30000000.00");
    expect(cad(await posted("bank-b", bankAccounts.collateralPledgedIn(LONG)))).toBe("10300000.00");
    const view = await of("bank-a").repo(repo);
    expect(view).toMatchObject({ role: "lender", counterparty: "bank-b", status: "open", collateral: [{ bond: LONG, units: "10300" }], repurchasePrice: "10010547.95" });
    expect((await of("bank-b").repo(repo))?.role).toBe("borrower");
    await reconcilesEverywhere();
    expect((await invariant14("bank-a")).length).toBeGreaterThan(0);
  });

  it("lets the borrower deliver only units it has not pledged", async () => {
    // Bank B owns 30,000 units of the long bond and pledged 10,300: it may sell 19,700, not 19,701.
    const trade = { kind: "bond-trade", uetr: randomUUID(), bond: LONG, seller: "bank-b", buyer: "bank-a", units: "19701", price: "100000" } as const;
    await affirmAs(of("bank-a"), trade);
    await expect(act(of("bank-b"), trade, of)).rejects.toMatchObject({ reason: "insufficient-funds", message: expect.stringMatching(/pledged/) });
    // Nor may the lender sell the collateral it holds: only its own 5,000.
    const resale = { kind: "bond-trade", uetr: randomUUID(), bond: LONG, seller: "bank-a", buyer: "bank-b", units: "5001", price: "100000" } as const;
    await affirmAs(of("bank-b"), resale);
    await expect(act(of("bank-a"), resale, of)).rejects.toMatchObject({ reason: "insufficient-funds" });
  });

  it("delivers the margin the lender called at an agreed mark, and shows a call not met overdue on both sides (5.8)", async () => {
    // At $990.00 on 3 May the collateral is short of the cash plus a week's interest: 13 more units cover it.
    const marks = [{ bond: LONG, price: "99000" }];
    const plan = await planMargin(of("bank-a").rt, repo, marks, "2027-05-03", LONG);
    expect(plan).toMatchObject({ direction: "deliver", units: "13" });
    const call = { ...plan, uetr: randomUUID() };
    // The borrower cannot deliver on a call it never heard of; the lender cannot call what the marks do not.
    await expect(act(of("bank-b"), call, of)).rejects.toMatchObject({ reason: "invalid-flow" });
    await expect(affirmAs(of("bank-a"), { ...call, units: "12" })).rejects.toMatchObject({ reason: "invalid-flow" });
    await affirmAs(of("bank-a"), call);
    const called = (await of("bank-b").repo(repo))!.calls;
    expect(called).toEqual([expect.objectContaining({ uetr: call.uetr, caller: "bank-a", status: "open" })]);

    const row = await act(of("bank-b"), call, of);
    await settledAt(row.uetr, "bank-a", "bank-b");
    expect((await of("bank-a").repo(repo))?.collateral).toEqual([{ bond: LONG, units: "10313" }]);
    expect((await of("bank-b").repo(repo))?.calls[0]?.status).toBe("met");
    expect(await posted("bank-b", bankAccounts.collateralPledgedIn(LONG))).toBe(units(10_313n));
    const covered = (await invariant14("bank-a")).find((c) => c.account.includes("margin"));
    expect(covered).toMatchObject({ ok: true });

    // A second call, at a lower mark, left unmet past its due time: overdue at both banks.
    const lower = { ...(await planMargin(of("bank-a").rt, repo, [{ bond: LONG, price: "98000" }], "2027-05-03", LONG)), uetr: randomUUID() };
    await affirmAs(of("bank-a"), lower);
    await testClient().increaseTime({ seconds: 301 });
    await testClient().mine({ blocks: 1 });
    for (const bank of ["bank-a", "bank-b"]) {
      expect((await of(bank).repo(repo))!.calls.find((c) => c.uetr === lower.uetr)?.status, bank).toBe("overdue");
    }
    // Late, it is still delivered, and met.
    const late = await act(of("bank-b"), lower, of);
    await settledAt(late.uetr, "bank-a", "bank-b");
    expect((await of("bank-a").repo(repo))!.calls.find((c) => c.uetr === lower.uetr)?.status).toBe("met");
    await reconcilesEverywhere();
  });

  it("pays a coupon on collateral to the lender, which passes it on to the borrower (5.10)", async () => {
    await testClient().mine({ blocks: 1 });
    const coupon = await payNextAs(of("bank-c"), LONG);
    await settledAt(coupon.uetr, "bank-a", "bank-b", "bank-c");
    const flow = coupon.flow as Extract<Flow, { kind: "bond-coupon" }>;
    // The lender held its own 5,000 units and the 10,418 of collateral at the record block.
    expect(flow.payments.find((p) => p.bank === "bank-a")?.units).toBe("15418");
    expect(flow.payments.find((p) => p.bank === "bank-b")?.units).toBe(String(30_000 - 10_418));

    const owed = (await of("bank-a").repo(repo))!.manufactured;
    expect(owed).toEqual([expect.objectContaining({ bond: LONG, period: 1, units: "10418", paidBy: null })]);
    const plan = await planManufactured(of("bank-a").rt, repo, LONG, 1);
    // 181 days at 3.25% on 10,418 units of $1,000, rounded once: the coupon on the collateral alone.
    expect(cad(BigInt(plan.amount))).toBe("167901.05");
    const incomeBefore = await posted("bank-b", bankAccounts.interestIncome);
    await expect(act(of("bank-a"), { ...plan, amount: String(BigInt(plan.amount) + 1n) }, of)).rejects.toMatchObject({ reason: "invalid-flow" });
    const row = await act(of("bank-a"), plan, of);
    await settledAt(row.uetr, "bank-a", "bank-b");
    expect(await posted("bank-b", bankAccounts.interestIncome)).toBe(incomeBefore + BigInt(plan.amount));
    expect(await posted("bank-a", bankAccounts.manufacturedPayments)).toBe(BigInt(plan.amount));
    // Once only.
    await expect(act(of("bank-a"), { ...plan, uetr: randomUUID() }, of)).rejects.toMatchObject({ reason: "conflicting-instruction" });
    await reconcilesEverywhere();
  });

  it("substitutes one bond for the other in one instruction, at the marks both affirmed (5.9)", async () => {
    const marks = [
      { bond: LONG, price: "100150" },
      { bond: SHORT, price: "98725" },
    ];
    const plan = { ...(await planSubstitution(of("bank-a").rt, repo, { bond: LONG, units: "10418" }, SHORT, marks, "2027-05-05")), uetr: randomUUID() };
    // 10,418 units at $1,001.50 are worth $10,433,627.00: 10,569 units at $987.25 are the fewest worth as much.
    expect(plan.incoming).toEqual({ bond: SHORT, units: "10569" });
    await expect(act(of("bank-b"), plan, of)).rejects.toMatchObject({ reason: "not-a-party" });
    await affirmAs(of("bank-a"), plan);
    const row = await act(of("bank-b"), plan, of);
    await settledAt(row.uetr, "bank-a", "bank-b");
    expect((await of("bank-b").repo(repo))?.collateral).toEqual([{ bond: SHORT, units: "10569" }]);
    expect(await posted("bank-a", bankAccounts.collateralReceivedIn(LONG))).toBe(0n);
    expect(await posted("bank-a", bankAccounts.collateralReceivedIn(SHORT))).toBe(units(10_569n));
    expect(await posted("bank-b", bankAccounts.collateralPledgedIn(SHORT))).toBe(units(10_569n));
    await reconcilesEverywhere();
  });

  it("refuses to redeem a bond while units of it are repo collateral", async () => {
    const redeem = {
      kind: "bond-redeem",
      uetr: randomUUID(),
      deadline: Math.floor(Date.now() / 1000) + 600,
      bond: SHORT,
      period: 5,
      recordBlock: "1",
      issuerDebit: "1",
      payments: [{ bank: "bank-a", units: "10569", principal: "1056900000", coupon: "0" }],
    } as const;
    await expect(of("bank-a").approve(redeem)).rejects.toMatchObject({ reason: "invalid-flow", message: expect.stringMatching(/open repos/) });
  });

  it("closes at the end date: every unit back, principal plus interest repaid, both records cleared (5.10)", async () => {
    const plan = { ...(await planClose(of("bank-b").rt, repo)), uetr: randomUUID() };
    expect(plan.collateral).toEqual([{ bond: SHORT, units: "10569" }]);
    // $10,000,000 at 2.75% for 14 days, ACT/365F, rounded once, half-even.
    expect(cad(BigInt(plan.interest))).toBe("10547.95");
    await expect(act(of("bank-b"), { ...plan, interest: "1054794" }, of)).rejects.toMatchObject({ reason: "invalid-flow" });
    const [incomeBefore, expenseBefore] = [await posted("bank-a", bankAccounts.interestIncome), await posted("bank-b", bankAccounts.interestExpense)];
    const row = await act(of("bank-b"), plan, of);
    await settledAt(row.uetr, "bank-a", "bank-b");
    expect(await posted("bank-a", bankAccounts.interestIncome)).toBe(incomeBefore + BigInt(plan.interest));
    expect(await posted("bank-b", bankAccounts.interestExpense)).toBe(expenseBefore + BigInt(plan.interest));

    for (const bank of ["bank-a", "bank-b"]) {
      expect((await of(bank).repo(repo))?.status, bank).toBe("closed");
      for (const account of [bankAccounts.reverseRepos, bankAccounts.repoBorrowings, bankAccounts.collateralReceived, bankAccounts.collateralPledged]) {
        expect(await posted(bank, account), `${bank} ${account}`).toBe(0n);
      }
    }
    const close = (await invariant14("bank-a")).find((c) => c.account.includes("close"));
    expect(close).toMatchObject({ books: "10010547.95", ok: true });
    await expect(act(of("bank-b"), { ...plan, uetr: randomUUID() }, of)).rejects.toMatchObject({ reason: "invalid-flow" });
    await reconcilesEverywhere();
  });

  it("keeps invariant 14 in each bank's reconciliation: the record, the books and every flow", async () => {
    const checks = await invariant14("bank-b");
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.account)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/record$/),
        expect.stringMatching(/margin at block/),
        expect.stringMatching(/substitution at block/),
        expect.stringMatching(/close at block/),
        bankAccounts.collateralPledgedIn(SHORT),
      ]),
    );
  });

  it("gives each side ISO 20022 messages for every repo flow, valid against the official XSDs (SPEC.md §8)", async () => {
    const names = new Map<string, string[]>();
    for (const bank of ["bank-a", "bank-b"]) {
      const repoRows = (await of(bank).instructions({ limit: 100 })).filter((r) => r.flow.kind.startsWith("repo-") && r.status === "settled");
      expect(repoRows.length).toBeGreaterThanOrEqual(6);
      for (const row of repoRows) {
        for (const message of (await of(bank).messages(row.uetr))!) {
          const result = await validate(message.xml, message.version as Parameters<typeof validate>[1]);
          expect(result.errors, `${bank} ${row.flow.kind} ${message.name}`).toEqual([]);
          expect(readMessage(message.xml).uetrs.length + (message.type === "pacs.009" ? 1 : 0)).toBeGreaterThan(0);
          names.set(row.flow.kind, [...(names.get(row.flow.kind) ?? []), `${bank}:${message.name}`]);
        }
      }
    }
    expect(names.get("repo-open")).toEqual(expect.arrayContaining(["bank-b:sese.023-deliver", "bank-a:sese.025-receive"]));
    expect(names.get("repo-substitute")).toEqual(expect.arrayContaining(["bank-a:sese.023-deliver-out", "bank-b:sese.023-deliver-in"]));
    expect(names.get("repo-close")).toEqual(expect.arrayContaining(["bank-a:sese.025-deliver", "bank-b:sese.025-receive"]));
    expect(names.get("repo-manufactured")).toEqual(expect.arrayContaining(["bank-a:pacs.009", "bank-b:camt.054-borrower-credit"]));
  });
});
