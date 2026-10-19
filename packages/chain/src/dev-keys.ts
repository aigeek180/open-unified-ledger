import { type Address, type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/**
 * Deterministic keys for the sandbox network.
 *
 * WARNING: these keys are derived from public labels and are therefore
 * public. They exist so that `pnpm network:generate`, the deploy script and
 * the services agree on every address without exchanging key files. Never use
 * them, or this scheme, for anything holding value.
 */
export function devPrivateKey(label: string): Hex {
  return keccak256(toBytes(`open-unified-ledger/dev/${label}`));
}

export const devKeys = {
  /** The key a participant signs transactions and approvals with, until it rotates (SPEC.md §15). */
  participant: (participantId: string) => devPrivateKey(`participant/${participantId}`),
  /** A participant's signing key of a generation: the first is `participant`, each rotation the next. */
  participantKey: (participantId: string, generation: number) =>
    generation === 1 ? devPrivateKey(`participant/${participantId}`) : devPrivateKey(`participant/${participantId}/key-${generation}`),
  /** A validator's node key; its address is the validator address in genesis. */
  validator: (participantId: string) => devPrivateKey(`validator/${participantId}`),
  /**
   * A custodian's omnibus wallet, holding bonds for its clients (SPEC.md §15):
   * it never signs, its bank does; a recovery moves its units to the next.
   */
  custody: (bankId: string, generation: number) => devPrivateKey(`custody/${bankId}/${generation}`),
  /** A customer holding deposit tokens; the bank signs for it, so it never sends a transaction. */
  customer: (bankId: string, customerId: string) => devPrivateKey(`customer/${bankId}/${customerId}`),
};

export function participantAddress(participantId: string): Address {
  return privateKeyToAddress(devKeys.participant(participantId));
}

export function customerAddress(bankId: string, customerId: string): Address {
  return privateKeyToAddress(devKeys.customer(bankId, customerId));
}

/** The on-chain participant id: keccak256 of the scenario's participant id. */
export function participantIdHash(participantId: string): Hex {
  return keccak256(toBytes(participantId));
}

export function custodyAddress(bankId: string, generation = 1): Address {
  return privateKeyToAddress(devKeys.custody(bankId, generation));
}
