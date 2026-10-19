import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CurrencyCode } from "@oul/domain";
import type { Address, Hex } from "viem";
import type { BondRegulation, IdentityDeployment } from "./erc3643.ts";
import { DEPLOYMENTS_DIR } from "./network.ts";

/**
 * Where a scenario's contracts live on the sandbox network, and who every
 * party is on-chain. Written by `pnpm deploy`, read by the services.
 */
export interface Deployment {
  readonly scenario: string;
  readonly chainId: number;
  readonly deployedAt: string;
  /** The first block of the deployment; listeners start here. */
  readonly startBlock: string;
  /**
   * That block's hash: what proves a chain is the one this was deployed to.
   * Addresses cannot, since the sandbox's deterministic keys put the same
   * contracts at the same addresses on every fresh chain.
   */
  readonly startBlockHash: Hex;
  readonly contracts: { readonly registry: Address; readonly engine: Address };
  readonly tokens: Readonly<
    Record<
      string,
      {
        readonly address: Address;
        readonly kind: "wholesale" | "deposit" | "bond";
        /** The participant whose authority mints it: its central bank, the issuing bank, or a bond's agent. */
        readonly issuer: string;
        /** The currency of a cash token, or the one a bond is issued and paid in. */
        readonly currency: CurrencyCode;
        /** A bond's ERC-3643 contracts (SPEC.md §15). */
        readonly regulation?: BondRegulation;
      }
    >
  >;
  readonly participants: Readonly<
    Record<string, { readonly address: Address; readonly idHash: Hex; readonly kind: "central-bank" | "bank" }>
  >;
  /** Keyed `<bank>/<customer>`. */
  readonly customers: Readonly<Record<string, { readonly address: Address; readonly bank: string }>>;
  /** With bonds: the participants' and customers' identities and the trusted claim issuers (ERC-3643). */
  readonly identity?: IdentityDeployment;
  /**
   * Client custody (SPEC.md §15): each custodian's omnibus wallet as deployed,
   * a holding address bound to it in the registry. A recovery moves it on;
   * the custodian keeps its current wallet in its own books.
   */
  readonly custody?: Readonly<Record<string, { readonly wallet: Address; readonly clients: readonly string[] }>>;
}

export function deploymentFile(scenario: string): string {
  return path.join(DEPLOYMENTS_DIR, `${scenario}.json`);
}

export async function readDeployment(scenario: string): Promise<Deployment | undefined> {
  try {
    return JSON.parse(await readFile(deploymentFile(scenario), "utf8")) as Deployment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeDeployment(deployment: Deployment): Promise<string> {
  await mkdir(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentFile(deployment.scenario);
  await writeFile(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return file;
}

/** The address of a party: a participant id, or a customer as `<bank>/<customer>`. */
export function addressOf(deployment: Deployment, party: string): Address {
  const address = deployment.participants[party]?.address ?? deployment.customers[party]?.address;
  if (!address) throw new RangeError(`No party "${party}" in deployment ${deployment.scenario}`);
  return address;
}

export function tokenAddress(deployment: Deployment, symbol: string): Address {
  const token = deployment.tokens[symbol];
  if (!token) throw new RangeError(`No token "${symbol}" in deployment ${deployment.scenario}`);
  return token.address;
}
