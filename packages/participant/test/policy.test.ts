import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Deployment, deployScenario, type Network, sandboxChain } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "@oul/chain/testing";
import { bankAccounts } from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createTestClient, http, publicActions } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, approveAll, Participant, type Peers, policyViolations, verifyAudit } from "../src/index.ts";

/**
 * Approval policies and the audit log (SPEC.md §15, invariant 12) in the
 * runtime, on a local chain with ca-interbank's operators and policies: a
 * flow above its policy's threshold waits, booked but unsigned and unsent,
 * until operators other than its initiator approve it; a rejection or an
 * expiry voids it; and every step is in a hash-chained log that shows an
 * edited or deleted entry.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;

run("approval policies and the audit log", () => {
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
  const testClient = () => createTestClient({ mode: "anvil", chain: sandboxChain(TEST_CHAIN_ID, anvil.rpcUrl), transport: http() }).extend(publicActions);

  async function until(done: () => Promise<boolean>, rounds = 20) {
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
  const available = async (id: string, account: string) => (await of(id).rt.books.balance(account)).available.minor;
  const payment = (amount: string) =>
    ({ kind: "interbank", payerBank: "bank-a", payer: "northwind-freight", payeeBank: "bank-b", payee: "lakeside-steel", amount }) as const;

  beforeAll(async () => {
    anvil = startAnvil();
    scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank"));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-b"]) {
      const schema = `pol_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
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

  it("funds above both banks' and the central bank's thresholds only once each policy is met", async () => {
    // 50,000,000.00: over Bank A's 25,000,000.00 for funding, and over the central bank's 40,000,000.00 for minting.
    const row = await of("bank-a").initiate({ kind: "fund", bank: "bank-a", currency: "CAD", amount: "5000000000" }, "ops-1");
    expect(row.status).toBe("proposed");
    expect(await of("central-bank").instruction(row.uetr)).toBeUndefined();
    await of("bank-a").decide(row.uetr, "approver-1", "approve");
    // Bank A's side is released; the central bank's own policy now holds the mint.
    expect(await status("bank-a", row.uetr)).toBe("awaiting");
    expect(await status("central-bank", row.uetr)).toBe("proposed");
    expect((await of("central-bank").proposal(row.uetr))?.initiator).toBe("peer:bank-a");
    await of("central-bank").decide(row.uetr, "approver-2", "approve");
    await until(async () => (await status("bank-a", row.uetr)) === "settled" && (await status("central-bank", row.uetr)) === "settled");
  });

  it("holds a payment above the threshold, unsigned and unsent, until an approver other than its initiator approves", async () => {
    await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "northwind-freight", amount: "10000000" }, of);
    await until(async () => (await available("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))) === 10000000n);

    const row = await of("bank-a").initiate(payment("2500000"), "ops-1");
    expect(row.status).toBe("proposed");
    expect(row.approvals).toEqual([]);
    // Booked, so its funds are held; the payee's bank knows nothing of it yet.
    expect(await available("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).toBe(10000000n - 2500000n);
    expect(await of("bank-b").instruction(row.uetr)).toBeUndefined();
    await until(async () => true);
    expect(await status("bank-a", row.uetr)).toBe("proposed");

    // Its initiator cannot approve it, nor can an operator without the approver role.
    await expect(of("bank-a").decide(row.uetr, "ops-1", "approve")).rejects.toMatchObject({ reason: "not-permitted" });
    await expect(of("bank-a").decide(row.uetr, "ops-2", "approve")).rejects.toMatchObject({ reason: "not-permitted" });
    const approved = await of("bank-a").decide(row.uetr, "approver-1", "approve");
    expect(approved.status).toBe("approved");
    await expect(of("bank-a").decide(row.uetr, "approver-2", "approve")).rejects.toMatchObject({ reason: "conflicting-instruction" });
    expect(await status("bank-a", row.uetr)).toBe("ready");
    expect((await of("bank-a").instruction(row.uetr))?.approvals).toHaveLength(1);
    await until(async () => (await status("bank-a", row.uetr)) === "settled" && (await status("bank-b", row.uetr)) === "settled");

    const steps = (await of("bank-a").audit({ limit: 50, subject: row.uetr })).reverse().map((e) => `${e.action} ${e.actor}`);
    expect(steps).toEqual(["initiated operator:ops-1", "approved operator:approver-1", "released runtime", "submitted runtime", "settled runtime"]);
    expect((await of("bank-b").audit({ limit: 10, subject: row.uetr })).map((e) => e.action)).toEqual(["settled", "signed"]);
  });

  it("starts a flow under the threshold at once, and refuses an operator without the right to start it", async () => {
    const row = await of("bank-a").initiate(payment("100000"), "ops-2");
    expect(row.status).toBe("ready");
    await expect(of("bank-a").initiate(payment("100000"), "admin-1")).rejects.toMatchObject({ reason: "not-permitted" });
    await expect(of("bank-a").initiate(payment("100000"), "nobody")).rejects.toMatchObject({ reason: "unauthenticated" });
    await until(async () => (await status("bank-a", row.uetr)) === "settled");
  });

  it("voids a rejected flow, and one that waited past its deadline", async () => {
    const before = await available("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"));
    const rejected = await of("bank-a").initiate(payment("1500000"), "ops-1");
    await of("bank-a").decide(rejected.uetr, "approver-2", "reject");
    const row = await of("bank-a").instruction(rejected.uetr);
    expect(row).toMatchObject({ status: "rejected", entryStatus: "voided", lastError: "rejected by approver-2" });
    await expect(of("bank-a").decide(rejected.uetr, "approver-1", "approve")).rejects.toMatchObject({ reason: "conflicting-instruction" });

    const waiting = await of("bank-a").initiate(payment("1200000"), "ops-1");
    await testClient().increaseTime({ seconds: 3600 });
    await testClient().mine({ blocks: 1 });
    await until(async () => (await status("bank-a", waiting.uetr)) === "expired");
    expect((await of("bank-a").proposal(waiting.uetr))?.status).toBe("expired");
    expect(await available("bank-a", bankAccounts.tokenizedDeposit("northwind-freight"))).toBe(before);
  });

  it("proves invariant 12 from every participant's audit log, whose chain verifies", async () => {
    for (const [id, p] of participants) {
      const entries = (await p.audit({ limit: 500 })).reverse();
      expect(entries.length, id).toBeGreaterThan(0);
      expect(policyViolations(entries), id).toEqual([]);
      expect(await p.verifyAudit(), id).toMatchObject({ ok: true, entries: entries.length });
    }
    // The approvals scripted runs give are the same decisions an approver makes.
    const row = await of("bank-a").initiate(payment("1100000"), "ops-2");
    await approveAll(of("bank-a"), row.uetr);
    expect((await of("bank-a").proposal(row.uetr))?.decisions.map((d) => d.operator)).toEqual(["approver-1"]);
  });

  it("shows an edited or deleted audit entry at the point the chain breaks", async () => {
    const db = of("bank-b").rt.books.database;
    expect((await verifyAudit(db)).ok).toBe(true);
    // The table refuses edits; someone going around that is still caught by the chain.
    await expect(db.execute(sql`UPDATE audit_log SET actor = 'operator:someone-else' WHERE seq = 2`)).rejects.toThrow();
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`);
    const original = (await db.execute(sql`SELECT actor FROM audit_log WHERE seq = 2`)).rows[0]!["actor"] as string;
    await db.execute(sql`UPDATE audit_log SET actor = 'operator:someone-else' WHERE seq = 2`);
    expect(await verifyAudit(db)).toMatchObject({ ok: false, brokenAt: { seq: "2", reason: "its content does not match its hash" } });
    await db.execute(sql`UPDATE audit_log SET actor = ${original} WHERE seq = 2`);
    expect((await verifyAudit(db)).ok).toBe(true);

    const last = (await db.execute(sql`SELECT max(seq)::text AS seq FROM audit_log`)).rows[0]!["seq"] as string;
    await db.execute(sql`DELETE FROM audit_log WHERE seq = 3`);
    expect(await verifyAudit(db)).toMatchObject({ ok: false, brokenAt: { seq: "4", reason: "entry 3 is missing" } });
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change`);
    expect(BigInt(last)).toBeGreaterThan(3n);
  });
});
