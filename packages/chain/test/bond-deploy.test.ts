import path from "node:path";
import { loadScenario } from "@oul/scenario";
import { createPublicClient, http } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import {
  bondTermsHash,
  contracts,
  dateNumber,
  deployScenario,
  participantIdHash,
  sandboxChain,
  scaledRate,
} from "../src/index.ts";
import { anvilPath, localNetwork, startAnvil, TEST_CHAIN_ID } from "../src/testing.ts";

describe("bond terms encoding", () => {
  it("scales rates exactly and refuses more precision than the contract holds", () => {
    expect(scaledRate("0.0325")).toBe(32500000000000000n);
    expect(scaledRate("0")).toBe(0n);
    expect(scaledRate("0.123456789012345678")).toBe(123456789012345678n);
    expect(() => scaledRate("0.1234567890123456789")).toThrow(RangeError);
    expect(() => scaledRate("3.25%")).toThrow(RangeError);
    expect(dateNumber("2031-11-02")).toBe(20311102);
  });
});

(anvilPath() ? describe : describe.skip)("bond deployment on a local chain", () => {
  const anvil = anvilPath() ? startAnvil() : undefined;
  afterAll(() => anvil?.stop());

  it("deploys each bond from its agent with the scenario's terms", async () => {
    const scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-bond-dvp"));
    const network = localNetwork(scenario, anvil!.rpcUrl);
    const { deployment } = await deployScenario(scenario, network, { force: true, readyAtBlock: 0n });
    const spec = scenario.instruments.bonds[0]!;
    const token = deployment.tokens[spec.symbol]!;
    expect(token).toMatchObject({ kind: "bond", issuer: "bank-c" });

    const client = createPublicClient({ chain: sandboxChain(TEST_CHAIN_ID, anvil!.rpcUrl), transport: http() });
    const read = (functionName: string) =>
      client.readContract({ address: token.address, abi: contracts.Bond.abi, functionName } as never);
    const terms = (await read("terms")) as Record<string, unknown>;
    expect(terms).toMatchObject({
      faceValue: 100000n,
      couponRate: 32500000000000000n,
      frequency: 2,
      dayCount: 0,
      issueDate: 20261102,
      maturityDate: 20311102,
      recordDays: 1,
      termsHash: bondTermsHash("CAD", spec),
    });
    expect(await read("issuer")).toBe(participantIdHash("bank-c"));
    expect(await read("issuerName")).toBe("Issuer");
    expect(await read("decimals")).toBe(0);
    const listed = await client.readContract({
      address: deployment.contracts.registry,
      abi: contracts.ParticipantRegistry.abi,
      functionName: "isListed",
      args: [token.address],
    });
    expect(listed).toBe(true);
  });
});
