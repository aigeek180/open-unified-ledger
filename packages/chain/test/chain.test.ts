import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadScenario } from "@oul/scenario";
import fc from "fast-check";
import { fromRlp } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildNetworkFiles,
  idToUetr,
  participantAddress,
  participantIdHash,
  qbftExtraData,
  uetrToId,
} from "../src/index.ts";

describe("instruction ids", () => {
  it("round-trips any UETR through the engine's bytes32 id", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const uetr = randomUUID();
        const id = uetrToId(uetr);
        expect(id).toMatch(/^0x[0-9a-f]{32}0{32}$/);
        expect(idToUetr(id)).toBe(uetr);
      }),
      { numRuns: 200 },
    );
  });

  it("refuses ids that did not come from a UETR", () => {
    expect(() => uetrToId("not-a-uetr")).toThrow(RangeError);
    expect(() => idToUetr(`0x${"ab".repeat(32)}`)).toThrow(RangeError);
  });
});

describe("dev keys", () => {
  it("are deterministic, and the on-chain id matches Solidity's keccak256 of the participant id", () => {
    expect(participantAddress("bank-a")).toBe(participantAddress("bank-a"));
    expect(participantAddress("bank-a")).not.toBe(participantAddress("bank-b"));
    // keccak256("bank-a"), as contracts/test/Fixture.sol computes BANK_A (value from `cast keccak`).
    expect(participantIdHash("bank-a")).toBe("0xee8ed86961a76066712cc2d2c7c9faed0a887ade4278e8d358d4044bc91f5834");
  });
});

describe("QBFT genesis", () => {
  it("encodes the validators in Besu's extra data layout", () => {
    const validators = [participantAddress("v1"), participantAddress("v2")];
    const decoded = fromRlp(qbftExtraData(validators)) as unknown[];
    expect(decoded).toHaveLength(5);
    expect(decoded[0]).toBe(`0x${"00".repeat(32)}`);
    expect((decoded[1] as string[]).map((a) => a.toLowerCase())).toEqual(validators.map((a) => a.toLowerCase()));
    expect(qbftExtraData(validators).endsWith("c080c0")).toBe(true);
  });

  it("builds one validator per scenario validator, with every sender allowlisted", async () => {
    const scenario = await loadScenario(path.resolve(import.meta.dirname, "../../../scenarios/ca-interbank"));
    const files = buildNetworkFiles(scenario);
    expect(files.nodes.map((n) => n.participant)).toEqual(["central-bank", "bank-a", "bank-b", "bank-c"]);
    expect(new Set(files.nodes.map((n) => n.rpcPort)).size).toBe(4);
    for (const p of ["central-bank", "bank-a", "bank-b", "bank-c"]) {
      expect(files.permissions).toContain(participantAddress(p).toLowerCase());
    }
    expect(files.compose).toContain("besu-bank-c:");
  });
});
