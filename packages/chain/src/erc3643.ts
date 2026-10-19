import { type Abi, type Address, encodeAbiParameters, type Hex, keccak256, type LocalAccount, toHex } from "viem";

/**
 * ERC-3643 for the bond (SPEC.md §4.2, §15): how identities, claims and a
 * bond's registries are laid out and signed. The contracts are this
 * repository's own implementation of the standard (contracts/src/erc3643).
 */

/** The one claim topic a bond requires: know-your-customer, attested by a trusted issuer. Topic 1, this sandbox's choice. */
export const KYC_TOPIC = 1n;
/** ERC-734 key purposes and type. */
export const KEY_PURPOSE = { management: 1n, action: 2n, claim: 3n } as const;
export const ECDSA_KEY_TYPE = 1n;
/** ERC-735 scheme of a claim signed with ECDSA. */
export const ECDSA_SCHEME = 1n;

/** The identities and claim issuers of a deployment with bonds, and each bond's ERC-3643 contracts. */
export interface IdentityDeployment {
  /** Each participant's own identity, and each customer identity, keyed by participant id or `<bank>/<customer>`. */
  readonly identities: Readonly<Record<string, { readonly address: Address; readonly manager: string }>>;
  /** Each trusted issuer's claim issuer identity, by participant id. */
  readonly claimIssuers: Readonly<Record<string, Address>>;
}

export interface BondRegulation {
  readonly identityRegistry: Address;
  readonly identityStorage: Address;
  readonly claimTopics: Address;
  readonly trustedIssuers: Address;
  readonly compliance: Address;
  readonly settlementOnly: Address;
  /** The bond's own identity. */
  readonly onchainID: Address;
}

/** The message a claim issuer signs: keccak256(abi.encode(identity, topic, data)), as an EIP-191 personal message. */
export function claimHash(identity: Address, topic: bigint, data: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [identity, topic, data]));
}

/** What a KYC claim says: who attested whom. */
export function kycData(issuer: string, subject: string): Hex {
  return toHex(`oul:kyc:${issuer}:${subject}`);
}

/** A claim issuer's signature over a claim about `identity`. */
export function signClaim(account: LocalAccount, identity: Address, topic: bigint, data: Hex): Promise<Hex> {
  return account.signMessage({ message: { raw: claimHash(identity, topic, data) } });
}

/** ERC-735's claim id: keccak256(abi.encode(issuer, topic)). */
export function claimId(issuer: Address, topic: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [issuer, topic]));
}

/** ERC-734's key for an address: keccak256(abi.encode(address)). */
export function addressKey(address: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }], [address]));
}

export type ContractRef = { readonly abi: Abi; readonly bytecode: Hex };
