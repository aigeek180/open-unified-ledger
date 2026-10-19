import { randomUUID } from "node:crypto";
import { allowlistAccounts, claimId, contracts, devKeys, KYC_TOPIC, participantIdHash, ZERO_FEES } from "@oul/chain";
import type { Executor } from "@oul/ledger";
import { registryOperator } from "@oul/scenario";
import { sql } from "drizzle-orm";
import { type Address, createWalletClient, type Hex, http, isAddressEqual, type LocalAccount, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendAudit } from "./audit.ts";
import type { RuntimeContext } from "./context.ts";
import type { CustodyRecovery, HoldingBinding, WalletRecovery } from "./custody.ts";
import { FlowRejected } from "./errors.ts";

/**
 * Administrative changes (SPEC.md §15), which an operator starts and the
 * participant's policy holds for an administrator's approval like a flow:
 * here, moving to a new signing key, and at the registry's operator, binding
 * another participant's new key. Each is recorded with where it stands and
 * what applying it did.
 */

const { ParticipantRegistry } = contracts;

/**
 * At the registry's operator, asked by the participant rotating: admit
 * `newKey` and retire `oldKey` in one registry change, with the old key's
 * consent and the new key's proof over the registry's rotation digest.
 */
export type KeyBinding = {
  readonly action: "bind-address";
  readonly op?: "rotate";
  readonly participant: string;
  readonly oldKey: Address;
  readonly newKey: Address;
  readonly consent: Hex;
  readonly proof: Hex;
};

export type ChangeRequest =
  /** At any participant: move to its next signing key, admitted by the registry's operator. */
  | { readonly action: "rotate-key" }
  /** At the registry's operator, asked by the participant rotating: admit its new key (see KeyBinding). */
  | KeyBinding
  | ClaimRevocation
  | CustodyRecovery
  | HoldingBinding
  | WalletRecovery;

/** At a trusted claim issuer: revoke the KYC claim it signed about a participant's or customer's identity. */
export type ClaimRevocation = { readonly action: "claim"; readonly op: "revoke"; readonly subject: string };

export type ChangeStatus = "proposed" | "approved" | "requested" | "applied" | "failed" | "rejected" | "expired";

export interface ChangeRow {
  readonly id: string;
  readonly action: ChangeRequest["action"];
  readonly request: ChangeRequest;
  readonly initiator: string;
  readonly status: ChangeStatus;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const changeFromRow = (row: Record<string, unknown>): ChangeRow => ({
  id: String(row["id"]),
  action: row["action"] as ChangeRow["action"],
  request: row["request"] as ChangeRequest,
  initiator: String(row["initiator"]),
  status: row["status"] as ChangeStatus,
  result: (row["result"] as Record<string, unknown> | null) ?? null,
  error: row["error"] == null ? null : String(row["error"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
});

export async function insertChange(db: Executor, change: { id?: string; request: ChangeRequest; initiator: string; status: ChangeStatus }): Promise<string> {
  const id = change.id ?? randomUUID();
  await db.execute(sql`
    INSERT INTO changes (id, action, request, initiator, status)
    VALUES (${id}, ${change.request.action}, ${JSON.stringify(change.request)}::jsonb, ${change.initiator}, ${change.status})
  `);
  return id;
}

export async function getChange(db: Executor, id: string): Promise<ChangeRow | undefined> {
  const row = (await db.execute(sql`SELECT * FROM changes WHERE id = ${id}`)).rows[0];
  return row ? changeFromRow(row) : undefined;
}

export async function listChanges(db: Executor, limit: number): Promise<ChangeRow[]> {
  return (await db.execute(sql`SELECT * FROM changes ORDER BY created_at DESC, id DESC LIMIT ${limit}`)).rows.map(changeFromRow);
}

export async function updateChange(
  db: Executor,
  id: string,
  changes: { status?: ChangeStatus; result?: Record<string, unknown>; error?: string | null },
): Promise<void> {
  await db.execute(sql`
    UPDATE changes SET
      status = coalesce(${changes.status ?? null}, status),
      result = coalesce(${changes.result ? JSON.stringify(changes.result) : null}::jsonb, result),
      error = ${changes.error === undefined ? sql`error` : sql`${changes.error}`},
      updated_at = clock_timestamp()
    WHERE id = ${id}
  `);
}

// ---------------------------------------------------------------- signing keys (migrations/0006)

export interface SigningKey {
  readonly generation: number;
  readonly address: Address;
  readonly status: "active" | "pending" | "retired";
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

export async function signingKeys(db: Executor): Promise<SigningKey[]> {
  return (await db.execute(sql`SELECT * FROM signing_keys ORDER BY generation`)).rows.map((r) => ({
    generation: Number(r["generation"]),
    address: String(r["address"]) as Address,
    status: r["status"] as SigningKey["status"],
    createdAt: new Date(String(r["created_at"])),
    retiredAt: r["retired_at"] == null ? null : new Date(String(r["retired_at"])),
  }));
}

/**
 * The account a participant signs with: its configured signer, unless its
 * books say it has since moved to a later generation of the sandbox's
 * derived keys, which a restarted service then derives again. A configured
 * signer that is neither the active key nor the sandbox's first key is
 * refused, rather than signing with a key the registry no longer admits.
 */
export async function activeAccount(db: Executor, participant: string, configured: LocalAccount): Promise<LocalAccount> {
  const keys = await signingKeys(db);
  const active = keys.find((k) => k.status === "active");
  if (!active) {
    await db.execute(sql`INSERT INTO signing_keys (generation, address, status) VALUES (1, ${configured.address.toLowerCase()}, 'active')`);
    return configured;
  }
  if (isAddressEqual(active.address, configured.address)) return configured;
  const first = privateKeyToAccount(devKeys.participantKey(participant, 1));
  if (isAddressEqual(configured.address, first.address)) {
    const derived = privateKeyToAccount(devKeys.participantKey(participant, active.generation));
    if (isAddressEqual(derived.address, active.address)) return derived;
  }
  throw new Error(`${participant} now signs with ${active.address} (key ${active.generation}); its configured signer ${configured.address} was retired`);
}

/** Sign with a new account from now on: approvals, submissions and quotes. */
export function useAccount(rt: RuntimeContext, account: LocalAccount): void {
  rt.account = account;
  rt.wallet = createWalletClient({ account, chain: rt.wallet.chain, transport: http() });
}

// ---------------------------------------------------------------- applying changes

const registryAddress = (rt: RuntimeContext) => rt.deployment.contracts.registry;

/**
 * Start moving to the next signing key: derive it, have the current key
 * consent and the new key prove itself over the registry's rotation digest,
 * keep the new key as pending, and ask the registry's operator to admit it,
 * or, as that operator, admit it here. The runtime keeps signing with the
 * current key until the registry shows the new one admitted.
 */
export async function startRotation(rt: RuntimeContext, changeId: string, requestChange: (registrar: string, request: ChangeRequest) => Promise<void>): Promise<Record<string, unknown>> {
  const keys = await signingKeys(rt.books.database);
  const active = keys.find((k) => k.status === "active")!;
  const pending = keys.find((k) => k.status === "pending");
  const current = privateKeyToAccount(devKeys.participantKey(rt.participant, active.generation));
  if (!isAddressEqual(current.address, rt.account.address)) {
    throw new FlowRejected("invalid-flow", `${rt.participant} signs with a key of its own (${rt.account.address}); the sandbox rotates only its derived keys`);
  }
  const generation = pending?.generation ?? active.generation + 1;
  const next = privateKeyToAccount(devKeys.participantKey(rt.participant, generation));
  const hash = (await rt.client.readContract({
    address: registryAddress(rt),
    abi: ParticipantRegistry.abi,
    functionName: "rotationDigest",
    args: [participantIdHash(rt.participant), current.address, next.address],
  })) as Hex;
  const request: KeyBinding = {
    action: "bind-address",
    participant: rt.participant,
    oldKey: current.address,
    newKey: next.address,
    consent: await current.sign({ hash }),
    proof: await next.sign({ hash }),
  };
  if (!pending) {
    await rt.books.database.execute(sql`INSERT INTO signing_keys (generation, address, status) VALUES (${generation}, ${next.address.toLowerCase()}, 'pending')`);
  }
  const registrar = registryOperator(rt.scenario).id;
  if (registrar === rt.participant) {
    await applyBinding(rt, request);
  } else {
    await requestChange(registrar, request);
  }
  return { generation, oldKey: current.address, newKey: next.address, registrar };
}

/**
 * As the registry's operator: check the participant's consent and proof,
 * allowlist the new key on every validator so it may send transactions, and
 * admit it in one registry change that retires the old key.
 */
export async function applyBinding(rt: RuntimeContext, request: KeyBinding): Promise<Record<string, unknown>> {
  const id = participantIdHash(request.participant);
  const read = (functionName: string, args: readonly unknown[]) =>
    rt.client.readContract({ address: registryAddress(rt), abi: ParticipantRegistry.abi, functionName, args } as never) as Promise<unknown>;
  if ((await read("signerOf", [request.oldKey])) !== id) {
    throw new FlowRejected("invalid-flow", `${request.oldKey} is not a signing key of ${request.participant}`);
  }
  const hash = (await read("rotationDigest", [id, request.oldKey, request.newKey])) as Hex;
  const signedBy = async (signature: Hex) => recoverAddress({ hash, signature }).catch(() => undefined);
  if (!isAddressEqual((await signedBy(request.consent)) ?? "0x0000000000000000000000000000000000000000", request.oldKey)) {
    throw new FlowRejected("invalid-flow", `${request.participant}'s current key did not consent to this rotation`);
  }
  if (!isAddressEqual((await signedBy(request.proof)) ?? "0x0000000000000000000000000000000000000000", request.newKey)) {
    throw new FlowRejected("invalid-flow", `The new key ${request.newKey} did not prove itself`);
  }
  const nodes = await allowlistAccounts(rt.network, [request.newKey]);
  const txHash = await rt.wallet.writeContract({
    address: registryAddress(rt),
    abi: ParticipantRegistry.abi,
    functionName: "rotateKey",
    args: [id, request.oldKey, request.newKey, request.consent, request.proof],
    account: rt.account,
    chain: rt.wallet.chain,
    ...ZERO_FEES,
  });
  const receipt = await rt.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`rotateKey ${txHash} reverted`);
  rt.log(`admitted ${request.newKey} for ${request.participant}, retiring ${request.oldKey}, in block ${receipt.blockNumber}`);
  return { participant: request.participant, oldKey: request.oldKey, newKey: request.newKey, txHash, block: receipt.blockNumber.toString(), allowlistedOn: nodes };
}

/**
 * Move to the pending key once the registry shows it admitted: from then on
 * every approval, submission and quote is signed with it. Returns the new
 * key, if it moved.
 */
export async function completeRotation(rt: RuntimeContext): Promise<SigningKey | undefined> {
  const keys = await signingKeys(rt.books.database);
  const pending = keys.find((k) => k.status === "pending");
  if (!pending) return undefined;
  const signer = (await rt.client.readContract({
    address: registryAddress(rt),
    abi: ParticipantRegistry.abi,
    functionName: "signerOf",
    args: [pending.address],
  })) as Hex;
  if (signer !== participantIdHash(rt.participant)) return undefined;
  const next = privateKeyToAccount(devKeys.participantKey(rt.participant, pending.generation));
  await rt.lock.run(() =>
    rt.books.transaction(async (tx) => {
      await tx.db.execute(sql`UPDATE signing_keys SET status = 'retired', retired_at = clock_timestamp() WHERE status = 'active'`);
      await tx.db.execute(sql`UPDATE signing_keys SET status = 'active' WHERE generation = ${pending.generation}`);
      const requested = (await tx.db.execute(sql`SELECT id FROM changes WHERE action = 'rotate-key' AND status = 'requested'`)).rows;
      for (const row of requested) {
        await updateChange(tx.db, String(row["id"]), { status: "applied" });
        await appendAudit(tx.db, { actor: "runtime", action: "changed", subject: String(row["id"]), detail: { action: "rotate-key", newKey: pending.address, generation: pending.generation } });
      }
    }),
  );
  useAccount(rt, next);
  rt.log(`now signing with ${next.address} (key ${pending.generation})`);
  return { ...pending, status: "active" };
}

/** Whether a move to a new key is under way: the old key may already be retired on chain. */
export async function rotationPending(rt: RuntimeContext): Promise<boolean> {
  return (await signingKeys(rt.books.database)).some((k) => k.status === "pending");
}

// ---------------------------------------------------------------- identity claims (ERC-3643)

/**
 * As a trusted claim issuer: revoke the KYC claim this participant signed
 * about `subject`'s identity. The holder stops verifying in every bond's
 * identity registry, so it receives no more units; what it holds stays.
 */
export async function revokeClaim(rt: RuntimeContext, request: ClaimRevocation): Promise<Record<string, unknown>> {
  const ids = rt.deployment.identity;
  const issuer = ids?.claimIssuers[rt.participant];
  const identity = ids?.identities[request.subject]?.address;
  if (!issuer) throw new FlowRejected("not-a-party", `${rt.participant} issues no claims in ${rt.scenario.id}`);
  if (!identity) throw new FlowRejected("invalid-flow", `"${request.subject}" has no identity`);
  const id = claimId(issuer, KYC_TOPIC);
  const [, , claimIssuerOf] = (await rt.client.readContract({ address: identity, abi: contracts.Identity.abi, functionName: "getClaim", args: [id] })) as readonly [bigint, bigint, Address, Hex, Hex, string];
  if (!isAddressEqual(claimIssuerOf, issuer)) throw new FlowRejected("invalid-flow", `${rt.participant} holds no claim on ${request.subject}'s identity`);
  const txHash = await rt.wallet.writeContract({
    address: issuer,
    abi: contracts.ClaimIssuer.abi,
    functionName: "revokeClaim",
    args: [id, identity],
    account: rt.account,
    chain: rt.wallet.chain,
    ...ZERO_FEES,
  });
  const receipt = await rt.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`revokeClaim ${txHash} reverted`);
  rt.log(`revoked the KYC claim on ${request.subject}'s identity in block ${receipt.blockNumber}`);
  return { subject: request.subject, identity, issuer, topic: KYC_TOPIC.toString(), txHash, block: receipt.blockNumber.toString() };
}
