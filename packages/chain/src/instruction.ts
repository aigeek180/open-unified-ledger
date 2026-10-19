import { isUetr } from "@oul/domain";
import { type Address, type Hex, hashTypedData, type LocalAccount } from "viem";

/**
 * Settlement instructions as the SettlementEngine sees them, and their
 * EIP-712 approvals. The types and domain here must match
 * contracts/src/SettlementEngine.sol exactly; the network smoke run checks
 * that the engine accepts approvals signed here.
 */

export const LegKind = { mint: 0, burn: 1, transfer: 2 } as const;
export type LegKindName = keyof typeof LegKind;

export interface ChainLeg {
  readonly kind: (typeof LegKind)[LegKindName];
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly amount: bigint;
}

export interface ChainInstruction {
  readonly id: Hex;
  readonly legs: readonly ChainLeg[];
  readonly deadline: bigint;
}

export interface Approval {
  readonly signer: Address;
  readonly signature: Hex;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const instructionTypes = {
  Leg: [
    { name: "kind", type: "uint8" },
    { name: "token", type: "address" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Instruction: [
    { name: "id", type: "bytes32" },
    { name: "legs", type: "Leg[]" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function instructionDomain(chainId: number, engine: Address) {
  return {
    name: "Open Unified Ledger Settlement",
    version: "1",
    chainId,
    verifyingContract: engine,
  } as const;
}

/** A UETR's 16 bytes followed by 16 zero bytes: the engine's instruction id. */
export function uetrToId(uetr: string): Hex {
  if (!isUetr(uetr)) throw new RangeError(`Not a UETR: "${uetr}"`);
  return `0x${uetr.replaceAll("-", "")}${"0".repeat(32)}`;
}

export function idToUetr(id: Hex): string {
  const hex = id.slice(2).toLowerCase();
  if (hex.length !== 64 || !/^0{32}$/.test(hex.slice(32))) {
    throw new RangeError(`Not a UETR-derived instruction id: ${id}`);
  }
  const u = hex.slice(0, 32);
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
}

/** The digest the engine's `digest(instruction)` returns. */
export function instructionDigest(chainId: number, engine: Address, instruction: ChainInstruction): Hex {
  return hashTypedData({
    domain: instructionDomain(chainId, engine),
    types: instructionTypes,
    primaryType: "Instruction",
    message: { ...instruction, legs: [...instruction.legs] },
  });
}

export async function approve(
  account: LocalAccount,
  chainId: number,
  engine: Address,
  instruction: ChainInstruction,
): Promise<Approval> {
  const signature = await account.signTypedData({
    domain: instructionDomain(chainId, engine),
    types: instructionTypes,
    primaryType: "Instruction",
    message: { ...instruction, legs: [...instruction.legs] },
  });
  return { signer: account.address, signature };
}

export const leg = {
  mint: (token: Address, to: Address, amount: bigint): ChainLeg => ({
    kind: LegKind.mint,
    token,
    from: ZERO_ADDRESS,
    to,
    amount,
  }),
  burn: (token: Address, from: Address, amount: bigint): ChainLeg => ({
    kind: LegKind.burn,
    token,
    from,
    to: ZERO_ADDRESS,
    amount,
  }),
  transfer: (token: Address, from: Address, to: Address, amount: bigint): ChainLeg => ({
    kind: LegKind.transfer,
    token,
    from,
    to,
    amount,
  }),
};
