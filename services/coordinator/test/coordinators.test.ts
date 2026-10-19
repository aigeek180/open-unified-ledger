import path from "node:path";
import { deployInterop, deployScenario, type Network } from "@oul/chain";
import { anvilPath, localNetwork, startAnvil } from "@oul/chain/testing";
import { parseMoney } from "@oul/domain";
import { loadScenario } from "@oul/scenario";
import { afterAll, describe, expect, it } from "vitest";
import { COORDINATOR_NAMES, EXPECTED, FAULT_NAMES } from "../src/coordinators.ts";
import { InteropWorld } from "../src/ledgers.ts";
import { type CaseResult, runCase } from "../src/run.ts";

/**
 * Every coordinator under every fault (SPEC.md §7), on two local chains that
 * produce a block a second, as QBFT does, so timeouts run on the ledgers'
 * own clocks: the one-currency transfer of ca-interbank, and the payment
 * across currencies of ca-us-pvp, split by currency (SPEC.md §13). Each case
 * must end as SPEC.md §7 tabulates. `pnpm interop` runs the same cases on
 * the Besu networks.
 */

const run = anvilPath() ? describe : describe.skip;
const chains: { stop(): void }[] = [];

/**
 * Each scenario on its own pair of chains, with chain ids of their own: the
 * sandbox's keys are the same in every scenario, and a nonce is kept per
 * address and chain id.
 */
async function worldFor(id: string, chainId: number): Promise<InteropWorld> {
  const l1 = startAnvil({ chainId, blockTimeSeconds: 1 });
  const l2 = startAnvil({ chainId: chainId + 1, blockTimeSeconds: 1 });
  chains.push(l1, l2);
  const scenario = await loadScenario(path.resolve(import.meta.dirname, `../../../scenarios/${id}`));
  const network1 = { ...localNetwork(scenario, l1.rpcUrl), chainId };
  const network2: Network = {
    scenario: scenario.id,
    chainId: chainId + 1,
    nodes: scenario.interop!.validators.map((participant) => ({
      participant,
      validator: "0x0000000000000000000000000000000000000000",
      rpcUrl: l2.rpcUrl,
      wsUrl: "",
      enode: "",
    })),
  };
  const { deployment } = await deployScenario(scenario, network1, { force: true });
  const { deployment: interop } = await deployInterop(scenario, { network: network1, deployment }, network2, { force: true });
  return InteropWorld.of({ scenario, deployment, interop, network1, network2 });
}

async function everyCase(world: InteropWorld): Promise<CaseResult[]> {
  const amount = parseMoney(world.currency, "2500.00").minor;
  await world.fund(amount * 20n);
  const cases = COORDINATOR_NAMES.flatMap((c) => FAULT_NAMES.map((f) => [c, f] as const));
  return Promise.all(cases.map(([c, f]) => runCase(world, c, f, { amount })));
}

const table = (results: readonly CaseResult[]) => results.map((r) => `${r.coordinator}/${r.fault}: ${r.outcome}`);
const expected = COORDINATOR_NAMES.flatMap((c) => FAULT_NAMES.map((f) => `${c}/${f}: ${EXPECTED[c][f]}`));

run("interop coordinators on two ledgers", () => {
  afterAll(() => {
    for (const chain of chains) chain.stop();
  });

  it("end every case as SPEC.md §7 says, in one currency and across two", async () => {
    const [one, across] = await Promise.all([worldFor("ca-interbank", 20271).then(everyCase), worldFor("ca-us-pvp", 20273).then(everyCase)]);
    expect(table(one)).toEqual(expected);
    expect(table(across)).toEqual(expected);

    // Across currencies, each part settles one currency's legs, at the dealer's rate.
    const settled = across.find((r) => r.coordinator === "htlc" && r.fault === "none")!;
    expect(settled).toMatchObject({ amount: "2500.00", currency: "CAD", target: { amount: "1828.75", currency: "USD" } });
    expect(settled.story).toBe("Both lock; Bank A claims on ledger 2 with the secret; Bank C claims on ledger 1 with it.");
    // The dealer offline past ledger 1's timeout: USD delivered on ledger 2, CAD released on ledger 1, for good.
    const offline = across.find((r) => r.coordinator === "htlc" && r.fault === "participant-offline")!;
    expect(offline.summary.final).toEqual({ ledger1: "released", ledger2: "settled" });
    expect(offline.summary.disagreesAtEnd).toBe(true);
    // The notary crashed between its commits: CAD delivered on ledger 1, USD released on ledger 2.
    const crashed = across.find((r) => r.coordinator === "notary" && r.fault === "coordinator-crash")!;
    expect(crashed.summary.final).toEqual({ ledger1: "settled", ledger2: "released" });
    // The unified mode settles all four legs at once: no window.
    const unified = across.find((r) => r.coordinator === "unified" && r.fault === "none")!;
    expect(unified.summary.disagreedMs).toBe(0);
  }, 240_000);
});
