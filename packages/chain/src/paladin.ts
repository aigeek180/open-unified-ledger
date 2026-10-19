import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { registryOperator, type Scenario, soleCurrency } from "@oul/scenario";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  type PublicClient,
  sha256,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "./deployment.ts";
import { devKeys, devPrivateKey, participantIdHash } from "./dev-keys.ts";
import { ConfidentialSettlement, ERC1967Proxy, WholesaleToken } from "./generated/contracts.ts";
import { besuRpc, DEPLOYMENTS_DIR, type Network, REPO_ROOT, rpcUrlFor, sandboxChain, ZERO_FEES } from "./network.ts";

/**
 * Confidential mode (SPEC.md §10): Paladin beside the shared ledger. Each bank
 * runs a Paladin node attached to its own Besu validator, and notarizes its
 * deposit token as a Noto token: holdings are private states that only the
 * holder's bank, the notary, and a transfer's parties hold; the shared ledger
 * records hashes and the notary's signature.
 *
 * Paladin supports Kubernetes only; these nodes run the release image in
 * Docker Compose with the configuration Paladin's operator would render: one
 * JVM per node, an embedded SQLite database, gRPC transport with self-signed
 * mutual TLS, and the base contracts deployed here.
 */

export const PALADIN_IMAGE = "ghcr.io/lfdt-paladin/paladin:v1.0.0";
export const PALADIN_DIR = path.join(REPO_ROOT, "infra/paladin/generated");
const VENDOR_DIR = path.resolve(import.meta.dirname, "../vendor/paladin-v1.0.0");
const RPC_PORT_BASE = 58620;
/** The shared ledger's Compose network, which the Paladin nodes join to reach their Besu nodes. */
const LEDGER_NETWORK = "open-unified-ledger-network_ledger";
const run = promisify(execFile);

export interface PaladinNode {
  /** The bank that runs it; also its Paladin node name. */
  readonly bank: string;
  readonly service: string;
  readonly rpcUrl: string;
  readonly besuService: string;
}

/** One Paladin node per bank, each attached to that bank's Besu validator. */
export function paladinNodes(scenario: Scenario): PaladinNode[] {
  return scenario.participants
    .filter((p) => p.kind === "bank")
    .map((p, i) => ({
      bank: p.id,
      service: `paladin-${p.id}`,
      rpcUrl: `http://127.0.0.1:${RPC_PORT_BASE + i * 2}`,
      besuService: `besu-${p.validator ? p.id : scenario.participants.find((v) => v.validator)!.id}`,
    }));
}

/**
 * The keys each node signs base-ledger transactions with, by Paladin key
 * identifier. The shared ledger's account allowlist must admit them.
 */
export const paladinKeys = (bank: string) =>
  ({
    registry: `registry.${bank}`,
    notary: "notary",
    submitter: "noto.submitter",
  }) as const;

export interface ConfidentialDeployment {
  readonly scenario: string;
  readonly deployedAt: string;
  /** The scenario deployment on the shared ledger this extends. */
  readonly startBlockHash: Hex;
  readonly contracts: {
    readonly registry: Address;
    readonly notoImplementation: Address;
    readonly notoFactory: Address;
    /** Settles an interbank payment over Noto locks and wholesale in one transaction (ConfidentialSettlement). */
    readonly settlement: Address;
  };
  readonly nodes: Readonly<Record<string, { readonly rpcUrl: string; readonly keys?: Readonly<Record<string, Address>> }>>;
  /** Each bank's deposit token as a Noto token, notarized by the bank. */
  readonly tokens: Readonly<Record<string, { readonly address: Address; readonly bank: string; readonly notary: string }>>;
}

export function confidentialDeploymentFile(scenario: string): string {
  return path.join(DEPLOYMENTS_DIR, `${scenario}.confidential.json`);
}

export async function readConfidentialDeployment(scenario: string): Promise<ConfidentialDeployment | undefined> {
  try {
    return JSON.parse(await readFile(confidentialDeploymentFile(scenario), "utf8")) as ConfidentialDeployment;
  } catch {
    return undefined;
  }
}

export async function writeConfidentialDeployment(deployment: ConfidentialDeployment): Promise<string> {
  const file = confidentialDeploymentFile(deployment.scenario);
  await writeFile(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return file;
}

/** A vendored Paladin v1.0.0 contract (vendor/paladin-v1.0.0). */
export async function paladinContract(name: "IdentityRegistry" | "Noto" | "NotoFactory" | "INotoPrivate"): Promise<{ abi: Abi; bytecode: Hex }> {
  return JSON.parse(await readFile(path.join(VENDOR_DIR, `${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
}

// ---------------------------------------------------------------- base contracts

/**
 * Deploy Paladin's base contracts on the shared ledger, as the central bank:
 * the identity registry (rooted at the central bank, which registers each
 * node, as it registers participants on the scenario's own registry), the
 * Noto implementation, and the Noto factory behind an ERC-1967 proxy.
 */
export async function deployConfidentialBase(
  scenario: Scenario,
  network: Network,
  deployment: Deployment,
  log: (m: string) => void = () => {},
): Promise<ConfidentialDeployment> {
  soleCurrency(scenario, "Confidential mode");
  const cbId = registryOperator(scenario).id;
  const chain = sandboxChain(network.chainId, rpcUrlFor(network, cbId));
  const client = createPublicClient({ chain, transport: http() }) as PublicClient;
  const wallet = createWalletClient({ account: privateKeyToAccount(devKeys.participant(cbId)), chain, transport: http() });
  const deploy = async (contract: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) => {
    const hash = await wallet.deployContract({ abi: contract.abi, bytecode: contract.bytecode, args, ...ZERO_FEES } as never);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment ${hash} failed`);
    return receipt.contractAddress;
  };
  log(`Deploying Paladin's base contracts to chain ${network.chainId}`);
  const registry = await deploy(await paladinContract("IdentityRegistry"), [false]);
  log(`  IdentityRegistry ${registry} (root: the central bank)`);
  const notoImplementation = await deploy(await paladinContract("Noto"), []);
  const factory = await paladinContract("NotoFactory");
  const factoryImplementation = await deploy(factory, []);
  const notoFactory = await deploy(ERC1967Proxy, [
    factoryImplementation,
    encodeFunctionData({ abi: factory.abi, functionName: "initialize", args: [notoImplementation] }),
  ]);
  log(`  Noto ${notoImplementation}, NotoFactory ${notoFactory} (proxy of ${factoryImplementation})`);
  // Confidential payments: wholesale moves through it under the engine's authority rule, as it spends the Noto locks.
  const settlement = await deploy(ConfidentialSettlement, [deployment.contracts.registry, wallet.account.address]);
  const wholesale = Object.values(deployment.tokens).find((t) => t.kind === "wholesale")!.address;
  const role = (await client.readContract({ address: wholesale, abi: WholesaleToken.abi, functionName: "SETTLEMENT_ROLE" })) as Hex;
  const granted = await wallet.writeContract({ address: wholesale, abi: WholesaleToken.abi, functionName: "grantRole", args: [role, settlement], ...ZERO_FEES } as never);
  if ((await client.waitForTransactionReceipt({ hash: granted })).status !== "success") throw new Error("Granting the settlement role reverted");
  log(`  ConfidentialSettlement ${settlement}, which may settle wholesale`);
  return {
    scenario: scenario.id,
    deployedAt: new Date().toISOString(),
    startBlockHash: deployment.startBlockHash,
    contracts: { registry, notoImplementation, notoFactory, settlement },
    nodes: Object.fromEntries(paladinNodes(scenario).map((n) => [n.bank, { rpcUrl: n.rpcUrl }])),
    tokens: {},
  };
}

// ---------------------------------------------------------------- node files

/** A node's wallet seed: derived from a public label, like every sandbox key, so public and for the sandbox only. */
const seedOf = (bank: string) => devPrivateKey(`paladin/${bank}`).slice(2);

function nodeConfig(node: PaladinNode, base: ConfidentialDeployment): object {
  return {
    nodeName: node.bank,
    log: { level: "info" },
    db: { type: "sqlite", sqlite: { dsn: "file:/db/paladin.db", autoMigrate: true, migrationsDir: "/app/db/migrations/sqlite" } },
    blockchain: {
      http: { url: `http://${node.besuService}:8545` },
      ws: { url: `ws://${node.besuService}:8546`, initialConnectAttempts: 50 },
    },
    rpcServer: { http: { port: 8548, address: "0.0.0.0" }, ws: { port: 8549, address: "0.0.0.0" } },
    wallets: [
      {
        name: "wallet1",
        keySelector: ".*",
        signer: {
          keyDerivation: { type: "bip32" },
          keyStore: { type: "static", static: { keys: { seed: { encoding: "hex", inline: seedOf(node.bank) } } } },
        },
      },
    ],
    // The shared ledger meters gas and charges nothing (SPEC.md §4.1).
    publicTxManager: { gasPrice: { fixedGasPrice: { maxFeePerGas: "0", maxPriorityFeePerGas: "0" } } },
    domains: {
      noto: {
        plugin: { type: "c-shared", library: "/app/domains/libnoto.so" },
        config: { factoryVersion: 2 },
        registryAddress: base.contracts.notoFactory,
        // A fixed key, so the shared ledger's allowlist can admit it; Paladin would otherwise use a new one each time.
        fixedSigningIdentity: paladinKeys(node.bank).submitter,
      },
    },
    registries: {
      registry: {
        plugin: { type: "c-shared", library: "/app/registries/libevm.so" },
        config: { contractAddress: base.contracts.registry },
      },
    },
    transports: {
      grpc: {
        plugin: { type: "c-shared", library: "/app/transports/libgrpc.so" },
        config: {
          port: 9000,
          address: "0.0.0.0",
          externalHostname: node.service,
          // Mutual TLS with self-signed certificates, each checked against the one its node published in the registry.
          tls: { enabled: true, clientAuth: true, certFile: "/tls/tls.crt", keyFile: "/tls/tls.key" },
        },
      },
    },
  };
}

function composeFile(nodes: readonly PaladinNode[]): string {
  const lines = [
    "# Generated by `pnpm confidential:deploy`; do not edit.",
    "name: open-unified-ledger-paladin",
    "",
    "networks:",
    "  ledger:",
    "    external: true",
    `    name: ${LEDGER_NETWORK}`,
    "",
    "services:",
    // The image runs as uid 1001 and fresh volumes belong to root: hand them over once, before the nodes start
    // (Kubernetes does this with fsGroup).
    "  paladin-volumes:",
    `    image: ${PALADIN_IMAGE}`,
    '    user: "0:0"',
    "    entrypoint:",
    "      - sh",
    "      - -c",
    "      - chown -R 1001:1001 /volumes",
    "    volumes:",
    ...nodes.flatMap((node) => [`      - ${node.service}-db:/volumes/${node.service}-db`, `      - ${node.service}-jna:/volumes/${node.service}-jna`]),
    "",
  ];
  nodes.forEach((node, i) => {
    lines.push(
      `  ${node.service}:`,
      `    image: ${PALADIN_IMAGE}`,
      "    restart: unless-stopped",
      "    depends_on:",
      "      paladin-volumes:",
      "        condition: service_completed_successfully",
      "    command:",
      "      - /app/config/pldconf.paladin.yaml",
      "      - engine",
      "      - --logtostderr=true",
      "      - --v=4",
      "    environment:",
      // One JVM per node, beside four Besu JVMs on one laptop: cap it.
      '      JAVA_TOOL_OPTIONS: "-Xms128m -Xmx640m -XX:+UseSerialGC"',
      "    mem_limit: 1100m",
      "    volumes:",
      `      - ./${node.bank}/pldconf.json:/app/config/pldconf.paladin.yaml:ro`,
      `      - ./${node.bank}/tls:/tls:ro`,
      `      - ${node.service}-db:/db`,
      `      - ${node.service}-jna:/app/jna`,
      "    ports:",
      `      - "127.0.0.1:${RPC_PORT_BASE + i * 2}:8548"`,
      `      - "127.0.0.1:${RPC_PORT_BASE + i * 2 + 1}:8549"`,
      "    networks:",
      "      - ledger",
      "",
    );
  });
  lines.push("volumes:");
  for (const node of nodes) lines.push(`  ${node.service}-db:`, `  ${node.service}-jna:`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Write each node's configuration and a self-signed certificate (subject CN
 * the node name, SAN its hostname, as Paladin's direct certificate
 * verification requires), and the Compose file, under infra/paladin/generated.
 */
export async function writePaladinFiles(scenario: Scenario, base: ConfidentialDeployment): Promise<string> {
  const nodes = paladinNodes(scenario);
  await rm(PALADIN_DIR, { recursive: true, force: true });
  for (const node of nodes) {
    const dir = path.join(PALADIN_DIR, node.bank);
    await mkdir(path.join(dir, "tls"), { recursive: true });
    await writeFile(path.join(dir, "pldconf.json"), `${JSON.stringify(nodeConfig(node, base), null, 2)}\n`);
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "3650",
      "-subj",
      `/CN=${node.bank}`,
      "-addext",
      `subjectAltName=DNS:${node.service},DNS:localhost`,
      "-keyout",
      path.join(dir, "tls/tls.key"),
      "-out",
      path.join(dir, "tls/tls.crt"),
    ]);
  }
  await writeFile(path.join(PALADIN_DIR, "compose.yaml"), composeFile(nodes));
  return PALADIN_DIR;
}

// ---------------------------------------------------------------- talking to a node

/** A Paladin node's JSON-RPC (Paladin's SDK is CommonJS and brings ethers; these few calls need neither). */
export class PaladinRpc {
  readonly url: string;
  private id = 0;
  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, ...params: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  async ready(timeoutMs = 180_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await this.call<string>("transport_nodeName");
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`Paladin at ${this.url} not ready: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  resolveAddress(key: string): Promise<Address> {
    return this.call<Address>("keymgr_resolveEthAddress", key);
  }

  sendTransaction(tx: object): Promise<string> {
    return this.call<string>("ptx_sendTransaction", tx);
  }

  /** Wait for a transaction's receipt; throw with Paladin's reason if it failed. */
  async receipt(id: string, timeoutMs = 120_000): Promise<PaladinReceipt> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.call<PaladinReceipt | null>("ptx_getTransactionReceipt", id);
      if (receipt) {
        if (!receipt.success) throw new Error(`Paladin transaction ${id} failed: ${receipt.failureMessage ?? "no reason given"}`);
        return receipt;
      }
      if (Date.now() > deadline) throw new Error(`No receipt for Paladin transaction ${id} after ${timeoutMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export interface PaladinReceipt {
  readonly id: string;
  readonly success: boolean;
  readonly transactionHash?: Hex;
  readonly blockNumber?: number;
  readonly contractAddress?: Address;
  readonly failureMessage?: string;
}

/** Noto's constructor as Paladin takes it, in basic notary mode (Paladin's SDK, notoConstructorABI). */
const NOTO_CONSTRUCTOR = {
  type: "constructor",
  inputs: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "notary", type: "string" },
    { name: "notaryMode", type: "string" },
    {
      name: "options",
      type: "tuple",
      components: [
        {
          name: "basic",
          type: "tuple",
          components: [
            { name: "restrictMint", type: "bool" },
            { name: "allowBurn", type: "bool" },
            { name: "allowLock", type: "bool" },
          ],
        },
      ],
    },
  ],
} as const;

// ---------------------------------------------------------------- setup, once the nodes run

/**
 * Bring the running nodes into the network:
 *   1. allowlist each node's signing keys on every Besu node (local account permissioning is per node);
 *   2. register each node in the identity registry, as the central bank, owned by the node's registry key;
 *   3. have each node publish its gRPC endpoint and certificate there;
 *   4. deploy each bank's deposit token as a Noto token, notarized by the bank, in basic mode.
 */
export async function setupConfidential(
  scenario: Scenario,
  network: Network,
  base: ConfidentialDeployment,
  log: (m: string) => void = () => {},
): Promise<ConfidentialDeployment> {
  soleCurrency(scenario, "Confidential mode");
  const cbId = registryOperator(scenario).id;
  const chain = sandboxChain(network.chainId, rpcUrlFor(network, cbId));
  const client = createPublicClient({ chain, transport: http(), pollingInterval: 500 }) as PublicClient;
  const cb = createWalletClient({ account: privateKeyToAccount(devKeys.participant(cbId)), chain, transport: http() });
  const registryAbi = (await paladinContract("IdentityRegistry")).abi;
  const nodes = paladinNodes(scenario);

  // 1. Keys and allowlist.
  const keys: Record<string, Record<string, Address>> = {};
  for (const node of nodes) {
    const rpc = new PaladinRpc(node.rpcUrl);
    const name = await rpc.ready();
    if (name !== node.bank) throw new Error(`${node.service} calls itself "${name}", expected "${node.bank}"`);
    keys[node.bank] = {};
    for (const [role, key] of Object.entries(paladinKeys(node.bank))) keys[node.bank]![role] = await rpc.resolveAddress(key);
  }
  const addresses = Object.values(keys).flatMap((k) => Object.values(k).map((a) => a.toLowerCase()));
  for (const besu of network.nodes) {
    const allowed = await besuRpc<string[]>(besu.rpcUrl, "perm_getAccountsAllowlist");
    const missing = addresses.filter((a) => !allowed.map((x) => x.toLowerCase()).includes(a));
    if (missing.length) await besuRpc(besu.rpcUrl, "perm_addAccountsToAllowlist", missing);
  }
  log(`  allowlisted ${addresses.length} Paladin signing keys on ${network.nodes.length} Besu nodes`);

  // 2. Registration, by the registry's root: the central bank.
  for (const node of nodes) {
    const identityHash = sha256(encodePacked(["bytes32", "string"], [`0x${"00".repeat(32)}`, node.bank]));
    // getIdentity reverts for a name not registered yet.
    const existing = (await client
      .readContract({ address: base.contracts.registry, abi: registryAbi, functionName: "getIdentity", args: [identityHash] })
      .catch(() => undefined)) as { name: string } | undefined;
    if (existing?.name === node.bank) continue;
    const hash = await cb.writeContract({
      address: base.contracts.registry,
      abi: registryAbi,
      functionName: "registerIdentity",
      args: [`0x${"00".repeat(32)}`, node.bank, keys[node.bank]!.registry],
      ...ZERO_FEES,
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Registering ${node.bank} reverted`);
  }
  log(`  registered ${nodes.map((n) => n.bank).join(", ")} in the identity registry`);

  // 3. Each node publishes its transport details, signed by its own registry key.
  for (const node of nodes) {
    const rpc = new PaladinRpc(node.rpcUrl);
    const details = await rpc.call<string>("transport_localTransportDetails", "grpc");
    const identityHash = sha256(encodePacked(["bytes32", "string"], [`0x${"00".repeat(32)}`, node.bank]));
    const id = await rpc.sendTransaction({
      type: "public",
      from: paladinKeys(node.bank).registry,
      to: base.contracts.registry,
      abi: registryAbi,
      function: "setIdentityProperty",
      data: { identityHash, name: "transport.grpc", value: details },
    });
    await rpc.receipt(id);
  }
  log("  each node published its gRPC endpoint and certificate");

  // 4. A Noto token per bank, notarized by the bank.
  const tokens: Record<string, { address: Address; bank: string; notary: string }> = { ...base.tokens };
  for (const node of nodes) {
    const spec = scenario.instruments.deposits.find((d) => d.issuer === node.bank)!;
    if (tokens[spec.symbol]) continue;
    const bank = scenario.participants.find((p) => p.id === node.bank)!;
    const rpc = new PaladinRpc(node.rpcUrl);
    const notary = `${paladinKeys(node.bank).notary}@${node.bank}`;
    const id = await rpc.sendTransaction({
      type: "private",
      domain: "noto",
      abi: [NOTO_CONSTRUCTOR],
      function: "",
      from: paladinKeys(node.bank).notary,
      data: {
        name: `${bank.name} deposit ${spec.currency}`,
        symbol: spec.symbol,
        notary,
        notaryMode: "basic",
        options: { basic: { restrictMint: true, allowBurn: true, allowLock: true } },
      },
    });
    const receipt = await rpc.receipt(id);
    if (!receipt.contractAddress) throw new Error(`Deploying ${spec.symbol} on Noto gave no address`);
    tokens[spec.symbol] = { address: receipt.contractAddress, bank: node.bank, notary };
    log(`  ${spec.symbol} as a Noto token ${receipt.contractAddress}, notarized by ${notary}`);
  }

  // 5. The central bank lists each Noto deposit token, with its bank, on the confidential settlement contract.
  for (const token of Object.values(tokens)) {
    const listed = (await client.readContract({
      address: base.contracts.settlement,
      abi: ConfidentialSettlement.abi,
      functionName: "bankOf",
      args: [token.address],
    })) as Hex;
    if (listed === participantIdHash(token.bank)) continue;
    const hash = await cb.writeContract({
      address: base.contracts.settlement,
      abi: ConfidentialSettlement.abi,
      functionName: "listNoto",
      args: [token.address, participantIdHash(token.bank)],
      ...ZERO_FEES,
    } as never);
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`Listing ${token.address} reverted`);
  }
  log(`  listed ${Object.keys(tokens).length} Noto tokens for confidential payments`);

  return {
    ...base,
    nodes: Object.fromEntries(nodes.map((n) => [n.bank, { rpcUrl: n.rpcUrl, keys: keys[n.bank]! }])),
    tokens,
  };
}

