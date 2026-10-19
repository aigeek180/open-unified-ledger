import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { deployScenario } from "@oul/chain";
import { anvilPath, localNetwork, startAnvil, type Anvil } from "@oul/chain/testing";
import { Participant } from "@oul/participant";
import { loadScenario, operatorToken } from "@oul/scenario";
import { readMessage, validate } from "@oul/iso20022";
import { buildApp, HttpPeers } from "@oul/service";
import { centralBankRoutes } from "@oul/service-central-bank";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bankRoutes } from "../src/routes.ts";

/**
 * The bank and central bank services over real HTTP, on a local chain: each
 * participant's app listens on its own port, reaches the others through
 * HttpPeers, and runs its runtime loops as it would in production.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;
const PARTICIPANTS = ["central-bank", "bank-a", "bank-b"] as const;

run("bank and central bank services over HTTP", () => {
  let anvil: Anvil;
  const env: NodeJS.ProcessEnv = {};
  const apps = new Map<string, FastifyInstance>();
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
    return { status: response.status, type: response.headers.get("content-type"), body: (await response.json()) as any };
  }

  async function settled(uetr: string, ...ids: string[]) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const statuses = await Promise.all(ids.map(async (id) => (await call(id, "GET", `/instructions/${uetr}`)).body.status));
      if (statuses.every((s) => s === "settled")) return;
      if (statuses.some((s) => s === "failed" || s === "expired")) throw new Error(`Instruction ${uetr}: ${statuses}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Instruction ${uetr} did not settle`);
  }

  beforeAll(async () => {
    anvil = startAnvil();
    const scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank"));
    const network = localNetwork(scenario, anvil.rpcUrl);
    const { deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n });
    for (const id of PARTICIPANTS) {
      const schema = `http_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
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
      apps.set(id, app);
      participant.start();
    }
    // Bank C runs no service here: a port nothing listens on.
    env["OUL_URL_BANK_C"] = "http://127.0.0.1:9";
  }, 60_000);

  afterAll(async () => {
    for (const app of apps.values()) await app.close();
    for (const participant of participants) await participant.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("funds both banks through the central bank", async () => {
    for (const bank of ["bank-a", "bank-b"]) {
      const response = await call(bank, "POST", "/wholesale/fund", { amount: "1000000.00" });
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ kind: "fund", amount: "1000000.00", currency: "CAD", status: "awaiting" });
      await settled(response.body.uetr, bank, "central-bank");
    }
    const wholesale = await call("central-bank", "GET", "/wholesale");
    expect(wholesale.body.outstanding).toBe("2000000.00");
    expect((await call("central-bank", "GET", "/rtgs")).body.settlementAccounts).toContainEqual({
      bank: "bank-a",
      posted: "499000000.00",
      available: "499000000.00",
    });
  });

  it("tokenizes a deposit and pays a customer of another bank", async () => {
    const tokenize = await call("bank-a", "POST", "/customers/northwind-freight/tokenize", { amount: "5000.00" });
    expect(tokenize.status).toBe(202);
    await settled(tokenize.body.uetr, "bank-a");

    const payment = await call("bank-a", "POST", "/payments", {
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "lakeside-steel",
      amount: "2500.00",
    });
    expect(payment.status).toBe(202);
    await settled(payment.body.uetr, "bank-a", "bank-b");

    expect((await call("bank-a", "GET", "/customers/northwind-freight")).body.tokenized.posted).toBe("2500.00");
    expect((await call("bank-b", "GET", "/customers/lakeside-steel")).body.tokenized.posted).toBe("2500.00");
    expect((await call("bank-b", "GET", `/instructions/${payment.body.uetr}`)).body.role).toBe("approver");

    // Let the central bank's listener catch the block, then every participant reconciles.
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (const id of PARTICIPANTS) {
      const reconciliation = await call(id, "GET", "/reconciliation");
      expect(reconciliation.body.ok, `${id} reconciles`).toBe(true);
    }
  });

  async function xml(id: string, route: string) {
    const response = await fetch(`${url(id)}${route}`);
    expect(response.headers.get("content-type")).toContain("application/xml");
    return response.text();
  }

  /** Every message the participant serves for the instruction, each valid against its official XSD. */
  async function validMessages(id: string, uetr: string) {
    const list = (await call(id, "GET", `/instructions/${uetr}/messages`)).body;
    const out: Record<string, string> = {};
    for (const message of list.messages) {
      const body = await xml(id, message.href);
      const result = await validate(body, message.version);
      expect(result.errors, `${id} ${message.name}`).toEqual([]);
      expect(readMessage(body).uetrs, `${id} ${message.name} names the instruction`).toContain(uetr);
      out[message.name] = body;
    }
    return out;
  }

  it("serves each payment's ISO 20022 messages, valid against the official XSDs, and statements", async () => {
    const payment = await call("bank-a", "POST", "/payments", {
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "lakeside-steel",
      amount: "100.00",
    });
    await settled(payment.body.uetr, "bank-a", "bank-b");

    const payer = await validMessages("bank-a", payment.body.uetr);
    expect(Object.keys(payer).sort()).toEqual(["camt.054-payer-debit", "pacs.002", "pacs.008", "pacs.009-cover"]);
    expect(payer["pacs.002"]).toContain("<TxSts>ACSC</TxSts>");
    expect(payer["pacs.008"]).toContain(`<UETR>${payment.body.uetr}</UETR>`);
    const payee = await validMessages("bank-b", payment.body.uetr);
    expect(Object.keys(payee)).toContain("camt.054-payee-credit");

    const statement = await xml("bank-a", "/customers/northwind-freight/statement?account=tokenized");
    expect((await validate(statement, "camt.053.001.08")).valid).toBe(true);
    // Opening plus credits minus debits is the closing balance.
    const balance = (code: string) => statement.match(new RegExp(`<Cd>${code}</Cd>[\\s\\S]*?<Amt Ccy="CAD">([\\d.]+)</Amt>`))?.[1];
    const sum = (tag: string) => statement.match(new RegExp(`<${tag}>[\\s\\S]*?<Sum>([\\d.]+)</Sum>`))?.[1];
    const cents = (v: string | undefined) => BigInt((v ?? "0").replace(".", ""));
    expect(cents(balance("OPBD")) + cents(sum("TtlCdtNtries")) - cents(sum("TtlDbtNtries"))).toBe(cents(balance("CLBD")));
    expect(balance("CLBD")).toBe("2400.00");

    const wholesale = await xml("central-bank", "/banks/bank-a/statement?account=wholesale");
    expect((await validate(wholesale, "camt.053.001.08")).valid).toBe(true);
    expect((await call("central-bank", "GET", "/banks/nobody/statement")).status).toBe(404);
    expect((await call("bank-a", "GET", `/instructions/${payment.body.uetr}/messages/pacs.099`)).status).toBe(404);
  });

  it("answers retries with the same instruction and refuses a reused UETR", async () => {
    const uetr = randomUUID();
    const first = await call("bank-a", "POST", "/customers/harbour-foods/tokenize", { amount: "1.00", uetr });
    const again = await call("bank-a", "POST", "/customers/harbour-foods/tokenize", { amount: "1.00", uetr });
    expect(again.body.uetr).toBe(first.body.uetr);
    const reused = await call("bank-a", "POST", "/customers/harbour-foods/tokenize", { amount: "2.00", uetr });
    expect(reused.status).toBe(409);
    expect(reused.body.type).toBe("urn:oul:problem:conflicting-instruction");
  });

  it("waits for an approver before it signs or sends a payment above its policy's threshold, and logs every step", async () => {
    const tokenize = await call("bank-a", "POST", "/customers/harbour-foods/tokenize", { amount: "50000.00" });
    await settled(tokenize.body.uetr, "bank-a");
    const payment = await call("bank-a", "POST", "/payments", { payer: "harbour-foods", payeeBank: "bank-b", payee: "lakeside-steel", amount: "20000.00" });
    expect(payment.status).toBe(202);
    expect(payment.body).toMatchObject({ status: "proposed", entry: "pending" });
    const waiting = (await call("bank-a", "GET", "/proposals?status=open")).body.proposals;
    expect(waiting).toContainEqual(expect.objectContaining({ subject: payment.body.uetr, initiator: "operator:ops-1", required: 1, roles: ["approver"] }));

    const decide = (operator: string | null, decision = "approve") =>
      call("bank-a", "POST", `/proposals/${payment.body.uetr}/decisions`, { decision }, operator);
    expect((await decide(null)).status).toBe(401);
    expect((await decide("ops-1")).body).toMatchObject({ status: 403, type: "urn:oul:problem:not-permitted" });
    expect((await decide("approver-1")).body).toMatchObject({ status: "approved", decisions: [expect.objectContaining({ operator: "approver-1" })] });
    await settled(payment.body.uetr, "bank-a", "bank-b");
    expect((await call("bank-a", "GET", `/instructions/${payment.body.uetr}`)).body.policy).toMatchObject({ status: "approved", required: 1 });

    const audit = (await call("bank-a", "GET", `/audit?subject=${payment.body.uetr}`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(["settled", "submitted", "released", "approved", "initiated"]);
    expect((await call("bank-a", "GET", "/audit/verify")).body).toMatchObject({ ok: true });
    expect((await call("bank-a", "GET", "/operators")).body.operators).toContainEqual({ id: "approver-1", name: "Approver 1", roles: ["approver"] });

    // An operator must start every flow, and only one whose role allows it.
    expect((await call("bank-a", "POST", "/customers/harbour-foods/tokenize", { amount: "1.00" }, null)).body).toMatchObject({ status: 401, type: "urn:oul:problem:unauthenticated" });
    expect((await call("bank-a", "POST", "/customers/harbour-foods/tokenize", { amount: "1.00" }, "admin-1")).status).toBe(403);
  });

  it("explains every refusal as problem details", async () => {
    const tooPrecise = await call("bank-a", "POST", "/wholesale/fund", { amount: "10.001" });
    expect(tooPrecise.status).toBe(400);
    expect(tooPrecise.type).toContain("application/problem+json");
    expect(tooPrecise.body.type).toBe("urn:oul:problem:validation");

    const notHeld = await call("bank-a", "POST", "/wholesale/fund", { amount: "10.00", currency: "USD" });
    expect(notHeld.status).toBe(422);
    expect(notHeld.body).toMatchObject({ type: "urn:oul:problem:invalid-flow", detail: "bank-a holds no reserves in USD" });

    const tooMuch = await call("bank-a", "POST", "/payments", {
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "lakeside-steel",
      amount: "2500.01",
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body).toMatchObject({ type: "urn:oul:problem:insufficient-funds", status: 422 });

    const stranger = await call("bank-a", "POST", "/customers/nobody/tokenize", { amount: "1.00" });
    expect(stranger.status).toBe(404);
    expect(stranger.body.type).toBe("urn:oul:problem:unknown-customer");

    const unreachable = await call("bank-a", "POST", "/payments", {
      payer: "northwind-freight",
      payeeBank: "bank-c",
      payee: "coastal-shipping",
      amount: "1.00",
    });
    expect(unreachable.status).toBe(503);
    expect(unreachable.body.type).toBe("urn:oul:problem:peer-unavailable");

    const notMine = await call("bank-b", "POST", "/peer/approvals", {
      kind: "tokenize",
      uetr: randomUUID(),
      deadline: Math.floor(Date.now() / 1000) + 600,
      bank: "bank-a",
      customer: "northwind-freight",
      amount: "100",
    });
    expect(notMine.status).toBe(403);
    expect(notMine.body.type).toBe("urn:oul:problem:not-a-party");

    expect((await call("bank-a", "GET", `/instructions/${randomUUID()}`)).status).toBe(404);
  });
});
