import { minorUnit } from "@oul/domain";
import { centralBanks, registryOperator, type Scenario } from "@oul/scenario";
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
import { type Deployment, readDeployment } from "./deployment.ts";
import { custodyAddress, customerAddress, devKeys, participantIdHash } from "./dev-keys.ts";
import { onChainTerms } from "./bond.ts";
import { type BondRegulation, ECDSA_SCHEME, type IdentityDeployment, KYC_TOPIC, kycData, signClaim } from "./erc3643.ts";
import {
  Bond,
  ClaimIssuer,
  ClaimTopicsRegistry,
  DepositToken,
  Identity,
  IdentityRegistry,
  IdentityRegistryStorage,
  ModularCompliance,
  ParticipantRegistry,
  SettlementEngine,
  SettlementOnlyModule,
  TrustedIssuersRegistry,
  WholesaleToken,
} from "./generated/contracts.ts";
import { type Network, rpcUrlFor, sandboxChain, ZERO_FEES } from "./network.ts";

/**
 * Deploy a scenario's contracts to the sandbox network and wire them
 * together (SPEC.md §4.2, §13): the registry, operated by the first central
 * bank, with every other central bank and every bank admitted; each
 * currency's wholesale token, deployed and listed by its own central bank,
 * which opens a reserve account for each bank holding that currency; the
 * settlement engine; one deposit token per bank with its customers
 * allowlisted; the engine's settlement role on every token; and each bond
 * deployed by its issuing and paying agent with its terms. Each participant
 * deploys and administers its own contracts with its own key.
 */

interface Signer {
  readonly id: string;
  readonly wallet: WalletClient;
  readonly address: Address;
}

export interface DeployOptions {
  /** Redeploy even if the scenario's recorded deployment is still on chain. */
  readonly force?: boolean;
  readonly log?: (message: string) => void;
  /**
   * The block the network must reach before deploying: 1 for QBFT, which
   * produces blocks on a timer; 0 for a chain that mines on demand (Anvil).
   */
  readonly readyAtBlock?: bigint;
  /**
   * Contracts to deploy in place of the settlement engine or the deposit
   * tokens: the conformance kit's broken engines (SPEC.md §14) and nothing
   * else. Each takes the same constructor arguments as what it replaces.
   */
  readonly replace?: {
    readonly engine?: { readonly abi: Abi; readonly bytecode: Hex };
    readonly deposit?: { readonly abi: Abi; readonly bytecode: Hex };
  };
}

export async function deployScenario(
  scenario: Scenario,
  network: Network,
  options: DeployOptions = {},
): Promise<{ deployment: Deployment; reused: boolean }> {
  const log = options.log ?? (() => {});
  const operator = registryOperator(scenario);
  const banks = scenario.participants.filter((p) => p.kind === "bank");

  const chainFor = (participantId: string) => sandboxChain(network.chainId, rpcUrlFor(network, participantId));
  const client = createPublicClient({ chain: chainFor(operator.id), transport: http() }) as PublicClient;

  await waitForBlocks(client, log, options.readyAtBlock ?? 1n);

  const existing = await readDeployment(scenario.id);
  if (existing && !options.force && existing.chainId === network.chainId && existing.startBlockHash) {
    const block = await client.getBlock({ blockNumber: BigInt(existing.startBlock) }).catch(() => undefined);
    if (block?.hash === existing.startBlockHash) {
      log(`Reusing the deployment of ${scenario.id} recorded in deployments/${scenario.id}.json`);
      return { deployment: existing, reused: true };
    }
  }

  // Nonces read from this chain, for this deployment: the sandbox's keys repeat across scenarios, and a
  // process deploying a second scenario on a fresh network must not carry the first chain's nonces over.
  const nonces = createNonceManager({ source: jsonRpc() });
  const signer = (participantId: string): Signer => {
    const account = privateKeyToAccount(devKeys.participant(participantId), { nonceManager: nonces });
    const chain = chainFor(participantId);
    return { id: participantId, address: account.address, wallet: createWalletClient({ account, chain, transport: http() }) };
  };
  const cb = signer(operator.id);
  const cbSigners = new Map(centralBanks(scenario).map((p) => [p.id, p.id === cb.id ? cb : signer(p.id)]));
  const bankSigners = new Map(banks.map((b) => [b.id, signer(b.id)]));
  const start = await client.getBlock();
  const startBlock = start.number;

  const deploy = async (from: Signer, contract: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) => {
    const hash = await from.wallet.deployContract({
      abi: contract.abi,
      bytecode: contract.bytecode,
      args,
      account: from.wallet.account!,
      chain: from.wallet.chain,
      ...ZERO_FEES,
    });
    const receipt = await confirm(client, hash);
    if (!receipt.contractAddress) throw new Error(`Deployment ${hash} created no contract`);
    return receipt.contractAddress;
  };
  const call = (from: Signer, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    from.wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      account: from.wallet.account!,
      chain: from.wallet.chain,
      ...ZERO_FEES,
    });

  log(`Deploying ${scenario.id} to chain ${network.chainId} from block ${startBlock}`);
  const registry = await deploy(cb, ParticipantRegistry, [participantIdHash(cb.id), cb.address]);
  log(`  ParticipantRegistry ${registry} (operated by ${cb.id})`);
  const others = [...cbSigners.values()].filter((s) => s !== cb);
  await confirmAll(client, [
    ...others.map((s) => call(cb, registry, ParticipantRegistry.abi, "admitCentralBank", [participantIdHash(s.id), s.address])),
    ...banks.map((b) =>
      call(cb, registry, ParticipantRegistry.abi, "admitBank", [participantIdHash(b.id), bankSigners.get(b.id)!.address]),
    ),
  ]);
  log(`  admitted ${[...others.map((s) => s.id), ...banks.map((b) => b.id)].join(", ")}`);

  const { wholesale: wholesaleSpecs, deposits } = scenario.instruments;
  const [engine, ...wholesales] = await Promise.all([
    deploy(cb, options.replace?.engine ?? SettlementEngine, [registry]),
    ...wholesaleSpecs.map((spec) =>
      deploy(cbSigners.get(spec.issuer)!, WholesaleToken, [
        `Wholesale ${spec.currency}`,
        spec.symbol,
        minorUnit(spec.currency),
        registry,
        participantIdHash(spec.issuer),
      ]),
    ),
  ]);
  log(`  SettlementEngine ${engine}`);
  const settlementRole = (await client.readContract({
    address: wholesales[0]!,
    abi: WholesaleToken.abi,
    functionName: "SETTLEMENT_ROLE",
  })) as Hex;

  const tokens: Record<string, Deployment["tokens"][string]> = {};
  const customers: Record<string, Deployment["customers"][string]> = {};
  const wiring: Promise<Hash>[] = [];
  for (const [index, spec] of wholesaleSpecs.entries()) {
    const address = wholesales[index]!;
    const issuer = cbSigners.get(spec.issuer)!;
    tokens[spec.symbol] = { address, kind: "wholesale", issuer: spec.issuer, currency: spec.currency };
    log(`  WholesaleToken ${spec.symbol} ${address} (issuer ${spec.issuer})`);
    wiring.push(call(issuer, address, WholesaleToken.abi, "grantRole", [settlementRole, engine]));
    // Each central bank lists its own currency and decides which banks hold it.
    wiring.push(call(issuer, registry, ParticipantRegistry.abi, "listToken", [address]));
    for (const bank of banks.filter((b) => b.reserves.includes(spec.currency))) {
      wiring.push(call(issuer, address, WholesaleToken.abi, "openReserveAccount", [participantIdHash(bank.id)]));
    }
  }

  const depositAddresses = await Promise.all(
    deposits.map(async (spec) => {
      const bank = scenario.participants.find((p) => p.id === spec.issuer)!;
      const address = await deploy(bankSigners.get(bank.id)!, options.replace?.deposit ?? DepositToken, [
        `${bank.name} deposit ${spec.currency}`,
        spec.symbol,
        minorUnit(spec.currency),
        registry,
        participantIdHash(bank.id),
      ]);
      log(`  DepositToken ${spec.symbol} ${address}`);
      return [spec, address] as const;
    }),
  );

  // ERC-3643 (SPEC.md §15): with bonds, each trusted issuer (the central bank for the banks, each bank for its
  // own customers) gets a claim issuer identity, and each bank an identity carrying the central bank's KYC claim.
  let identityDeployment: IdentityDeployment | undefined;
  if (scenario.instruments.bonds.length > 0) {
    const claimIssuers: Record<string, Address> = {};
    const identities: Record<string, { address: Address; manager: string }> = {};
    await Promise.all([
      deploy(cb, ClaimIssuer, [registry, cb.address]).then((a) => (claimIssuers[cb.id] = a)),
      ...banks.map(async (b) => {
        const bank = bankSigners.get(b.id)!;
        claimIssuers[b.id] = await deploy(bank, ClaimIssuer, [registry, bank.address]);
        identities[b.id] = { address: await deploy(bank, Identity, [registry, bank.address]), manager: b.id };
      }),
    ]);
    const cbAccount = privateKeyToAccount(devKeys.participant(cb.id));
    await confirmAll(
      client,
        banks.map(async (b) => {
          const identity = identities[b.id]!.address;
          const data = kycData(cb.id, b.id);
          const signature = await signClaim(cbAccount, identity, KYC_TOPIC, data);
          return call(bankSigners.get(b.id)!, identity, Identity.abi, "addClaim", [KYC_TOPIC, ECDSA_SCHEME, claimIssuers[cb.id], signature, data, ""]);
        }),
    );
    identityDeployment = { identities, claimIssuers };
    log(`  ERC-3643: claim issuers for ${Object.keys(claimIssuers).join(", ")}; ${banks.length} bank identities, each with ${cb.id}'s KYC claim`);
  }

  const regulations = new Map<string, BondRegulation>();
  const bondAddresses = await Promise.all(
    scenario.instruments.bonds.map(async (spec) => {
      const agent = bankSigners.get(spec.agent)!;
      const issuerName = scenario.participants.find((p) => p.id === spec.issuer)?.name ?? spec.issuer;
      const regulation = await deployRegulation(agent, identityDeployment!);
      regulations.set(spec.symbol, regulation);
      const address = await deploy(agent, Bond, [
        spec.name,
        spec.symbol,
        registry,
        participantIdHash(spec.agent),
        issuerName,
        onChainTerms(spec.currency, spec),
        { identityRegistry: regulation.identityRegistry, compliance: regulation.compliance, onchainID: regulation.onchainID },
      ]);
      // The compliance decides for this bond; the bond registers a recovered wallet's identity itself; every bank
      // but the agent, which may not hold the bond it pays, is registered with its identity.
      await confirmAll(client, [
        call(agent, regulation.compliance, ModularCompliance.abi, "bindToken", [address]),
        call(agent, regulation.identityRegistry, IdentityRegistry.abi, "addAgent", [address]),
        ...banks
          .filter((b) => b.id !== spec.agent)
          .map((b) =>
            call(agent, regulation.identityRegistry, IdentityRegistry.abi, "registerIdentity", [
              bankSigners.get(b.id)!.address,
              identityDeployment!.identities[b.id]!.address,
              scenario.country!,
            ]),
          ),
      ]);
      log(`  Bond ${spec.symbol} ${address} (agent ${spec.agent}; ERC-3643 identity registry ${regulation.identityRegistry}, compliance ${regulation.compliance})`);
      return [spec, address] as const;
    }),
  );

  /** A bond's identity registry, claim topics (KYC), trusted issuers and compliance, deployed and owned by its agent. */
  async function deployRegulation(agent: Signer, ids: IdentityDeployment): Promise<BondRegulation> {
    const [claimTopics, trustedIssuers, identityStorage, compliance, settlementOnly, onchainID] = await Promise.all([
      deploy(agent, ClaimTopicsRegistry, [registry, agent.address]),
      deploy(agent, TrustedIssuersRegistry, [registry, agent.address]),
      deploy(agent, IdentityRegistryStorage, [registry, agent.address]),
      deploy(agent, ModularCompliance, [registry, agent.address]),
      deploy(agent, SettlementOnlyModule, []),
      deploy(agent, Identity, [registry, agent.address]),
    ]);
    const identityRegistry = await deploy(agent, IdentityRegistry, [registry, agent.address, trustedIssuers, claimTopics, identityStorage]);
    await confirmAll(client, [
      call(agent, claimTopics, ClaimTopicsRegistry.abi, "addClaimTopic", [KYC_TOPIC]),
      ...Object.values(ids.claimIssuers).map((issuer) => call(agent, trustedIssuers, TrustedIssuersRegistry.abi, "addTrustedIssuer", [issuer, [KYC_TOPIC]])),
      call(agent, identityStorage, IdentityRegistryStorage.abi, "bindIdentityRegistry", [identityRegistry]),
      call(agent, identityRegistry, IdentityRegistry.abi, "addAgent", [agent.address]),
      call(agent, compliance, ModularCompliance.abi, "addModule", [settlementOnly]),
    ]);
    return { identityRegistry, identityStorage, claimTopics, trustedIssuers, compliance, settlementOnly, onchainID };
  }

  for (const [spec, address] of bondAddresses) {
    tokens[spec.symbol] = { address, kind: "bond", issuer: spec.agent, currency: spec.currency, regulation: regulations.get(spec.symbol)! };
    wiring.push(call(bankSigners.get(spec.agent)!, address, Bond.abi, "grantRole", [settlementRole, engine]));
  }

  // Client custody (SPEC.md §15): each custodian's omnibus wallet is a holding address of the custodian,
  // registered for every bond with the custodian's identity; each client gets an identity its bank attests
  // (KYC), registered at the client's own address so the bank can check it before taking the client's position.
  const custody: Record<string, { wallet: Address; clients: string[] }> = {};
  for (const { bank: bankId, clients } of scenario.custody) {
    const bank = bankSigners.get(bankId)!;
    const wallet = custodyAddress(bankId);
    custody[bankId] = { wallet, clients: [...clients] };
    const bankAccount = privateKeyToAccount(devKeys.participant(bankId));
    const clientIdentities = await Promise.all(clients.map(async (client) => [client, await deploy(bank, Identity, [registry, bank.address])] as const));
    await confirmAll(client, [
      call(cb, registry, ParticipantRegistry.abi, "bindHoldingAddress", [participantIdHash(bankId), wallet]),
      ...clientIdentities.map(async ([clientId, identity]) => {
        const data = kycData(bankId, `${bankId}/${clientId}`);
        const signature = await signClaim(bankAccount, identity, KYC_TOPIC, data);
        return call(bank, identity, Identity.abi, "addClaim", [KYC_TOPIC, ECDSA_SCHEME, identityDeployment!.claimIssuers[bankId], signature, data, ""]);
      }),
    ]);
    for (const [clientId, identity] of clientIdentities) {
      (identityDeployment!.identities as Record<string, { address: Address; manager: string }>)[`${bankId}/${clientId}`] = { address: identity, manager: bankId };
    }
    await confirmAll(
      client,
      scenario.instruments.bonds.flatMap((spec) => {
        const agent = bankSigners.get(spec.agent)!;
        const identityRegistry = regulations.get(spec.symbol)!.identityRegistry;
        return [
          call(agent, identityRegistry, IdentityRegistry.abi, "registerIdentity", [wallet, identityDeployment!.identities[bankId]!.address, scenario.country!]),
          ...clientIdentities.map(([clientId, identity]) =>
            call(agent, identityRegistry, IdentityRegistry.abi, "registerIdentity", [customerAddress(bankId, clientId), identity, scenario.country!]),
          ),
        ];
      }),
    );
    log(`  custody: ${bankId}'s omnibus ${wallet}, holding for ${clients.join(", ")}, each with ${bankId}'s KYC claim`);
  }
  for (const [spec, address] of depositAddresses) {
    const bank = bankSigners.get(spec.issuer)!;
    tokens[spec.symbol] = { address, kind: "deposit", issuer: spec.issuer, currency: spec.currency };
    wiring.push(call(bank, address, DepositToken.abi, "grantRole", [settlementRole, engine]));
    const books = scenario.ledgers.find((l) => l.participant === spec.issuer);
    for (const customer of books?.customers ?? []) {
      const holder = customerAddress(spec.issuer, customer.id);
      customers[`${spec.issuer}/${customer.id}`] = { address: holder, bank: spec.issuer };
      wiring.push(call(bank, address, DepositToken.abi, "allowHolder", [holder]));
    }
  }
  for (const token of Object.values(tokens)) {
    if (token.kind !== "wholesale") wiring.push(call(cb, registry, ParticipantRegistry.abi, "listToken", [token.address]));
  }
  await confirmAll(client, wiring);
  const accounts = banks.reduce((n, b) => n + b.reserves.length, 0);
  log(`  wired: settlement role granted, ${accounts} reserve accounts opened, ${Object.keys(customers).length} customers allowlisted, ${Object.keys(tokens).length} tokens listed`);

  const deployment: Deployment = {
    scenario: scenario.id,
    chainId: network.chainId,
    deployedAt: new Date().toISOString(),
    startBlock: startBlock.toString(),
    startBlockHash: start.hash,
    contracts: { registry, engine },
    tokens,
    participants: Object.fromEntries(
      [...centralBanks(scenario), ...banks].map((p) => [
        p.id,
        {
          address: (cbSigners.get(p.id) ?? bankSigners.get(p.id))!.address,
          idHash: participantIdHash(p.id),
          kind: p.kind as "central-bank" | "bank",
        },
      ]),
    ),
    customers,
    ...(identityDeployment ? { identity: identityDeployment } : {}),
    ...(Object.keys(custody).length > 0 ? { custody } : {}),
  };
  return { deployment, reused: false };
}

async function confirm(client: PublicClient, hash: Hash) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}

async function confirmAll(client: PublicClient, sends: Promise<Hash>[]) {
  const hashes = await Promise.all(sends);
  await Promise.all(hashes.map((hash) => confirm(client, hash)));
}

/** Wait until the network is producing blocks. */
export async function waitForBlocks(
  client: PublicClient,
  log: (m: string) => void,
  readyAtBlock = 1n,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      if ((await client.getBlockNumber()) >= readyAtBlock) return;
    } catch {
      // The node is not up yet.
    }
    if (!announced) {
      log("Waiting for the network to produce blocks...");
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The network produced no blocks within ${timeoutMs / 1000}s`);
}
