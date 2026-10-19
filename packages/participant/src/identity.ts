import { claimId, contracts, KYC_TOPIC } from "@oul/chain";
import { type Address, type Hex, isAddressEqual } from "viem";
import type { RuntimeContext } from "./context.ts";

/**
 * What a participant can read of identities for securities (SPEC.md §15,
 * ERC-3643): its own identity and the KYC claims on it, and, as a trusted
 * claim issuer, the claims it signed about others and whether each still
 * holds.
 */

const { Identity, ClaimIssuer } = contracts;

export interface ClaimView {
  readonly subject: string;
  readonly identity: Address;
  readonly issuer: string;
  readonly issuerIdentity: Address;
  readonly topic: string;
  /** Whether the issuer still holds it valid: signed by its key, and not revoked. */
  readonly valid: boolean;
}

export interface IdentityView {
  readonly identity: Address | null;
  /** The claims on it, one per trusted issuer that made one. */
  readonly claims: readonly ClaimView[];
  /** As a trusted issuer: its claim issuer identity and the claims it made about others. */
  readonly claimIssuer: Address | null;
  readonly issued: readonly ClaimView[];
}

async function claimOn(rt: RuntimeContext, subject: string, identity: Address, issuer: string, issuerIdentity: Address): Promise<ClaimView | undefined> {
  const id = claimId(issuerIdentity, KYC_TOPIC);
  const [topic, , by, signature, data] = (await rt.client.readContract({ address: identity, abi: Identity.abi, functionName: "getClaim", args: [id] })) as readonly [
    bigint,
    bigint,
    Address,
    Hex,
    Hex,
    string,
  ];
  if (!isAddressEqual(by, issuerIdentity)) return undefined;
  const valid = (await rt.client.readContract({
    address: issuerIdentity,
    abi: ClaimIssuer.abi,
    functionName: "isClaimValid",
    args: [identity, topic, signature, data],
  })) as boolean;
  return { subject, identity, issuer, issuerIdentity, topic: topic.toString(), valid };
}

export async function identityView(rt: RuntimeContext): Promise<IdentityView> {
  const ids = rt.deployment.identity;
  if (!ids) return { identity: null, claims: [], claimIssuer: null, issued: [] };
  const own = ids.identities[rt.participant]?.address ?? null;
  const claims: ClaimView[] = [];
  if (own) {
    for (const [issuer, issuerIdentity] of Object.entries(ids.claimIssuers)) {
      const claim = await claimOn(rt, rt.participant, own, issuer, issuerIdentity);
      if (claim) claims.push(claim);
    }
  }
  const claimIssuer = ids.claimIssuers[rt.participant] ?? null;
  const issued: ClaimView[] = [];
  if (claimIssuer) {
    for (const [subject, { address }] of Object.entries(ids.identities)) {
      const claim = await claimOn(rt, subject, address, rt.participant, claimIssuer);
      if (claim) issued.push(claim);
    }
  }
  return { identity: own, claims, claimIssuer, issued };
}
