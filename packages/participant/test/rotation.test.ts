import { randomBytes } from "node:crypto";
import path from "node:path";
import { contracts, type Deployment, deployScenario, devKeys, type Network, participantIdHash } from "@oul/chain";
import { type Anvil, anvilPath, localNetwork, startAnvil } from "@oul/chain/testing";
import { bankAccounts } from "@oul/domain";
import { loadScenario, type Scenario } from "@oul/scenario";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, approveAll, Participant, type Peers, policyViolations } from "../src/index.ts";

/**
 * Key rotation (SPEC.md §15) in the runtime, on a local chain: a bank moves
 * to a new signing key as an administrative change approved under its own
 * policy and admitted by the registry's operator under its policy; from then
 * on it signs with the new key, still holding its balances at its old
 * address, and a restart keeps the new key. The registry's operator rotates
 * its own key the same way, and its roles move with it.
 */

const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";
const run = anvilPath() ? describe : describe.skip;

run("key rotation", () => {
  let anvil: Anvil;
  let scenario: Scenario;
  let network: Network;
  let deployment: Deployment;
  const participants = new Map<string, Participant>();
  const schemas = new Map<string, string>();
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

  async function open(id: string) {
    const schema = schemas.get(id) ?? `rot_${randomBytes(4).toString("hex")}_${id.replaceAll("-", "_")}`;
    schemas.set(id, schema);
    participants.set(id, await Participant.open({ scenario, deployment, network, participant: id, databaseUrl: DATABASE_URL, schema, peers }));
  }

  async function until(done: () => Promise<boolean>, rounds = 25) {
    for (let i = 0; i < rounds; i++) {
      for (const p of participants.values()) await p.tick();
      if (await done()) return;
    }
    throw new Error("Condition not reached");
  }
  const settled = (uetr: string, ...ids: string[]) => async () =>
    (await Promise.all(ids.map(async (id) => (await of(id).instruction(uetr))?.status))).every((s) => s === "settled");
  const signerOf = (address: `0x${string}`) =>
    of("central-bank").rt.client.readContract({ address: deployment.contracts.registry, abi: contracts.ParticipantRegistry.abi, functionName: "signerOf", args: [address] });

  beforeAll(async () => {
    anvil = startAnvil();
    scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank"));
    network = localNetwork(scenario, anvil.rpcUrl);
    ({ deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n }));
    for (const id of ["central-bank", "bank-a", "bank-b"]) await open(id);
    for (const bank of ["bank-a", "bank-b"]) {
      const row = await act(of(bank), { kind: "fund", bank, currency: "CAD", amount: "100000000" }, of);
      await until(settled(row.uetr, bank, "central-bank"));
    }
    const tokens = await act(of("bank-a"), { kind: "tokenize", bank: "bank-a", customer: "northwind-freight", amount: "500000" }, of);
    await until(settled(tokens.uetr, "bank-a"));
  }, 90_000);

  afterAll(async () => {
    for (const p of participants.values()) await p.close();
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas.values()) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    anvil?.stop();
  });

  it("moves a bank to a new key once both its own and the registry operator's policies are met", async () => {
    const oldKey = privateKeyToAccount(devKeys.participantKey("bank-b", 1)).address;
    const newKey = privateKeyToAccount(devKeys.participantKey("bank-b", 2)).address;
    // An operator without the administrator role cannot start it.
    await expect(of("bank-b").proposeChange({ action: "rotate-key" }, "ops-1")).rejects.toMatchObject({ reason: "not-permitted" });

    const change = await of("bank-b").proposeChange({ action: "rotate-key" }, "admin-1");
    expect(change.status).toBe("proposed");
    expect((await of("bank-b").keys()).current).toBe(oldKey);
    await approveAll(of("bank-b"), change.id);
    expect((await of("bank-b").change(change.id))?.status).toBe("requested");
    // The registry's operator holds the binding for its own administrator.
    const [binding] = await of("central-bank").changes();
    expect(binding).toMatchObject({ action: "bind-address", status: "proposed", initiator: "peer:bank-b" });
    expect(await signerOf(newKey)).toBe(`0x${"0".repeat(64)}`);
    await approveAll(of("central-bank"), binding!.id);
    expect((await of("central-bank").change(binding!.id))?.status).toBe("applied");
    expect(await signerOf(newKey)).toBe(participantIdHash("bank-b"));
    expect(await signerOf(oldKey)).toBe(`0x${"0".repeat(64)}`);

    await until(async () => (await of("bank-b").change(change.id))?.status === "applied");
    const keys = await of("bank-b").keys();
    expect(keys.current).toBe(newKey);
    expect(keys.keys.map((k) => [k.generation, k.status])).toEqual([
      [1, "retired"],
      [2, "active"],
    ]);
  });

  it("settles with the new key, holding its balances at the old address", async () => {
    const there = await act(of("bank-a"), { kind: "interbank", payerBank: "bank-a", payer: "northwind-freight", payeeBank: "bank-b", payee: "lakeside-steel", amount: "200000" }, of);
    expect(there.approvals[0]?.signer).toBe(privateKeyToAccount(devKeys.participantKey("bank-b", 2)).address);
    await until(settled(there.uetr, "bank-a", "bank-b"));
    const back = await act(of("bank-b"), { kind: "interbank", payerBank: "bank-b", payer: "lakeside-steel", payeeBank: "bank-a", payee: "harbour-foods", amount: "50000" }, of);
    await until(settled(back.uetr, "bank-b", "bank-a"));
    expect((await of("bank-b").rt.books.balance(bankAccounts.wholesaleReserves("CAD"))).posted.minor).toBe(100000000n + 200000n - 50000n);
    await until(async () => (await of("bank-b").reconciliation())?.ok === true && (await of("central-bank").reconciliation())?.ok === true);
  });

  it("keeps signing with the new key after a restart, and logs the change under its policy", async () => {
    await of("bank-b").close();
    await open("bank-b");
    expect((await of("bank-b").keys()).current).toBe(privateKeyToAccount(devKeys.participantKey("bank-b", 2)).address);
    for (const id of ["bank-b", "central-bank"]) {
      const entries = (await of(id).audit({ limit: 500 })).reverse();
      expect(policyViolations(entries), id).toEqual([]);
      expect(entries.some((e) => e.action === "changed"), id).toBe(true);
    }
  });

  it("rotates the registry operator's own key, and its registrar and minting roles move with it", async () => {
    const change = await of("central-bank").proposeChange({ action: "rotate-key" }, "admin-1");
    await approveAll(of("central-bank"), change.id);
    expect((await of("central-bank").change(change.id))?.status).toBe("applied");
    const newKey = privateKeyToAccount(devKeys.participantKey("central-bank", 2)).address;
    expect((await of("central-bank").keys()).current).toBe(newKey);
    const registrar = await of("central-bank").rt.client.readContract({
      address: deployment.contracts.registry,
      abi: contracts.ParticipantRegistry.abi,
      functionName: "hasRole",
      args: [(await of("central-bank").rt.client.readContract({ address: deployment.contracts.registry, abi: contracts.ParticipantRegistry.abi, functionName: "REGISTRAR_ROLE" })) as `0x${string}`, newKey],
    });
    expect(registrar).toBe(true);
    // It mints with the new key: the wholesale token's issuer is the participant, not an address.
    const row = await act(of("bank-a"), { kind: "fund", bank: "bank-a", currency: "CAD", amount: "100000" }, of);
    await until(settled(row.uetr, "bank-a", "central-bank"));
  });
});
