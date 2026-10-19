/**
 * A settlement instruction: legs that commit together on the shared ledger or
 * not at all (SPEC.md §4.2). Its id is the ISO 20022 UETR of the payment it
 * settles, so a message and its settlement match in either direction, and the
 * settlement engine rejects an id it has already settled.
 *
 * Amounts are in token units (minor units for cash, face units for bonds).
 * Parties are participant or holder ids; the chain package resolves them to
 * addresses.
 */
export type Leg =
  | { readonly kind: "mint"; readonly token: string; readonly to: string; readonly amount: bigint }
  | { readonly kind: "burn"; readonly token: string; readonly from: string; readonly amount: bigint }
  | {
      readonly kind: "transfer";
      readonly token: string;
      readonly from: string;
      readonly to: string;
      readonly amount: bigint;
    };

export interface Instruction {
  readonly id: string;
  readonly legs: readonly Leg[];
}

/** A UETR is a lowercase UUID version 4 (ISO 20022, SWIFT gpi). */
const UETR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUetr(value: string): boolean {
  return UETR_PATTERN.test(value);
}

export class InvalidInstructionError extends Error {
  override readonly name = "InvalidInstructionError";
}

export function assertValidInstruction(instruction: Instruction): void {
  if (!isUetr(instruction.id)) {
    throw new InvalidInstructionError(`Instruction id is not a UETR: "${instruction.id}"`);
  }
  if (instruction.legs.length === 0) {
    throw new InvalidInstructionError("An instruction needs at least one leg");
  }
  for (const [index, leg] of instruction.legs.entries()) {
    if (leg.amount <= 0n) {
      throw new InvalidInstructionError(`Leg ${index} amount must be positive`);
    }
    if (leg.kind === "transfer" && leg.from === leg.to) {
      throw new InvalidInstructionError(`Leg ${index} transfers to its own sender`);
    }
  }
}
