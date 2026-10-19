import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Address, type Chain, defineChain } from "viem";

/**
 * The sandbox network as `pnpm network:generate` wrote it
 * (infra/besu/generated/network.json): chain id and each validator's node.
 */
export interface NetworkNode {
  readonly participant: string;
  readonly validator: Address;
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly enode: string;
}

export interface Network {
  readonly scenario: string;
  readonly chainId: number;
  readonly nodes: readonly NetworkNode[];
}

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Which sandbox this is: 0 by default, or OUL_SLOT=1 to 9 for another beside
 * it, from another checkout, with its own chain ids, subnets, node and
 * service ports and Compose projects, so the two share nothing but Postgres
 * (where each deployment's books have schemas of their own).
 */
export function sandboxSlot(env: NodeJS.ProcessEnv = process.env): number {
  const value = env["OUL_SLOT"] ?? "0";
  if (!/^\d$/.test(value)) throw new RangeError(`OUL_SLOT is a sandbox number from 0 to 9, not "${value}"`);
  return Number(value);
}
export const GENERATED_DIR = path.join(REPO_ROOT, "infra/besu/generated");
/** Interop mode's second ledger (SPEC.md §7), generated beside the shared one. */
export const INTEROP_DIR = path.join(REPO_ROOT, "infra/besu/interop");
export const DEPLOYMENTS_DIR = path.join(REPO_ROOT, "deployments");

export async function readNetwork(file = path.join(GENERATED_DIR, "network.json")): Promise<Network> {
  return JSON.parse(await readFile(file, "utf8")) as Network;
}

export function readInteropNetwork(): Promise<Network> {
  return readNetwork(path.join(INTEROP_DIR, "network.json"));
}

/** A participant's own node, or the first node for a participant that runs none. */
export function rpcUrlFor(network: Network, participantId: string): string {
  const node = network.nodes.find((n) => n.participant === participantId) ?? network.nodes[0];
  if (!node) throw new Error("The network has no nodes");
  return node.rpcUrl;
}

export function sandboxChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: "Open Unified Ledger sandbox",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * The network runs with a zero base fee and a zero minimum gas price
 * (genesis `zeroBaseFee`, `--min-gas-price=0`): gas is metered, never paid.
 */
export const ZERO_FEES = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n } as const;

/** A JSON-RPC call to a Besu node, for the APIs viem does not wrap (PERM). */
export async function besuRpc<T>(url: string, method: string, ...params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { code?: number; message: string } };
  if (body.error) throw Object.assign(new Error(`${method} on ${url}: ${body.error.message}`), { code: body.error.code });
  return body.result as T;
}

/**
 * Add accounts to every node's account allowlist (Besu local permissioning,
 * kept per node), so they may send transactions: what the network's operator
 * does for a participant's new signing key. A node without permissioning
 * (Anvil) has nothing to update. Returns how many nodes were updated.
 */
export async function allowlistAccounts(network: Network, accounts: readonly string[]): Promise<number> {
  let updated = 0;
  for (const url of new Set(network.nodes.map((n) => n.rpcUrl))) {
    let allowed: string[];
    try {
      allowed = await besuRpc<string[]>(url, "perm_getAccountsAllowlist");
    } catch (error) {
      if ((error as { code?: number }).code === -32601) continue; // no permissioning API: nothing to allow
      throw error;
    }
    const missing = accounts.map((a) => a.toLowerCase()).filter((a) => !allowed.map((x) => x.toLowerCase()).includes(a));
    if (missing.length) await besuRpc(url, "perm_addAccountsToAllowlist", missing);
    updated++;
  }
  return updated;
}
