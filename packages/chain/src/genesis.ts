import type { Scenario } from "@oul/scenario";
import { type Address, type Hex, toHex, toRlp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { devKeys, participantAddress } from "./dev-keys.ts";
import { type Network, sandboxSlot } from "./network.ts";

/**
 * Everything a scenario's QBFT network needs (SPEC.md §4.1): genesis with
 * the validators in its extra data, node keys, static peers, the node and
 * account allowlists, and a Compose file with one Besu service per validator.
 */

export const BESU_IMAGE = "hyperledger/besu:26.9.0";
const SLOT = sandboxSlot();
/** The shared ledger's chain id; another sandbox (OUL_SLOT) counts on from it in tens. */
export const CHAIN_ID = 20261 + 10 * SLOT;
const suffix = SLOT === 0 ? "" : `-${SLOT}`;
const FIRST_HOST = 11;

/**
 * Where a ledger's network lives. The shared ledger is the one every mode
 * uses; interop mode (SPEC.md §7) adds a second, separate one, with its own
 * chain id, subnet, ports and Compose project, so the two share nothing.
 */
export interface LedgerLayout {
  readonly ledger: "shared" | "interop";
  readonly chainId: number;
  readonly subnet: string;
  readonly rpcPortBase: number;
  readonly project: string;
}

export const SHARED_LEDGER: LedgerLayout = {
  ledger: "shared",
  chainId: CHAIN_ID,
  subnet: `10.88.${42 + 2 * SLOT}`,
  rpcPortBase: 58545 + 100 * SLOT,
  project: `open-unified-ledger-network${suffix}`,
};

export const INTEROP_LEDGER: LedgerLayout = {
  ledger: "interop",
  chainId: CHAIN_ID + 1,
  subnet: `10.88.${43 + 2 * SLOT}`,
  rpcPortBase: 58585 + 100 * SLOT,
  project: `open-unified-ledger-interop${suffix}`,
};
/** Two-second blocks: quick enough for a demo, slack enough for four JVMs on a laptop. */
const BLOCK_PERIOD_SECONDS = 2;
/** QBFT's mix hash marker ("ctical byzantine fault tolerance"). */
const QBFT_MIX_HASH = "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365";

export interface ValidatorNode {
  readonly participant: string;
  readonly service: string;
  readonly key: Hex;
  readonly address: Address;
  readonly ip: string;
  readonly enode: string;
  readonly rpcPort: number;
  readonly wsPort: number;
}

export interface NetworkFiles {
  readonly network: Network;
  readonly genesis: object;
  readonly nodes: readonly ValidatorNode[];
  readonly permissions: string;
  readonly staticNodes: readonly string[];
  readonly compose: string;
}

/**
 * QBFT genesis extra data: RLP([32-byte vanity, validators, no vote, round 0,
 * no seals]), the shape Besu's `rlp encode --type=QBFT_EXTRA_DATA` produces.
 */
export function qbftExtraData(validators: readonly Address[]): Hex {
  return toRlp([toHex(new Uint8Array(32)), [...validators], [], "0x", []]);
}

export function buildNetworkFiles(scenario: Scenario, layout: LedgerLayout = SHARED_LEDGER): NetworkFiles {
  if (layout.ledger === "interop" && !scenario.interop) throw new Error(`Scenario ${scenario.id} has no interop ledger`);
  const validators =
    layout.ledger === "shared"
      ? scenario.participants.filter((p) => p.validator)
      : scenario.participants.filter((p) => scenario.interop!.validators.includes(p.id));
  const nodes: ValidatorNode[] = validators.map((p, index) => {
    const key = devKeys.validator(p.id);
    const account = privateKeyToAccount(key);
    const ip = `${layout.subnet}.${FIRST_HOST + index}`;
    return {
      participant: p.id,
      service: `besu-${p.id}`,
      key,
      address: account.address,
      ip,
      // The enode id is the uncompressed public key without its 0x04 prefix.
      enode: `enode://${account.publicKey.slice(4)}@${ip}:30303`,
      rpcPort: layout.rpcPortBase + index * 2,
      wsPort: layout.rpcPortBase + index * 2 + 1,
    };
  });

  // Only central banks and banks send transactions, and in interop mode the
  // notary, which commits on both ledgers; customers never do.
  const senders = [
    ...scenario.participants.filter((p) => p.kind === "central-bank" || p.kind === "bank").map((p) => participantAddress(p.id)),
    ...(scenario.interop ? [participantAddress(scenario.interop.notary.id)] : []),
  ];

  const genesis = {
    config: {
      chainId: layout.chainId,
      homesteadBlock: 0,
      eip150Block: 0,
      eip155Block: 0,
      eip158Block: 0,
      byzantiumBlock: 0,
      constantinopleBlock: 0,
      petersburgBlock: 0,
      istanbulBlock: 0,
      muirGlacierBlock: 0,
      berlinBlock: 0,
      londonBlock: 0,
      shanghaiTime: 0,
      cancunTime: 0,
      zeroBaseFee: true,
      qbft: { blockperiodseconds: BLOCK_PERIOD_SECONDS, epochlength: 30000, requesttimeoutseconds: 4 },
    },
    nonce: "0x0",
    timestamp: "0x0",
    gasLimit: "0x1fffffffffffff",
    difficulty: "0x1",
    mixHash: QBFT_MIX_HASH,
    coinbase: "0x0000000000000000000000000000000000000000",
    alloc: Object.fromEntries(senders.map((a) => [a, { balance: "0xd3c21bcecceda1000000" }])),
    extraData: qbftExtraData(nodes.map((n) => n.address)),
  };

  const staticNodes = nodes.map((n) => n.enode);
  // Lowercase, the form Besu stores. Each node gets its own copy of this file.
  const permissions = [
    "# Generated by `pnpm network:generate`. Local permissioning: only these",
    "# nodes may peer, and only these accounts may send transactions.",
    `nodes-allowlist=${JSON.stringify(staticNodes)}`,
    `accounts-allowlist=${JSON.stringify(senders.map((a) => a.toLowerCase()))}`,
    "",
  ].join("\n");

  const network: Network = {
    scenario: scenario.id,
    chainId: layout.chainId,
    nodes: nodes.map((n) => ({
      participant: n.participant,
      validator: n.address,
      rpcUrl: `http://127.0.0.1:${n.rpcPort}`,
      wsUrl: `ws://127.0.0.1:${n.wsPort}`,
      enode: n.enode,
    })),
  };

  return { network, genesis, nodes, permissions, staticNodes, compose: composeFile(nodes, layout) };
}

function composeFile(nodes: readonly ValidatorNode[], layout: LedgerLayout): string {
  const lines = [
    "# Generated by `pnpm network:generate`; do not edit.",
    `name: ${layout.project}`,
    "",
    "networks:",
    "  ledger:",
    "    ipam:",
    "      config:",
    `        - subnet: ${layout.subnet}.0/24`,
    "",
    "services:",
  ];
  for (const node of nodes) {
    lines.push(
      `  ${node.service}:`,
      `    image: ${BESU_IMAGE}`,
      "    restart: unless-stopped",
      "    environment:",
      // Four JVMs share a laptop's Docker VM with other projects: cap each one.
      '      JAVA_OPTS: "-Xms128m -Xmx384m -XX:+UseSerialGC"',
      "    mem_limit: 640m",
      "    command:",
      "      - --data-path=/opt/besu/data",
      "      - --genesis-file=/config/genesis.json",
      "      - --node-private-key-file=/config/key",
      "      - --static-nodes-file=/config/static-nodes.json",
      "      - --discovery-enabled=false",
      `      - --p2p-host=${node.ip}`,
      "      - --p2p-port=30303",
      "      - --permissions-nodes-config-file-enabled",
      "      - --permissions-nodes-config-file=/config/permissions_config.toml",
      "      - --permissions-accounts-config-file-enabled",
      "      - --permissions-accounts-config-file=/config/permissions_config.toml",
      "      - --min-gas-price=0",
      "      - --rpc-http-enabled",
      "      - --rpc-http-host=0.0.0.0",
      // PERM lets confidential mode (SPEC.md §10) allowlist each Paladin node's signing keys at runtime.
      "      - --rpc-http-api=ETH,NET,WEB3,QBFT,TXPOOL,PERM",
      "      - --rpc-ws-enabled",
      "      - --rpc-ws-host=0.0.0.0",
      "      - --rpc-ws-api=ETH,NET,WEB3,QBFT",
      // Paladin reads revert reasons to explain a failed base-ledger transaction.
      "      - --revert-reason-enabled",
      "      - --host-allowlist=*",
      "      - --rpc-http-cors-origins=*",
      "      - --logging=INFO",
      "    volumes:",
      "      - ./genesis.json:/config/genesis.json:ro",
      `      - ./${node.participant}/key:/config/key:ro`,
      "      - ./static-nodes.json:/config/static-nodes.json:ro",
      // Besu writes the allowlist back at startup, so the mount is writable; each
      // node has its own copy, so no node can clobber another's.
      `      - ./${node.participant}/permissions_config.toml:/config/permissions_config.toml`,
      `      - ${node.service}-data:/opt/besu/data`,
      "    ports:",
      `      - "127.0.0.1:${node.rpcPort}:8545"`,
      `      - "127.0.0.1:${node.wsPort}:8546"`,
      "    networks:",
      "      ledger:",
      `        ipv4_address: ${node.ip}`,
      "",
    );
  }
  lines.push("volumes:");
  for (const node of nodes) lines.push(`  ${node.service}-data:`);
  lines.push("");
  return lines.join("\n");
}
