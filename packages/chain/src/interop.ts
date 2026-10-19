import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CurrencyCode, minorUnit } from "@oul/domain";
import { registryOperator, type Scenario } from "@oul/scenario";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createNonceManager, jsonRpc } from "viem/nonce";
import { waitForBlocks } from "./deploy.ts";
import type { Deployment } from "./deployment.ts";
import { customerAddress, devKeys, participantAddress, participantIdHash } from "./dev-keys.ts";
import { ConditionalSettlement, DepositToken, ParticipantRegistry, SettlementEngine, WholesaleToken } from "./generated/contracts.ts";
import { DEPLOYMENTS_DIR, type Network, rpcUrlFor, sandboxChain, ZERO_FEES } from "./network.ts";

/**
 * Interop mode's contracts (SPEC.md §7), on both ledgers:
 *   - ledger 1, the shared ledger: a ConditionalSettlement over the scenario's registry, allowed to lock
 *     and settle every cash token there;
 *   - ledger 2: its own registry (the central bank registers who takes part, as on ledger 1), the deposit
 *     tokens the scenario puts there, each deployed by its bank with the same customers allowlisted, and
 *     a ConditionalSettlement allowed to lock and settle them. In a scenario of two currencies (SPEC.md
 *     §13) ledger 2 carries the second currency whole: its central bank operates the registry there and
 *     issues its wholesale token, with a reserve account for each bank holding it, and a settlement engine
 *     funds those reserves.
 * Written to deployments/<scenario>.interop.json; identified, like a scenario's deployment, by the hashes
 * of its start blocks, since deterministic keys put the same contracts at the same addresses on every
 * fresh chain.
 */
export interface InteropDeployment {
  readonly scenario: string;
  readonly deployedAt: string;
  readonly notary: { readonly id: string; readonly address: Address };
  readonly ledger1: {
    readonly chainId: number;
    /** The scenario deployment this extends. */
    readonly startBlockHash: Hex;
    readonly conditional: Address;
  };
  readonly ledger2: {
    readonly chainId: number;
    readonly startBlock: string;
    readonly startBlockHash: Hex;
    readonly registry: Address;
    readonly conditional: Address;
    /** The engine that funds wholesale reserves on ledger 2, when a currency's wholesale lives there. */
    readonly engine?: Address;
    readonly tokens: Readonly<
      Record<
        string,
        { readonly address: Address; readonly issuer: string; readonly kind: "wholesale" | "deposit"; readonly currency: CurrencyCode }
      >
    >;
    readonly customers: Readonly<Record<string, { readonly address: Address; readonly bank: string }>>;
  };
}

export function interopDeploymentFile(scenario: string): string {
  return path.join(DEPLOYMENTS_DIR, `${scenario}.interop.json`);
}

export async function readInteropDeployment(scenario: string): Promise<InteropDeployment | undefined> {
  try {
    return JSON.parse(await readFile(interopDeploymentFile(scenario), "utf8")) as InteropDeployment;
  } catch {
    return undefined;
  }
}

export async function writeInteropDeployment(deployment: InteropDeployment): Promise<string> {
  const file = interopDeploymentFile(deployment.scenario);
  await writeFile(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return file;
}

interface Signer {
  readonly id: string;
  readonly wallet: WalletClient;
  readonly address: Address;
}

/** Deploy interop mode's contracts on both ledgers, or reuse a deployment still on both chains. */
export async function deployInterop(
  scenario: Scenario,
  shared: { network: Network; deployment: Deployment },
  ledger2: Network,
  options: { force?: boolean; log?: (message: string) => void } = {},
): Promise<{ deployment: InteropDeployment; reused: boolean }> {
  const log = options.log ?? (() => {});
  const spec = scenario.interop;
  if (!spec) throw new Error(`Scenario ${scenario.id} has no interop ledger`);
  const cbId = registryOperator(scenario).id;
  const client1 = createPublicClient({ chain: sandboxChain(shared.network.chainId, rpcUrlFor(shared.network, cbId)), transport: http() }) as PublicClient;
  const client2 = createPublicClient({ chain: sandboxChain(ledger2.chainId, rpcUrlFor(ledger2, cbId)), transport: http() }) as PublicClient;
  await waitForBlocks(client2, log);

  const existing = await readInteropDeployment(scenario.id);
  if (existing && !options.force && existing.ledger1.startBlockHash === shared.deployment.startBlockHash) {
    const block = await client2.getBlock({ blockNumber: BigInt(existing.ledger2.startBlock) }).catch(() => undefined);
    if (block?.hash === existing.ledger2.startBlockHash) {
      log(`Reusing the interop deployment recorded in deployments/${scenario.id}.interop.json`);
      return { deployment: existing, reused: true };
    }
  }

  // Nonces read from each chain, for this deployment (see deployScenario).
  const nonces = createNonceManager({ source: jsonRpc() });
  const signer = (id: string, network: Network): Signer => {
    const account = privateKeyToAccount(devKeys.participant(id), { nonceManager: nonces });
    const chain = sandboxChain(network.chainId, rpcUrlFor(network, id));
    return { id, address: account.address, wallet: createWalletClient({ account, chain, transport: http() }) };
  };
  const deployOn = (client: PublicClient) => async (from: Signer, contract: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) => {
    const hash = await from.wallet.deployContract({
      abi: contract.abi,
      bytecode: contract.bytecode,
      args,
      account: from.wallet.account!,
      chain: from.wallet.chain,
      ...ZERO_FEES,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment ${hash} failed`);
    return receipt.contractAddress;
  };
  const call = (from: Signer, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    from.wallet.writeContract({ address, abi, functionName, args, account: from.wallet.account!, chain: from.wallet.chain, ...ZERO_FEES });
  const confirmAll = async (client: PublicClient, sends: Promise<Hash>[]) => {
    for (const hash of await Promise.all(sends)) {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
    }
  };

  const roles = async (client: PublicClient, token: Address) => {
    const read = (functionName: "SETTLEMENT_ROLE" | "FREEZER_ROLE") =>
      client.readContract({ address: token, abi: WholesaleToken.abi, functionName }) as Promise<Hex>;
    return [await read("SETTLEMENT_ROLE"), await read("FREEZER_ROLE")] as const;
  };

  // Ledger 1: a conditional settlement over the scenario's registry, allowed on every cash token.
  log(`Deploying interop mode for ${scenario.id}`);
  const cb1 = signer(cbId, shared.network);
  const conditional1 = await deployOn(client1)(cb1, ConditionalSettlement, [shared.deployment.contracts.registry]);
  log(`  ledger 1 (chain ${shared.network.chainId}): ConditionalSettlement ${conditional1}`);
  const grants1: Promise<Hash>[] = [];
  for (const [symbol, token] of Object.entries(shared.deployment.tokens)) {
    if (token.kind === "bond") continue;
    const admin = signer(token.issuer, shared.network);
    for (const role of await roles(client1, token.address)) {
      grants1.push(call(admin, token.address, WholesaleToken.abi, "grantRole", [role, conditional1]));
    }
    log(`    may lock and settle ${symbol}`);
  }
  await confirmAll(client1, grants1);

  // Ledger 2: its own registry, the tokens that live there, and its conditional settlement. Its currency's
  // central bank operates it when a wholesale token lives there; otherwise the shared ledger's operator.
  const start2 = await client2.getBlock();
  const wholesale2 = spec.wholesale.map((symbol) => scenario.instruments.wholesale.find((w) => w.symbol === symbol)!);
  const operator2 = wholesale2[0]?.issuer ?? cbId;
  const cb2 = signer(operator2, ledger2);
  const deploy2 = deployOn(client2);
  const registry2 = await deploy2(cb2, ParticipantRegistry, [participantIdHash(operator2), cb2.address]);
  const reserveHolders = scenario.participants.filter((p) => p.kind === "bank" && wholesale2.some((w) => p.reserves.includes(w.currency)));
  const banks2 = [
    ...new Set([...spec.deposits.map((symbol) => scenario.instruments.deposits.find((d) => d.symbol === symbol)!.issuer), ...reserveHolders.map((p) => p.id)]),
  ];
  await confirmAll(
    client2,
    banks2.map((bank) => call(cb2, registry2, ParticipantRegistry.abi, "admitBank", [participantIdHash(bank), participantAddress(bank)])),
  );
  const conditional2 = await deploy2(cb2, ConditionalSettlement, [registry2]);
  const engine2 = wholesale2.length > 0 ? await deploy2(cb2, SettlementEngine, [registry2]) : undefined;
  log(`  ledger 2 (chain ${ledger2.chainId}): ParticipantRegistry ${registry2} (operated by ${operator2}), ConditionalSettlement ${conditional2}${engine2 ? `, SettlementEngine ${engine2}` : ""}`);

  const tokens: Record<string, InteropDeployment["ledger2"]["tokens"][string]> = {};
  const customers: Record<string, { address: Address; bank: string }> = {};
  const wiring: Promise<Hash>[] = [];
  for (const w of wholesale2) {
    const issuer = signer(w.issuer, ledger2);
    const address = await deploy2(issuer, WholesaleToken, [`Wholesale ${w.currency}`, w.symbol, minorUnit(w.currency), registry2, participantIdHash(w.issuer)]);
    tokens[w.symbol] = { address, issuer: w.issuer, kind: "wholesale", currency: w.currency };
    log(`    WholesaleToken ${w.symbol} ${address}`);
    for (const role of await roles(client2, address)) wiring.push(call(issuer, address, WholesaleToken.abi, "grantRole", [role, conditional2]));
    const [settlementRole] = await roles(client2, address);
    wiring.push(call(issuer, address, WholesaleToken.abi, "grantRole", [settlementRole, engine2!]));
    for (const bank of reserveHolders.filter((p) => p.reserves.includes(w.currency))) {
      wiring.push(call(issuer, address, WholesaleToken.abi, "openReserveAccount", [participantIdHash(bank.id)]));
    }
    wiring.push(call(issuer, registry2, ParticipantRegistry.abi, "listToken", [address]));
  }
  for (const symbol of spec.deposits) {
    const { issuer: bankId, currency } = scenario.instruments.deposits.find((d) => d.symbol === symbol)!;
    const bank = scenario.participants.find((p) => p.id === bankId)!;
    const issuer = signer(bankId, ledger2);
    const address = await deploy2(issuer, DepositToken, [
      `${bank.name} deposit ${currency}`,
      symbol,
      minorUnit(currency),
      registry2,
      participantIdHash(bankId),
    ]);
    tokens[symbol] = { address, issuer: bankId, kind: "deposit", currency };
    log(`    DepositToken ${symbol} ${address}`);
    for (const role of await roles(client2, address)) wiring.push(call(issuer, address, DepositToken.abi, "grantRole", [role, conditional2]));
    for (const customer of scenario.ledgers.find((l) => l.participant === bankId)?.customers ?? []) {
      const holder = customerAddress(bankId, customer.id);
      customers[`${bankId}/${customer.id}`] = { address: holder, bank: bankId };
      wiring.push(call(issuer, address, DepositToken.abi, "allowHolder", [holder]));
    }
    wiring.push(call(cb2, registry2, ParticipantRegistry.abi, "listToken", [address]));
  }
  await confirmAll(client2, wiring);
  log(`    wired: ${Object.keys(customers).length} customers allowlisted, ${Object.keys(tokens).length} tokens listed`);

  return {
    reused: false,
    deployment: {
      scenario: scenario.id,
      deployedAt: new Date().toISOString(),
      notary: { id: spec.notary.id, address: participantAddress(spec.notary.id) },
      ledger1: { chainId: shared.network.chainId, startBlockHash: shared.deployment.startBlockHash, conditional: conditional1 },
      ledger2: {
        chainId: ledger2.chainId,
        startBlock: start2.number.toString(),
        startBlockHash: start2.hash,
        registry: registry2,
        conditional: conditional2,
        ...(engine2 ? { engine: engine2 } : {}),
        tokens,
        customers,
      },
    },
  };
}
