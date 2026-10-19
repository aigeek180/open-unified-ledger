import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Deployment, deployScenario, type Network } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil } from "@oul/chain/testing";
import { bankAccounts, centralBankAccounts } from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, Participant, type Peers } from "../src/index.ts";

/**
 * The engine hard-codes no currency or participant count (SPEC.md §1): the
 * yen fixture, a currency with no minor unit, four banks, one of them running
 * no validator, deployed and settled through the same contracts and runtime as
 * the Canadian scenarios, with nothing changed for it.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;

run("another currency, another number of banks, no engine change", () => {
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
  const posted = async (id: string, account: string) => (await of(id).rt.books.balance(account)).posted.minor;

  beforeAll(async () => {
    anvil = startAnvil();
    scenario = await loadScenario(path.resolve(import.meta.dirname, "../../scenario/test/fixtures/jp-interbank"));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-d"]) {
      const schema = `fx_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
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

  it("deploys yen tokens with no decimals, and one per bank for four banks", () => {
    expect(scenario.currencies).toEqual(["JPY"]);
    expect(Object.keys(deployment.tokens).sort()).toEqual(["dJPY-A", "dJPY-B", "dJPY-C", "dJPY-D", "wJPY"]);
  });

  it("funds, tokenizes and pays in yen, through a bank that runs no validator", async () => {
    // Amounts are whole yen: the minor unit is the yen itself.
    const fundA = await act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "JPY", amount: "500000000" }, of);
    const fundD = await act(of("bank-d"), { kind: "fund", bank: "bank-d", currency: "JPY", amount: "100000000" }, of);
    await until(async () => (await status("bank-a", fundA.uetr)) === "settled" && (await status("bank-d", fundD.uetr)) === "settled");

    const tokenize = await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "customer-1", amount: "3000000" }, of);
    await until(async () => (await status("bank-a", tokenize.uetr)) === "settled");

    const pay = await act(of("bank-a"), {
      kind: "interbank",
      payerBank: "bank-a",
      payer: "customer-1",
      payeeBank: "bank-d",
      payee: "customer-2",
      amount: "1234567",
    }, of);
    await until(async () => (await status("bank-a", pay.uetr)) === "settled" && (await status("bank-d", pay.uetr)) === "settled");

    expect(await posted("bank-a", bankAccounts.tokenizedDeposit("customer-1"))).toBe(3000000n - 1234567n);
    expect(await posted("bank-d", bankAccounts.tokenizedDeposit("customer-2"))).toBe(1234567n);
    expect(await posted("central-bank", centralBankAccounts.wholesaleLine("bank-a"))).toBe(500000000n - 1234567n);
    expect(await posted("central-bank", centralBankAccounts.wholesaleLine("bank-d"))).toBe(100000000n + 1234567n);

    for (const [id, p] of participants) {
      expect((await p.reconciliation())?.ok, `${id} reconciles`).toBe(true);
      const totals = (await p.rt.books.trialBalance()).totals;
      expect([...totals.keys()], `${id} keeps yen books only`).toEqual(["JPY"]);
      expect(totals.get("JPY")).toBe(0n);
    }
  });
});
