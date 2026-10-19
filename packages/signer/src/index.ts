import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kmsSigner } from "./kms.ts";

export { type KmsApi, type KmsSignerOptions, kmsSigner, publicKeyFromSpki, toEthereumSignature } from "./kms.ts";

/**
 * How a participant signs transactions and settlement approvals. Every
 * implementation is a viem LocalAccount, so the rest of the system cannot
 * tell them apart.
 *   - local: a private key in memory, for the sandbox's derived dev keys;
 *   - kms: a key held in AWS KMS, which never leaves it.
 */
export type SignerConfig =
  | { readonly kind: "local"; readonly privateKey: Hex }
  | { readonly kind: "kms"; readonly keyId: string; readonly region?: string };

export async function createSigner(config: SignerConfig): Promise<LocalAccount> {
  if (config.kind === "local") return privateKeyToAccount(config.privateKey);
  return kmsSigner({ keyId: config.keyId, ...(config.region ? { region: config.region } : {}) });
}
