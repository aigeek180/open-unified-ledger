import { addressKey, contracts, customerAddress, custodyAddress, devKeys, KEY_PURPOSE, ECDSA_KEY_TYPE, participantIdHash, ZERO_FEES } from "@oul/chain";
import { bankAccounts, couponPayment, couponSchedule, formatMoney, money, principal } from "@oul/domain";
import type { Executor } from "@oul/ledger";
import { registryOperator } from "@oul/scenario";
import { sql } from "drizzle-orm";
import { type Address, getAddress, type Hex, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RuntimeContext } from "./context.ts";
import { FlowRejected } from "./errors.ts";
import { type BondFlow, bondInfo, type CustodyAllocation, type Flow } from "./flows.ts";
import type { ReconciliationCheck } from "./reconciler.ts";

/**
 * Client custody (SPEC.md §15). A custodian bank holds bonds for its clients
 * at an omnibus wallet, a holding address bound to it in the registry and
 * registered with its identity for every bond; it keeps each client's
 * position in its own books, off the balance sheet, at face. The positions
 * must sum, per bond, to what its omnibus wallets hold on chain (invariant
 * 13); what the omnibus receives (a coupon, a redemption) goes to the clients
 * by their positions at the record block, each share rounded once, with the
 * residual shown. A lost omnibus wallet is recovered to a new one (ERC-3643).
 */

const { Bond, IdentityRegistry, Identity, ParticipantRegistry } = contracts;

export interface CustodyWallet {
  readonly address: Address;
  readonly generation: number;
  /** active: holds the clients' units; pending: being recovered to; lost: what it held was recovered. */
  readonly status: "active" | "pending" | "lost";
}

export function custodyClients(rt: RuntimeContext): readonly string[] {
  return rt.scenario.custody.find((c) => c.bank === rt.participant)?.clients ?? [];
}

export const isCustodian = (rt: RuntimeContext) => custodyClients(rt).length > 0;

export async function custodyWallets(db: Executor): Promise<CustodyWallet[]> {
  return (await db.execute(sql`SELECT address, generation, status FROM custody_wallets ORDER BY generation`)).rows.map((r) => ({
    address: getAddress(String(r["address"])),
    generation: Number(r["generation"]),
    status: r["status"] as CustodyWallet["status"],
  }));
}

/** On opening a custodian's books: its first wallet is the one deployed. Returns every wallet it has had. */
export async function ensureCustody(rt: RuntimeContext): Promise<CustodyWallet[]> {
  if (!isCustodian(rt)) return [];
  const wallets = await custodyWallets(rt.books.database);
  if (wallets.length > 0) return wallets;
  const wallet = rt.deployment.custody?.[rt.participant]?.wallet ?? custodyAddress(rt.participant);
  await rt.books.database.execute(sql`INSERT INTO custody_wallets (address, generation, status) VALUES (${wallet.toLowerCase()}, 1, 'active') ON CONFLICT DO NOTHING`);
  return custodyWallets(rt.books.database);
}

/** The wallet a custodian's clients' units go to now. */
export async function currentCustodyWallet(rt: RuntimeContext): Promise<Address> {
  const wallet = (await custodyWallets(rt.books.database)).find((w) => w.status === "active");
  if (!wallet) throw new FlowRejected("not-a-party", `${rt.participant} holds no bonds for clients`);
  return wallet.address;
}

const identityRegistryOf = (rt: RuntimeContext, bond: string) => {
  const registry = rt.deployment.tokens[bond]?.regulation?.identityRegistry;
  if (!registry) throw new FlowRejected("invalid-flow", `${bond} has no identity registry`);
  return registry;
};

/**
 * A custodian takes a client's position in a bond only if the client's own
 * identity verifies in the bond's identity registry, as it would if the
 * client held the bond itself: its KYC claim by its bank, unrevoked.
 */
export async function requireVerifiedClient(rt: RuntimeContext, bond: string, client: string): Promise<void> {
  if (!custodyClients(rt).includes(client)) throw new FlowRejected("unknown-customer", `"${client}" is not a custody client of ${rt.participant}`);
  const verified = (await rt.client.readContract({
    address: identityRegistryOf(rt, bond),
    abi: IdentityRegistry.abi,
    functionName: "isVerified",
    args: [customerAddress(rt.participant, client)],
  })) as boolean;
  if (!verified) throw new FlowRejected("invalid-flow", `${client}'s identity does not verify for ${bond}: ${rt.participant} takes no position for it`);
}

/** A wallet named for a custodian: bound to it in the registry as a holding address. */
export async function requireCustodiansWallet(rt: RuntimeContext, bank: string, wallet: Address): Promise<void> {
  const owner = (await rt.client.readContract({ address: rt.deployment.contracts.registry, abi: ParticipantRegistry.abi, functionName: "participantOf", args: [wallet] })) as Hex;
  if (owner !== participantIdHash(bank)) throw new FlowRejected("invalid-flow", `${wallet} does not hold for ${bank}`);
}

/**
 * A custodian's checks of a flow naming its omnibus: the wallet is its own
 * current one (or, for a coupon or redemption, any it has had), and a client
 * it buys for verifies.
 */
export async function checkCustody(rt: RuntimeContext, flow: Flow): Promise<void> {
  const wallets = (await custodyWallets(rt.books.database)).map((w) => w.address.toLowerCase());
  const current = async (wallet: Address) => {
    if (!isAddressEqual(wallet, await currentCustodyWallet(rt))) throw new FlowRejected("invalid-flow", `${wallet} is not ${rt.participant}'s omnibus wallet`);
  };
  if (flow.kind === "bond-issue") {
    for (const a of flow.allocations.filter((x) => x.bank === rt.participant && x.custody)) {
      await current(a.custody!.wallet);
      await requireVerifiedClient(rt, flow.bond, a.custody!.client);
    }
  } else if (flow.kind === "bond-trade") {
    if (flow.buyer === rt.participant && flow.buyerCustody) {
      await current(flow.buyerCustody.wallet);
      await requireVerifiedClient(rt, flow.bond, flow.buyerCustody.client);
    }
    if (flow.seller === rt.participant && flow.sellerCustody) {
      await current(flow.sellerCustody.wallet);
      if (!custodyClients(rt).includes(flow.sellerCustody.client)) throw new FlowRejected("unknown-customer", `"${flow.sellerCustody.client}" is not a custody client of ${rt.participant}`);
    }
  } else if (flow.kind === "bond-coupon" || flow.kind === "bond-redeem") {
    for (const p of flow.payments.filter((x) => x.bank === rt.participant && x.wallet)) {
      if (!wallets.includes(p.wallet!.toLowerCase())) throw new FlowRejected("invalid-flow", `${p.wallet} is not one of ${rt.participant}'s omnibus wallets`);
    }
  }
}

/** Each client's units of a bond, from its positions as posted up to `block` (at face, so units = face amount / face). */
export async function positionsAt(rt: RuntimeContext, bond: string, block: bigint): Promise<{ client: string; units: bigint }[]> {
  const face = bondInfo(rt.scenario, bond).terms.face.minor;
  // Positions are not mirrored, but every entry that moves one also moves the omnibus holding, so it carries
  // the block it settled in: the trial balance at the block holds them as they stood then.
  const trial = await rt.books.trialBalanceAtBlock(block);
  return custodyClients(rt).map((client) => ({
    client,
    units: (trial.accounts.find((a) => a.code === bankAccounts.custodyPosition(bond, client))?.posted.minor ?? 0n) / face,
  }));
}

/**
 * The clients' shares of what the omnibus received in a coupon or
 * redemption: by their positions at the record block, each coupon share
 * rounded once by the bond's rule, principal at face. The positions must add
 * up to what the omnibus held then, or the custodian refuses to sign.
 */
export async function custodyAllocation(
  rt: RuntimeContext,
  flow: Extract<BondFlow, { kind: "bond-coupon" | "bond-redeem" }>,
): Promise<CustodyAllocation | undefined> {
  const entries = flow.payments.filter((p) => p.bank === rt.participant && p.wallet);
  if (entries.length === 0) return undefined;
  const recordBlock = BigInt(flow.recordBlock);
  const info = bondInfo(rt.scenario, flow.bond);
  const period = couponSchedule(info.terms, info.calendar)[flow.period - 1];
  if (!period) throw new FlowRejected("invalid-flow", `${flow.bond} has no period ${flow.period}`);
  const positions = (await positionsAt(rt, flow.bond, recordBlock)).filter((p) => p.units > 0n);
  const held = entries.reduce((t, p) => t + BigInt(p.units), 0n);
  const recorded = positions.reduce((t, p) => t + p.units, 0n);
  if (held !== recorded) {
    throw new FlowRejected("invalid-flow", `${rt.participant}'s clients held ${recorded} units at block ${recordBlock}, but its omnibus held ${held}`);
  }
  const coupons = couponPayment(info.terms, period, positions.map((p) => ({ holder: p.client, units: p.units })));
  return {
    shares: positions.map((p) => ({
      client: p.client,
      units: p.units,
      amount: coupons.payments.find((x) => x.holder === p.client)?.amount.minor ?? 0n,
      principal: flow.kind === "bond-redeem" ? principal(info.terms, p.units).minor : 0n,
    })),
  };
}

/** Invariant 13 at `block`, per bond: the clients' positions sum to the omnibus wallets' units on chain, at face. */
export async function custodyChecks(rt: RuntimeContext, block: bigint): Promise<ReconciliationCheck[]> {
  if (!isCustodian(rt)) return [];
  const wallets = await custodyWallets(rt.books.database);
  const checks: ReconciliationCheck[] = [];
  for (const spec of rt.scenario.instruments.bonds) {
    const token = rt.deployment.tokens[spec.symbol];
    if (token?.kind !== "bond") continue;
    const face = bondInfo(rt.scenario, spec.symbol).terms.face;
    let units = 0n;
    for (const w of wallets) {
      units += (await rt.client.readContract({ address: token.address, abi: Bond.abi, functionName: "balanceOf", args: [w.address], blockNumber: block })) as bigint;
    }
    const positions = await positionsAt(rt, spec.symbol, block);
    const recorded = positions.reduce((t, p) => t + p.units, 0n);
    const holding = await rt.books.balanceAtBlock(bankAccounts.custodyHolding(spec.symbol), block);
    checks.push({
      invariant: 13,
      account: `custody-positions/${spec.symbol}: ${positions.filter((p) => p.units > 0n).length} clients`,
      books: formatMoney(money(face.currency, recorded * face.minor)),
      chain: formatMoney(money(face.currency, units * face.minor)),
      ok: recorded === units && holding.minor === units * face.minor,
    });
  }
  return checks;
}

// ---------------------------------------------------------------- recovery of a lost omnibus wallet

export type CustodyRecovery = { readonly action: "recovery"; readonly op: "custody-wallet" };
export type HoldingBinding = { readonly action: "bind-address"; readonly op: "holding"; readonly participant: string; readonly wallet: Address };
export type WalletRecovery = {
  readonly action: "recovery";
  readonly op: "recover";
  readonly bond: string;
  readonly holder: string;
  readonly lostWallet: Address;
  readonly newWallet: Address;
};

/**
 * As a custodian whose omnibus wallet was lost: name the next wallet on its
 * identity, so the bond's agent may recover to it (ERC-3643), and ask the
 * registry's operator to bind it to this bank and each bond's agent to
 * recover the lost wallet's units to it. The new wallet is watched at once,
 * so the recovery's movement, between two of its own wallets, books nothing.
 */
export async function startCustodyRecovery(
  rt: RuntimeContext,
  ask: (participant: string, request: HoldingBinding | WalletRecovery) => Promise<void>,
  watch: (wallet: Address) => void,
): Promise<Record<string, unknown>> {
  const wallets = await custodyWallets(rt.books.database);
  const lost = wallets.find((w) => w.status === "active");
  if (!lost) throw new FlowRejected("not-a-party", `${rt.participant} holds no bonds for clients`);
  const pending = wallets.find((w) => w.status === "pending");
  const generation = pending?.generation ?? Math.max(...wallets.map((w) => w.generation)) + 1;
  const next = privateKeyToAccount(devKeys.custody(rt.participant, generation)).address;
  if (!pending) {
    await rt.books.database.execute(sql`INSERT INTO custody_wallets (address, generation, status) VALUES (${next.toLowerCase()}, ${generation}, 'pending')`);
  }
  watch(next);

  const identity = rt.deployment.identity?.identities[rt.participant]?.address;
  if (!identity) throw new FlowRejected("invalid-flow", `${rt.participant} has no identity`);
  const key = addressKey(next);
  const hasKey = (await rt.client.readContract({ address: identity, abi: Identity.abi, functionName: "keyHasPurpose", args: [key, KEY_PURPOSE.management] })) as boolean;
  if (!hasKey) {
    const hash = await rt.wallet.writeContract({
      address: identity,
      abi: Identity.abi,
      functionName: "addKey",
      args: [key, KEY_PURPOSE.management, ECDSA_KEY_TYPE],
      account: rt.account,
      chain: rt.wallet.chain,
      ...ZERO_FEES,
    });
    if ((await rt.client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`addKey ${hash} reverted`);
  }
  const registrar = registryOperator(rt.scenario).id;
  await ask(registrar, { action: "bind-address", op: "holding", participant: rt.participant, wallet: next });
  const bonds = [];
  for (const spec of rt.scenario.instruments.bonds) {
    const token = rt.deployment.tokens[spec.symbol]!.address;
    const held = (await rt.client.readContract({ address: token, abi: Bond.abi, functionName: "balanceOf", args: [lost.address] })) as bigint;
    if (held === 0n) continue;
    await ask(spec.agent, { action: "recovery", op: "recover", bond: spec.symbol, holder: rt.participant, lostWallet: lost.address, newWallet: next });
    bonds.push({ bond: spec.symbol, units: held.toString(), agent: spec.agent });
  }
  return { lostWallet: lost.address, newWallet: next, generation, bonds };
}

/**
 * Finish a recovery once the chain shows it: the new wallet bound to this
 * bank and holding everything the lost one held. From then on the clients'
 * units go to the new wallet. Returns the new wallet, if it finished.
 */
export async function completeCustodyRecovery(rt: RuntimeContext): Promise<Address | undefined> {
  const wallets = await custodyWallets(rt.books.database);
  const pending = wallets.find((w) => w.status === "pending");
  const lost = wallets.find((w) => w.status === "active");
  if (!pending || !lost) return undefined;
  const owner = (await rt.client.readContract({ address: rt.deployment.contracts.registry, abi: ParticipantRegistry.abi, functionName: "participantOf", args: [pending.address] })) as Hex;
  if (owner !== participantIdHash(rt.participant)) return undefined;
  for (const spec of rt.scenario.instruments.bonds) {
    const token = rt.deployment.tokens[spec.symbol]!.address;
    const left = (await rt.client.readContract({ address: token, abi: Bond.abi, functionName: "balanceOf", args: [lost.address] })) as bigint;
    if (left > 0n) return undefined;
  }
  await rt.books.database.transaction(async (tx) => {
    await tx.execute(sql`UPDATE custody_wallets SET status = 'lost' WHERE address = ${lost.address.toLowerCase()}`);
    await tx.execute(sql`UPDATE custody_wallets SET status = 'active' WHERE address = ${pending.address.toLowerCase()}`);
  });
  rt.log(`custody moved from lost wallet ${lost.address} to ${pending.address}`);
  return pending.address;
}

/** As the registry's operator: bind a custodian's new omnibus wallet to it, as a holding address. */
export async function applyHoldingBinding(rt: RuntimeContext, request: HoldingBinding): Promise<Record<string, unknown>> {
  if (!rt.scenario.custody.some((c) => c.bank === request.participant)) throw new FlowRejected("invalid-flow", `${request.participant} holds no bonds for clients`);
  const bound = (await rt.client.readContract({ address: rt.deployment.contracts.registry, abi: ParticipantRegistry.abi, functionName: "participantOf", args: [request.wallet] })) as Hex;
  if (bound === participantIdHash(request.participant)) return { participant: request.participant, wallet: request.wallet, already: true };
  const txHash = await rt.wallet.writeContract({
    address: rt.deployment.contracts.registry,
    abi: ParticipantRegistry.abi,
    functionName: "bindHoldingAddress",
    args: [participantIdHash(request.participant), request.wallet],
    account: rt.account,
    chain: rt.wallet.chain,
    ...ZERO_FEES,
  });
  const receipt = await rt.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`bindHoldingAddress ${txHash} reverted`);
  return { participant: request.participant, wallet: request.wallet, txHash, block: receipt.blockNumber.toString() };
}

/**
 * As a bond's agent: recover a holder's lost wallet to its new one
 * (ERC-3643 `recoveryAddress`), checked first: the lost wallet is the
 * holder's, and the holder's identity names the new wallet.
 */
export async function applyWalletRecovery(rt: RuntimeContext, request: WalletRecovery): Promise<Record<string, unknown>> {
  const info = bondInfo(rt.scenario, request.bond);
  if (info.agent !== rt.participant) throw new FlowRejected("not-a-party", `${rt.participant} is not the agent of ${request.bond}`);
  const owner = (await rt.client.readContract({ address: rt.deployment.contracts.registry, abi: ParticipantRegistry.abi, functionName: "participantOf", args: [request.lostWallet] })) as Hex;
  if (owner !== participantIdHash(request.holder)) throw new FlowRejected("invalid-flow", `${request.lostWallet} does not hold for ${request.holder}`);
  const identity = rt.deployment.identity?.identities[request.holder]?.address;
  if (!identity) throw new FlowRejected("invalid-flow", `${request.holder} has no identity`);
  const token = rt.deployment.tokens[request.bond]!.address;
  const units = (await rt.client.readContract({ address: token, abi: Bond.abi, functionName: "balanceOf", args: [request.lostWallet] })) as bigint;
  if (units === 0n) return { bond: request.bond, lostWallet: request.lostWallet, newWallet: request.newWallet, units: "0", already: true };
  const txHash = await rt.wallet.writeContract({
    address: token,
    abi: Bond.abi,
    functionName: "recoveryAddress",
    args: [request.lostWallet, request.newWallet, identity],
    account: rt.account,
    chain: rt.wallet.chain,
    ...ZERO_FEES,
  });
  const receipt = await rt.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`recoveryAddress ${txHash} reverted`);
  rt.log(`recovered ${units} ${request.bond} from ${request.lostWallet} to ${request.newWallet} for ${request.holder}`);
  return { bond: request.bond, holder: request.holder, lostWallet: request.lostWallet, newWallet: request.newWallet, units: units.toString(), txHash, block: receipt.blockNumber.toString() };
}
