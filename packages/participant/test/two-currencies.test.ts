import { randomBytes } from "node:crypto";
import path from "node:path";
import { contracts, type Deployment, deployScenario, type Network, participantIdHash, sandboxChain } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "@oul/chain/testing";
import { bankAccounts, centralBankAccounts } from "@oul/domain";
import { loadScenario, type Scenario, withoutPolicies } from "@oul/scenario";
import pg from "pg";
import { createPublicClient, createTestClient, http, type PublicClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, type Flow, FlowRejected, Participant, type Peers } from "../src/index.ts";

/**
 * Two currencies on one ledger (SPEC.md §13), through the same runtime: the
 * ca-us-pvp scenario deployed with its two central banks, the first operating
 * the registry; each bank funding the currencies it holds reserves in; and
 * every participant's books balanced and reconciled in each currency apart;
 * and payments across the two currencies, payment versus payment, at the
 * dealer's signed quotes.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;

run("two currencies on one ledger", () => {
  let anvil: Anvil;
  let scenario: Scenario;
  let network: Network;
  let deployment: Deployment;
  let client: PublicClient;
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

  async function until(done: () => Promise<boolean>, rounds = 25) {
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
  const settled = (uetr: string, ...ids: string[]) => async () =>
    (await Promise.all(ids.map((id) => status(id, uetr)))).every((s) => s === "settled");
  const posted = async (id: string, account: string) => (await of(id).rt.books.balance(account)).posted;
  const refusal = (attempt: Promise<unknown>) =>
    attempt.then(
      () => "accepted",
      (error: unknown) => (error instanceof FlowRejected ? `${error.reason}: ${error.message}` : String(error)),
    );

  beforeAll(async () => {
    anvil = startAnvil();
    // Approval policies have their own test (policy.test.ts); here every flow goes straight on.
    scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-us-pvp")));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    client = createPublicClient({ chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() }) as PublicClient;
    for (const id of ["cad-central-bank", "usd-central-bank", "bank-a", "bank-b", "bank-c"]) {
      const schema = `cc_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
      schemas.push(schema);
      participants.set(
        id,
        await Participant.open({ scenario, deployment, network, participant: id, databaseUrl: DATABASE_URL, schema, peers }),
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("deploys a wholesale token per currency, each issued by its own central bank", async () => {
    const read = (address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;
    expect(await read(deployment.contracts.registry, contracts.ParticipantRegistry.abi, "operator")).toBe(
      participantIdHash("cad-central-bank"),
    );
    expect(deployment.tokens["wCAD"]).toMatchObject({ kind: "wholesale", issuer: "cad-central-bank", currency: "CAD" });
    expect(deployment.tokens["wUSD"]).toMatchObject({ kind: "wholesale", issuer: "usd-central-bank", currency: "USD" });
    expect(deployment.tokens["dUSD-B"]).toMatchObject({ kind: "deposit", issuer: "bank-b", currency: "USD" });

    // Each central bank opened reserve accounts for the banks holding its currency, and only those.
    const wusd = deployment.tokens["wUSD"]!.address;
    const hasAccount = (bank: string) => read(wusd, contracts.WholesaleToken.abi, "hasReserveAccount", [participantIdHash(bank)]);
    expect(await hasAccount("bank-b")).toBe(true);
    expect(await hasAccount("bank-c")).toBe(true);
    expect(await hasAccount("bank-a")).toBe(false);
    expect(await read(wusd, contracts.WholesaleToken.abi, "issuer")).toBe(participantIdHash("usd-central-bank"));
  });

  it("funds each currency at its own central bank, and the dealer in both", async () => {
    const flows = [
      ["bank-a", "CAD", "100000000", "cad-central-bank"],
      ["bank-b", "USD", "80000000", "usd-central-bank"],
      ["bank-c", "CAD", "50000000", "cad-central-bank"],
      ["bank-c", "USD", "40000000", "usd-central-bank"],
    ] as const;
    const rows = [];
    for (const [bank, currency, amount, cb] of flows) {
      const row = await act(of(bank), { kind: "fund", bank, currency, amount }, of);
      // The currency's own central bank mints it; the other has no part in it.
      expect((await of(cb).instruction(row.uetr))?.role).toBe("submitter");
      const other = cb === "cad-central-bank" ? "usd-central-bank" : "cad-central-bank";
      expect(await of(other).instruction(row.uetr)).toBeUndefined();
      rows.push([row.uetr, bank, cb] as const);
    }
    for (const [uetr, bank, cb] of rows) await until(settled(uetr, bank, cb));

    // The dealer's reserves, apart in each currency.
    expect(await posted("bank-c", bankAccounts.wholesaleReserves("CAD"))).toEqual({ currency: "CAD", minor: 50000000n });
    expect(await posted("bank-c", bankAccounts.wholesaleReserves("USD"))).toEqual({ currency: "USD", minor: 40000000n });
    expect(await posted("bank-c", bankAccounts.rtgsReserves("USD"))).toEqual({ currency: "USD", minor: 30000000000n - 40000000n });
    // Each central bank's line for the dealer, in its own currency.
    expect(await posted("cad-central-bank", centralBankAccounts.wholesaleLine("bank-c"))).toEqual({ currency: "CAD", minor: 50000000n });
    expect(await posted("usd-central-bank", centralBankAccounts.wholesaleLine("bank-c"))).toEqual({ currency: "USD", minor: 40000000n });
    expect(await posted("usd-central-bank", centralBankAccounts.wholesaleOutstanding)).toEqual({ currency: "USD", minor: 120000000n });
  });

  it("refuses a currency a bank holds no reserves in, and a payment between two currencies' deposits", async () => {
    expect(await refusal(act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "USD", amount: "100" }, of))).toMatch(
      /^invalid-flow: bank-a holds no reserves in USD/,
    );
    const tokenize = await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "northwind-freight", amount: "500000" }, of);
    await until(settled(tokenize.uetr, "bank-a"));
    const payment = { kind: "interbank", payerBank: "bank-a", payer: "northwind-freight", payeeBank: "bank-b", payee: "mesa-solar", amount: "1000" } as const;
    expect(await refusal(act(of("bank-a"), payment, of))).toMatch(/^invalid-flow: dCAD-A is in CAD and dUSD-B in USD/);
  });

  it("pays between two banks' deposits in one currency, which only that currency's central bank observes", async () => {
    const pay = await act(of("bank-a"), {
      kind: "interbank",
      payerBank: "bank-a",
      payer: "northwind-freight",
      payeeBank: "bank-c",
      payee: "coastal-shipping",
      amount: "125050",
    }, of);
    await until(settled(pay.uetr, "bank-a", "bank-c"));
    expect(await posted("bank-c", bankAccounts.tokenizedDeposit("coastal-shipping"))).toEqual({ currency: "CAD", minor: 125050n });
    expect(await posted("bank-c", bankAccounts.wholesaleReserves("CAD"))).toEqual({ currency: "CAD", minor: 50000000n + 125050n });
    expect(await posted("bank-c", bankAccounts.wholesaleReserves("USD"))).toEqual({ currency: "USD", minor: 40000000n });
    // The CAD central bank books what it saw move between its lines; the USD one saw nothing of it.
    expect(await posted("cad-central-bank", centralBankAccounts.wholesaleLine("bank-a"))).toEqual({ currency: "CAD", minor: 100000000n - 125050n });
    expect((await of("cad-central-bank").rt.books.entries({ limit: 5, keys: [`instruction:${pay.uetr}`] })).length).toBe(1);
    expect((await of("usd-central-bank").rt.books.entries({ limit: 5, keys: [`instruction:${pay.uetr}`] })).length).toBe(0);

    const redeem = await act(of("bank-c"), { kind: "redeem", bank: "bank-c", currency: "USD", amount: "15000000" }, of);
    await until(settled(redeem.uetr, "bank-c"));
    await until(async () => (await posted("usd-central-bank", centralBankAccounts.wholesaleLine("bank-c"))).minor === 25000000n);
  });

  it("pays across currencies at the dealer's quote, four legs in one instruction", async () => {
    const quote = await of("bank-a").requestQuote("USD", "100000");
    expect(quote).toMatchObject({ dealer: "bank-c", requester: "bank-a", from: "CAD", to: "USD", sourceAmount: "100000", rate: "0.7315", targetAmount: "73150" });
    expect((await of("bank-c").quotes()).map((q) => [q.role, q.quote.id])).toContainEqual(["dealer", quote.id]);

    const before = {
      dealerCad: (await posted("bank-c", bankAccounts.wholesaleReserves("CAD"))).minor,
      dealerUsd: (await posted("bank-c", bankAccounts.wholesaleReserves("USD"))).minor,
      payer: (await posted("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).minor,
    };
    const pay = await act(of("bank-a"), { kind: "pvp", payerBank: "bank-a", payer: "northwind-freight", payeeBank: "bank-b", payee: "mesa-solar", quote }, of);
    // The instruction cannot outlive the quote: the engine refuses it after the quote expires.
    expect(pay.flow.deadline).toBe(quote.expiresAt);
    expect((await of("bank-c").instruction(pay.uetr))?.role).toBe("approver");
    expect((await of("bank-b").instruction(pay.uetr))?.role).toBe("approver");
    await until(settled(pay.uetr, "bank-a", "bank-b", "bank-c"));
    await until(async () => (await posted("usd-central-bank", centralBankAccounts.wholesaleLine("bank-b"))).minor === 80000000n + 73150n);

    expect((await posted("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).minor).toBe(before.payer - 100000n);
    expect(await posted("bank-b", bankAccounts.tokenizedDeposit("mesa-solar"))).toEqual({ currency: "USD", minor: 73150n });
    expect((await posted("bank-c", bankAccounts.wholesaleReserves("CAD"))).minor).toBe(before.dealerCad + 100000n);
    expect((await posted("bank-c", bankAccounts.wholesaleReserves("USD"))).minor).toBe(before.dealerUsd - 73150n);
    // The dealer's FX positions carry the exchange; its books still balance in each currency.
    expect(await posted("bank-c", bankAccounts.fxPosition("CAD"))).toEqual({ currency: "CAD", minor: -41100000000n + 100000n });
    expect(await posted("bank-c", bankAccounts.fxPosition("USD"))).toEqual({ currency: "USD", minor: 30000000000n - 73150n });
    // Each central bank booked its own currency moving between its lines.
    expect((await posted("cad-central-bank", centralBankAccounts.wholesaleLine("bank-c"))).minor).toBe(before.dealerCad + 100000n);

    // Invariant 11 at every party: what each booked is what the dealer signed, at its rate.
    for (const id of ["bank-a", "bank-b", "bank-c"]) {
      const fx = (await of(id).reconciliation())!.checks.filter((c) => c.invariant === 11);
      expect(fx.map((c) => [c.account, c.ok]), id).toContainEqual([`CAD 1000.00 → USD at 0.7315, quote ${quote.id}`, true]);
    }
    expect((await of("bank-c").quotes()).find((q) => q.quote.id === quote.id)?.uetr).toBe(pay.uetr);
  });

  it("settles a quote once, and refuses one that was altered, expired or is not the bank's own", async () => {
    const quote = await of("bank-a").requestQuote("USD", "20000");
    const request = { kind: "pvp", payerBank: "bank-a", payer: "northwind-freight", payeeBank: "bank-b", payee: "mesa-solar", quote } as const;
    const first = await act(of("bank-a"), request, of);
    await until(settled(first.uetr, "bank-a", "bank-b", "bank-c"));
    // The same quote again, under another instruction: the dealer has already given it.
    expect(await refusal(act(of("bank-a"), request, of))).toMatch(/^conflicting-instruction: Quote .* already settles another instruction/);

    // Altered terms: re-priced consistently but not signed by the dealer, or priced off the rate.
    const fresh = await of("bank-a").requestQuote("USD", "30000");
    const flow = (q: typeof fresh): Flow => ({ ...request, quote: q, uetr: crypto.randomUUID(), deadline: q.expiresAt });
    expect(await refusal(of("bank-c").approve(flow({ ...fresh, rate: "0.75", targetAmount: "22500" })))).toMatch(/^invalid-flow: Quote .* is not signed by bank-c/);
    expect(await refusal(of("bank-b").approve(flow({ ...fresh, targetAmount: "21946" })))).toMatch(/^invalid-flow: The quote's target amount 21946 is not 21945/);
    expect(await refusal(act(of("bank-a"), { ...request, quote: { ...fresh, rate: "0.75", targetAmount: "22500" } }, of))).toMatch(
      /^invalid-flow: Quote .* is not the one bank-a was given/,
    );
    // A quote another bank asked for cannot carry this one's payment.
    const bForA = await of("bank-c").quote({ requester: "bank-b", from: "USD", to: "CAD", sourceAmount: "1000" });
    expect(await refusal(act(of("bank-a"), { ...request, quote: bForA }, of))).toMatch(/^invalid-flow: bank-a holds no quote/);

    // Past its expiry, nothing is booked anywhere.
    const testClient = createTestClient({ mode: "anvil", chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() });
    await testClient.increaseTime({ seconds: scenario.fx!.quoteSeconds + 1 });
    await testClient.mine({ blocks: 1 });
    expect(await refusal(act(of("bank-a"), { ...request, quote: fresh }, of))).toMatch(/^invalid-flow: Quote .* expired/);
    for (const id of ["bank-a", "bank-b", "bank-c"]) {
      const open = await of(id).instructions({ limit: 50, statuses: ["ready", "submitted", "awaiting"] });
      expect(open, `${id} has nothing waiting`).toEqual([]);
    }
  });

  it("refuses a payment the dealer cannot cover, before the payer's bank books it", async () => {
    // More USD than the dealer holds in wholesale tokens.
    const quote = await of("bank-a").requestQuote("USD", "300000");
    await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "harbour-foods", amount: "50000000" }, of).then((r) => until(settled(r.uetr, "bank-a")));
    const big = await of("bank-a").requestQuote("USD", "40000000");
    expect(await refusal(act(of("bank-a"), { kind: "pvp", payerBank: "bank-a", payer: "harbour-foods", payeeBank: "bank-b", payee: "riverside-textiles", quote: big }, of))).toMatch(
      /^insufficient-funds: wholesale-reserves\/USD has/,
    );
    const rows = await of("bank-a").instructions({ limit: 50 });
    expect(rows.some((r) => r.flow.kind === "pvp" && r.flow.quote.id === big.id)).toBe(false);
    expect(quote.targetAmount).toBe("219450");
  });

  it("keeps every participant's books balanced and reconciled in each currency apart", async () => {
    const currencies: Record<string, string[]> = {
      "cad-central-bank": ["CAD"],
      "usd-central-bank": ["USD"],
      "bank-a": ["CAD"],
      "bank-b": ["USD"],
      "bank-c": ["CAD", "USD"],
    };
    for (const [id, p] of participants) {
      const reconciliation = await p.reconciliation();
      expect(reconciliation?.ok, `${id} reconciles`).toBe(true);
      expect(await p.breaks(5), `${id} has no breaks`).toEqual([]);
      const totals = (await p.rt.books.trialBalance()).totals;
      expect([...totals.keys()].sort(), `${id} keeps books in`).toEqual(currencies[id]);
      for (const total of totals.values()) expect(total).toBe(0n);
    }
    const dealerChecks = (await of("bank-c").reconciliation())!.checks.filter((c) => c.invariant === 2).map((c) => c.account);
    expect(dealerChecks).toEqual([bankAccounts.wholesaleReserves("CAD"), bankAccounts.wholesaleReserves("USD")]);
  });

  it("keeps quotes the dealer signed before moving to a new key, and pays at quotes it signs with the new one (SPEC.md §15)", async () => {
    const before = (await of("bank-c").keys()).current;
    const rotation = await of("bank-c").proposeChange({ action: "rotate-key" }, "admin-1");
    await until(async () => (await of("bank-c").change(rotation.id))?.status === "applied");
    expect((await of("bank-c").keys()).current).not.toBe(before);
    // Every quote already settled still reconciles: a key the dealer signed with then signed it.
    await until(async () => (await Promise.all(["bank-a", "bank-b", "bank-c"].map(async (id) => (await of(id).reconciliation())?.ok))).every(Boolean));
    for (const id of ["bank-a", "bank-b", "bank-c"]) {
      expect((await of(id).reconciliation())!.checks.filter((c) => c.invariant === 11 && !c.ok), id).toEqual([]);
    }
    // A new quote is signed with the new key, and a payment settles at it.
    const quote = await of("bank-a").requestQuote("USD", "10000");
    const pay = await act(of("bank-a"), { kind: "pvp", payerBank: "bank-a", payer: "harbour-foods", payeeBank: "bank-b", payee: "mesa-solar", quote }, of);
    await until(settled(pay.uetr, "bank-a", "bank-b", "bank-c"));
  });
});
