import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { deployScenario } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil } from "@oul/chain/testing";
import { Participant } from "@oul/participant";
import { loadScenario, operatorToken, withoutPolicies } from "@oul/scenario";
import { validate } from "@oul/iso20022";
import { buildApp, HttpPeers } from "@oul/service";
import { centralBankRoutes } from "@oul/service-central-bank";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bankRoutes } from "../src/routes.ts";

/** The bond routes (SPEC.md §4.5) over real HTTP across four services on a local chain. */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const BOND = "BOND-ISSUER-2031";
const run = anvilPath() ? describe : describe.skip;
const PARTICIPANTS = ["central-bank", "bank-a", "bank-b", "bank-c"] as const;

run("bond routes over HTTP", () => {
  let anvil: Anvil;
  const env: NodeJS.ProcessEnv = {};
  const apps: FastifyInstance[] = [];
  const participants: Participant[] = [];
  const schemas: string[] = [];
  const url = (id: string) => env[`OUL_URL_${id.toUpperCase().replaceAll("-", "_")}`]!;

  /** A request to a participant's service; a POST outside `/peer/*` comes from one of its operators, ops-1 unless named. */
  async function call(id: string, method: "GET" | "POST", route: string, body?: unknown, operator: string | null = "ops-1") {
    const auth = method === "POST" && operator && !route.startsWith("/peer/") ? { authorization: `Bearer ${operatorToken(id, operator)}` } : {};
    const response = await fetch(`${url(id)}${route}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  async function settled(uetr: string, ...ids: string[]) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const statuses = await Promise.all(ids.map(async (id) => (await call(id, "GET", `/instructions/${uetr}`)).body.status));
      if (statuses.every((s) => s === "settled")) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Instruction ${uetr} did not settle`);
  }

  beforeAll(async () => {
    anvil = startAnvil();
    // Approval policies are tested over HTTP in http.test.ts; here every flow goes straight on.
    const scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-bond-dvp")));
    const network = localNetwork(scenario, anvil.rpcUrl);
    const { deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n });
    for (const id of PARTICIPANTS) {
      const schema = `bhttp_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
      schemas.push(schema);
      const participant = await Participant.open({
        scenario,
        deployment,
        network,
        participant: id,
        databaseUrl: DATABASE_URL,
        schema,
        peers: new HttpPeers(scenario, env),
        pollIntervalMs: 150,
      });
      participants.push(participant);
      const app = buildApp(participant, id === "central-bank" ? centralBankRoutes : bankRoutes);
      await app.listen({ port: 0, host: "127.0.0.1" });
      env[`OUL_URL_${id.toUpperCase().replaceAll("-", "_")}`] = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      apps.push(app);
      participant.start();
    }
    for (const [bank, amount] of [["bank-a", "70000000"], ["bank-b", "50000000"]] as const) {
      const funded = await call(bank, "POST", "/wholesale/fund", { amount });
      await settled(funded.body.uetr, bank, "central-bank");
    }
  }, 90_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    for (const participant of participants) await participant.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("issues only to buyers that affirmed, then trades only what the buyer affirmed", async () => {
    const issue = { uetr: randomUUID(), price: "1000.00", allocations: [{ bank: "bank-a", units: 60000 }, { bank: "bank-b", units: 40000 }] };
    const refused = await call("bank-c", "POST", `/bonds/${BOND}/issue`, issue);
    expect(refused.status).toBe(403);
    expect(refused.body.type).toBe("urn:oul:problem:not-a-party");

    for (const [bank, units] of [["bank-a", 60000], ["bank-b", 40000]] as const) {
      const affirmed = await call(bank, "POST", `/bonds/${BOND}/affirmations`, { kind: "issue", uetr: issue.uetr, units, price: "1000.00" });
      expect(affirmed.status).toBe(201);
    }
    const issued = await call("bank-c", "POST", `/bonds/${BOND}/issue`, issue);
    expect(issued.status).toBe(202);
    expect(issued.body).toMatchObject({ kind: "bond-issue", amount: "100000000.00", currency: "CAD" });
    await settled(issue.uetr, "bank-a", "bank-b", "bank-c");
    expect((await call("bank-a", "GET", `/bonds/${BOND}`)).body).toMatchObject({ holdingUnits: "60000", outstandingUnits: "100000" });
    expect(await messageNames("bank-a", issue.uetr)).toEqual(["sese.023-receive-bank-a", "sese.025-receive-bank-a"]);
    expect(await messageNames("bank-c", issue.uetr)).toEqual([
      "camt.054-issuer-credit",
      "sese.023-deliver-bank-a",
      "sese.023-deliver-bank-b",
      "sese.025-deliver-bank-a",
      "sese.025-deliver-bank-b",
    ]);

    const trade = { uetr: randomUUID(), buyer: "bank-b", units: "7000", price: "1001.50" };
    expect((await call("bank-a", "POST", `/bonds/${BOND}/trades`, trade)).status).toBe(403);
    await call("bank-b", "POST", `/bonds/${BOND}/affirmations`, { kind: "trade", uetr: trade.uetr, seller: "bank-a", units: 7000, price: "1001.50" });
    const traded = await call("bank-a", "POST", `/bonds/${BOND}/trades`, trade);
    expect(traded.status).toBe(202);
    expect(traded.body.amount).toBe("7010500.00");
    await settled(trade.uetr, "bank-a", "bank-b");
    expect((await call("bank-b", "GET", `/bonds/${BOND}`)).body.holdingUnits).toBe("47000");
    expect(await messageNames("bank-a", trade.uetr)).toEqual(["sese.023-deliver", "sese.025-deliver"]);
    expect(await messageNames("bank-b", trade.uetr)).toEqual(["sese.023-receive", "sese.025-receive"]);
  });

  it("pays the next coupon, which every holder checked, and shows it on the schedule", async () => {
    const coupon = await call("bank-c", "POST", `/bonds/${BOND}/payments/next`, {});
    expect(coupon.status).toBe(202);
    expect(coupon.body).toMatchObject({ kind: "bond-coupon", period: 1, amount: "1611643.83" });
    await settled(coupon.body.uetr, "bank-a", "bank-b", "bank-c");

    const summary = (await call("bank-c", "GET", `/bonds/${BOND}`)).body;
    expect(summary.schedule[0]).toMatchObject({ number: 1, paymentDate: "2027-05-03", paid: { uetr: coupon.body.uetr } });
    expect(summary.schedule[1].paid).toBeNull();
    expect(summary.terms).toMatchObject({ face: "1000.00", couponRate: "0.0325", dayCount: "ACT/365F" });

    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const id of PARTICIPANTS) {
      expect((await call(id, "GET", "/reconciliation")).body.ok, `${id} reconciles`).toBe(true);
    }
  });

  async function messageNames(id: string, uetr: string) {
    const list = (await call(id, "GET", `/instructions/${uetr}/messages`)).body;
    for (const message of list.messages) {
      const body = await (await fetch(`${url(id)}${message.href}`)).text();
      const result = await validate(body, message.version);
      expect(result.errors, `${id} ${message.name}`).toEqual([]);
    }
    return list.messages.map((m: { name: string }) => m.name).sort();
  }

  it("serves the bond's securities and cash messages, valid against the official XSDs", async () => {
    const instructions = async (id: string) => {
      const summary = (await call(id, "GET", `/bonds/${BOND}`)).body;
      return summary.schedule[0].paid.uetr as string;
    };
    const coupon = await instructions("bank-c");
    expect(await messageNames("bank-c", coupon)).toEqual([
      "camt.054-holder-credit-bank-a",
      "camt.054-holder-credit-bank-b",
      "camt.054-issuer-debit",
    ]);
    expect(await messageNames("bank-a", coupon)).toEqual(["camt.054-holder-credit-bank-a"]);
  });

  it("refuses malformed bond requests as problem details", async () => {
    const badPrice = await call("bank-a", "POST", `/bonds/${BOND}/trades`, { uetr: randomUUID(), buyer: "bank-b", units: 1, price: "1001.505" });
    expect(badPrice.status).toBe(400);
    const badUnits = await call("bank-b", "POST", `/bonds/${BOND}/affirmations`, { kind: "trade", uetr: randomUUID(), seller: "bank-a", units: 0, price: "1.00" });
    expect(badUnits.status).toBe(400);
    const unknown = await call("bank-a", "GET", "/bonds/NO-SUCH-BOND");
    expect(unknown.status).toBe(422);
    expect(unknown.body.type).toBe("urn:oul:problem:invalid-flow");
    const notAgent = await call("bank-a", "POST", `/bonds/${BOND}/payments/next`, {});
    expect(notAgent.status).toBe(403);
  });
});
