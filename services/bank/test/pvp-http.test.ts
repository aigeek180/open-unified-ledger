import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { deployScenario } from "@oul/chain";
import { anvilPath, localNetwork, startAnvil, type Anvil } from "@oul/chain/testing";
import { Participant } from "@oul/participant";
import { readMessage, validate } from "@oul/iso20022";
import { loadScenario, operatorToken, withoutPolicies } from "@oul/scenario";
import { buildApp, HttpPeers } from "@oul/service";
import { centralBankRoutes } from "@oul/service-central-bank";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bankRoutes } from "../src/routes.ts";

/**
 * A payment across currencies over HTTP (SPEC.md §13): the ca-us-pvp
 * scenario's two central banks and three banks each serving its own API on a
 * local chain. The payer's bank asks the dealer for a quote, then pays at it;
 * the dealer and the payee's bank co-sign over HTTP.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;
const PARTICIPANTS = ["cad-central-bank", "usd-central-bank", "bank-a", "bank-b", "bank-c"] as const;

run("payment versus payment over HTTP", () => {
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
    return { status: response.status, body: (await response.json()) as any };
  }

  let paid: string;

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
    // Approval policies are tested over HTTP in http.test.ts; here every flow goes straight on.
    const scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-us-pvp")));
    const network = localNetwork(scenario, anvil.rpcUrl);
    const { deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n });
    for (const id of PARTICIPANTS) {
      const schema = `pvp_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
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
      const app = buildApp(participant, id.endsWith("central-bank") ? centralBankRoutes : bankRoutes);
      await app.listen({ port: 0, host: "127.0.0.1" });
      env[`OUL_URL_${id.toUpperCase().replaceAll("-", "_")}`] = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      apps.set(id, app);
      participant.start();
    }
  }, 60_000);

  afterAll(async () => {
    for (const app of apps.values()) await app.close();
    for (const participant of participants) await participant.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("funds each bank in its currencies, the dealer in both", async () => {
    const funding = [
      ["bank-a", { amount: "1000000.00" }, "cad-central-bank"],
      ["bank-c", { amount: "500000.00", currency: "CAD" }, "cad-central-bank"],
      ["bank-c", { amount: "400000.00", currency: "USD" }, "usd-central-bank"],
    ] as const;
    for (const [bank, body, cb] of funding) {
      const response = await call(bank, "POST", "/wholesale/fund", body);
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ kind: "fund", amount: body.amount, currency: "currency" in body ? body.currency : "CAD" });
      await settled(response.body.uetr, bank, cb);
    }
    const usd = await call("usd-central-bank", "GET", "/wholesale");
    expect(usd.body).toMatchObject({ currency: "USD", symbol: "wUSD", outstanding: "400000.00" });
    expect(usd.body.lines.map((l: any) => l.bank)).toEqual(["bank-b", "bank-c"]);
    const tokenize = await call("bank-a", "POST", "/customers/northwind-freight/tokenize", { amount: "10000.00" });
    await settled(tokenize.body.uetr, "bank-a");
  });

  it("quotes, then pays at the quote: CAD out of Bank A, USD into Bank B, through the dealer", async () => {
    const quote = await call("bank-a", "POST", "/fx/quotes", { to: "USD", amount: "2500.00" });
    expect(quote.status).toBe(201);
    expect(quote.body).toMatchObject({
      role: "requester",
      dealer: "bank-c",
      requester: "bank-a",
      source: { amount: "2500.00", currency: "CAD" },
      target: { amount: "1828.75", currency: "USD" },
      rate: "0.7315",
      uetr: null,
    });

    const payment = await call("bank-a", "POST", "/payments", {
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "mesa-solar",
      quote: quote.body.id,
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(202);
    expect(payment.body).toMatchObject({ kind: "pvp", amount: "2500.00", currency: "CAD", role: "submitter" });
    await settled(payment.body.uetr, "bank-a", "bank-b", "bank-c");
    paid = payment.body.uetr;

    const detail = (await call("bank-c", "GET", `/instructions/${payment.body.uetr}`)).body;
    expect(detail.approvers).toEqual(["bank-c", "bank-b"]);
    expect(detail.legs.map((l: any) => [l.kind, l.token, l.from?.ref ?? null, l.to?.ref ?? null, l.amount, l.currency])).toEqual([
      ["burn", "dCAD-A", "bank-a/northwind-freight", null, "2500.00", "CAD"],
      ["transfer", "wCAD", "bank-a", "bank-c", "2500.00", "CAD"],
      ["transfer", "wUSD", "bank-c", "bank-b", "1828.75", "USD"],
      ["mint", "dUSD-B", null, "bank-b/mesa-solar", "1828.75", "USD"],
    ]);
    expect(detail.journal.lines.map((l: any) => `${l.side} ${l.account} ${l.amount} ${l.currency}`)).toEqual([
      "debit wholesale-reserves/CAD 2500.00 CAD",
      "credit fx-position/CAD 2500.00 CAD",
      "debit fx-position/USD 1828.75 USD",
      "credit wholesale-reserves/USD 1828.75 USD",
    ]);
    const payee = (await call("bank-b", "GET", "/customers/mesa-solar")).body;
    expect(payee).toMatchObject({ currency: "USD", tokenized: { posted: "1828.75" } });

    const dealerQuotes = (await call("bank-c", "GET", "/fx/quotes")).body.quotes;
    expect(dealerQuotes[0]).toMatchObject({ id: quote.body.id, role: "dealer", uetr: payment.body.uetr });

    // Every party's books reconcile, invariant 11 among them.
    for (const id of ["bank-a", "bank-b", "bank-c"]) {
      const deadline = Date.now() + 10_000;
      let reconciliation: any;
      do {
        reconciliation = (await call(id, "GET", "/reconciliation")).body;
      } while (!reconciliation.checks.some((c: any) => c.invariant === 11) && Date.now() < deadline);
      expect(reconciliation.ok, id).toBe(true);
      expect(reconciliation.checks.filter((c: any) => c.invariant === 11).map((c: any) => c.ok)).toEqual([true]);
    }
  });

  it("serves each party the ISO 20022 messages that concern it, all valid and named by one UETR", async () => {
    const expected: Record<string, string[]> = {
      "bank-a": ["pacs.008", "pacs.009-cover-CAD", "pacs.002", "camt.054-payer-debit"],
      "bank-b": ["pacs.008", "pacs.009-cover-USD", "pacs.002", "camt.054-payee-credit"],
      "bank-c": ["pacs.009-cover-CAD", "pacs.009-cover-USD"],
    };
    for (const [id, names] of Object.entries(expected)) {
      const list = (await call(id, "GET", `/instructions/${paid}/messages`)).body.messages;
      expect(list.map((m: any) => m.name), id).toEqual(names);
      for (const m of list) {
        const xml = await (await fetch(`${url(id)}${m.href}`)).text();
        const result = await validate(xml, m.version);
        expect(result.errors, `${id} ${m.name}`).toEqual([]);
        expect(readMessage(xml).uetrs).toEqual([paid]);
        if (m.name === "pacs.008") {
          expect(xml).toContain('<IntrBkSttlmAmt Ccy="USD">1828.75</IntrBkSttlmAmt>');
          expect(xml).toContain('<InstdAmt Ccy="CAD">2500.00</InstdAmt>');
          expect(xml).toContain("<XchgRate>0.7315</XchgRate>");
        }
        if (m.name === "pacs.002") expect(xml).toContain("<TxSts>ACSC</TxSts>");
      }
    }
    // A statement in each currency: the payee's tokenized deposit in USD.
    const statement = await (await fetch(`${url("bank-b")}/customers/mesa-solar/statement`)).text();
    expect((await validate(statement, "camt.053.001.08")).errors).toEqual([]);
    expect(statement).toContain('<Amt Ccy="USD">1828.75</Amt>');
  });

  it("refuses a quote it has no rate for, and a payment at a quote it was never given", async () => {
    const noRate = await call("bank-a", "POST", "/fx/quotes", { to: "EUR", amount: "10.00" });
    expect(noRate.status).toBe(422);
    expect(noRate.body).toMatchObject({ type: "urn:oul:problem:invalid-flow", detail: "bank-c: No rate is quoted from CAD to EUR" });

    const unknown = await call("bank-a", "POST", "/payments", {
      payer: "northwind-freight",
      payeeBank: "bank-b",
      payee: "mesa-solar",
      quote: "00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.detail).toBe("bank-a holds no quote 00000000-0000-4000-8000-000000000000");

    const sameCurrencyAcross = await call("bank-a", "POST", "/payments", { payer: "northwind-freight", payeeBank: "bank-b", payee: "mesa-solar", amount: "1.00" });
    expect(sameCurrencyAcross.status).toBe(422);
    expect(sameCurrencyAcross.body.detail).toMatch(/a payment between currencies settles through a dealer/);
  });
});
