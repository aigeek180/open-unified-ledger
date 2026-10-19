import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { deployScenario } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil } from "@oul/chain/testing";
import { validate } from "@oul/iso20022";
import { Participant } from "@oul/participant";
import { loadScenario, operatorToken, withoutPolicies } from "@oul/scenario";
import { buildApp, HttpPeers } from "@oul/service";
import { centralBankRoutes } from "@oul/service-central-bank";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bankRoutes } from "../src/routes.ts";

/**
 * The repo routes (SPEC.md §4.5, §5.7–§5.10) over real HTTP across four
 * services on a local chain: a repo affirmed and opened, a margin called and
 * delivered across services, its collateral substituted, and closed; every
 * message valid against the official XSDs.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const LONG = "BOND-ISSUER-2031";
const SHORT = "BOND-ISSUER-2029";
const run = anvilPath() ? describe : describe.skip;
const PARTICIPANTS = ["central-bank", "bank-a", "bank-b", "bank-c"] as const;

run("repo routes over HTTP", () => {
  let anvil: Anvil;
  const env: NodeJS.ProcessEnv = {};
  const apps: FastifyInstance[] = [];
  const participants: Participant[] = [];
  const schemas: string[] = [];
  const url = (id: string) => env[`OUL_URL_${id.toUpperCase().replaceAll("-", "_")}`]!;

  /** A request to a participant's service; a POST outside `/peer/*` comes from one of its operators, ops-1. */
  async function call(id: string, method: "GET" | "POST", route: string, body?: unknown) {
    const auth = method === "POST" && !route.startsWith("/peer/") ? { authorization: `Bearer ${operatorToken(id, "ops-1")}` } : {};
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
    // Approval policies are tested over HTTP in http.test.ts and on Besu by pnpm e2e ca-repo.
    const scenario = withoutPolicies(await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-repo")));
    const network = localNetwork(scenario, anvil.rpcUrl);
    const { deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n });
    for (const id of PARTICIPANTS) {
      const schema = `rhttp_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
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
    for (const [bank, amount] of [["bank-a", "40000000"], ["bank-b", "45000000"]] as const) {
      const funded = await call(bank, "POST", "/wholesale/fund", { amount });
      await settled(funded.body.uetr, bank, "central-bank");
    }
    // Bank B buys 20,000 units of each bond at issue.
    for (const bond of [LONG, SHORT]) {
      const uetr = randomUUID();
      await call("bank-b", "POST", `/bonds/${bond}/affirmations`, { kind: "issue", uetr, units: 20000, price: "1000.00" });
      const issued = await call("bank-c", "POST", `/bonds/${bond}/issue`, { uetr, price: "1000.00", allocations: [{ bank: "bank-b", units: 20000 }] });
      expect(issued.status).toBe(202);
      await settled(uetr, "bank-b", "bank-c");
    }
  }, 120_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    for (const participant of participants) await participant.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("opens, margins, substitutes and closes a repo across the banks' services", async () => {
    const repo = randomUUID();
    const terms = { uetr: repo, bond: LONG, units: 10300, mark: "1000.00", cash: "10000000.00", rate: "0.0275", haircut: "0.02", startDate: "2027-04-26", endDate: "2027-05-10" };
    const early = await call("bank-b", "POST", "/repos", { ...terms, lender: "bank-a" });
    expect(early.status).toBe(403);
    expect(early.body.type).toBe("urn:oul:problem:not-a-party");
    expect((await call("bank-a", "POST", "/repos/affirmations", { ...terms, borrower: "bank-b" })).status).toBe(201);
    const opened = await call("bank-b", "POST", "/repos", { ...terms, uetr: repo, lender: "bank-a" });
    expect(opened.status).toBe(202);
    expect(opened.body).toMatchObject({ kind: "repo-open", amount: "10000000.00", currency: "CAD", lender: "bank-a", borrower: "bank-b" });
    await settled(repo, "bank-a", "bank-b");
    expect((await call("bank-a", "GET", `/repos/${repo}`)).body).toMatchObject({ role: "lender", status: "open", collateral: [{ bond: LONG, units: "10300" }], repurchasePrice: "10010547.95" });
    expect((await call("bank-b", "GET", "/repos")).body.repos).toHaveLength(1);

    // The borrower cannot call a shortfall; the lender can, and the borrower delivers on its call, across services.
    const marks = { marks: [{ bond: LONG, price: "990.00" }], asOf: "2027-05-03", bond: LONG };
    expect((await call("bank-b", "POST", `/repos/${repo}/margin-calls`, marks)).status).toBe(422);
    const called = await call("bank-a", "POST", `/repos/${repo}/margin-calls`, marks);
    expect(called.status).toBe(201);
    expect(called.body).toMatchObject({ direction: "deliver", units: "13", status: "affirmed" });
    const due = (await call("bank-b", "GET", `/repos/${repo}`)).body.calls;
    expect(due).toEqual([expect.objectContaining({ uetr: called.body.call, caller: "bank-a", status: "open" })]);
    const delivered = await call("bank-b", "POST", `/repos/${repo}/margin`, { call: called.body.call });
    expect(delivered.status).toBe(202);
    await settled(called.body.call, "bank-a", "bank-b");

    const swap = { uetr: randomUUID(), outgoing: { bond: LONG, units: 10313 }, incoming: SHORT, marks: [{ bond: LONG, price: "1001.50" }, { bond: SHORT, price: "987.25" }], asOf: "2027-05-05" };
    const affirmed = await call("bank-a", "POST", `/repos/${repo}/substitutions/affirmations`, swap);
    expect(affirmed.body.incoming).toEqual({ bond: SHORT, units: "10462" });
    expect((await call("bank-b", "POST", `/repos/${repo}/substitutions`, swap)).status).toBe(202);
    await settled(swap.uetr, "bank-a", "bank-b");

    const closed = await call("bank-b", "POST", `/repos/${repo}/close`, {});
    expect(closed.status).toBe(202);
    expect(closed.body).toMatchObject({ kind: "repo-close", amount: "10010547.95", interest: "1054795" });
    await settled(closed.body.uetr, "bank-a", "bank-b");
    for (const bank of ["bank-a", "bank-b"]) {
      expect((await call(bank, "GET", `/repos/${repo}`)).body).toMatchObject({ status: "closed", collateral: [] });
      const reconciliation = (await call(bank, "GET", "/reconciliation")).body;
      expect(reconciliation.checks.filter((c: { invariant: number; ok: boolean }) => c.invariant === 14 && !c.ok)).toEqual([]);
    }

    // Every message each side serves for each flow is valid against its official XSD.
    for (const uetr of [repo, called.body.call, swap.uetr, closed.body.uetr]) {
      for (const bank of ["bank-a", "bank-b"]) {
        const list = (await call(bank, "GET", `/instructions/${uetr}/messages`)).body.messages as { href: string; version: string; name: string }[];
        expect(list.length).toBeGreaterThan(0);
        for (const message of list) {
          const xml = await (await fetch(`${url(bank)}${message.href}`)).text();
          expect((await validate(xml, message.version as Parameters<typeof validate>[1])).errors, `${bank} ${message.name}`).toEqual([]);
        }
      }
    }
  }, 120_000);
});
