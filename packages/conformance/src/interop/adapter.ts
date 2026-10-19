import {
  type Approval,
  type ChainInstruction,
  contracts,
  deployInterop,
  deployScenario,
  instructionDigest,
  type Network,
  rpcUrlFor,
  sandboxChain,
} from "@oul/chain";
import { type Anvil, localNetwork, startAnvil } from "@oul/chain/testing";
import { type CoordinatorName, type Fault, InteropWorld, runCase } from "@oul/coordinator";
import { parseMoney } from "@oul/domain";
import { depositOf, registryOperator, type Scenario, wholesaleFor } from "@oul/scenario";
import { type Abi, type Address, createPublicClient, decodeFunctionData, type Hex, http, type Log, parseEventLogs, type PublicClient, recoverAddress } from "viem";
import {
  type Capabilities,
  type Directory,
  type EngineAdapter,
  FaultNotApplicable,
  type FaultReport,
  type Observation,
  type Outcome,
} from "../adapter.ts";
import type { CoordinatorFault, FaultStep, KitFlow } from "../flows.ts";
import { ChainObserver, engineId, type Identified, kitId } from "../sandbox/observer.ts";

/**
 * Interop mode's coordinators under the conformance kit (SPEC.md §7, §14):
 * the payment of a scenario's interop block, moved across the shared ledger
 * and a second one by one coordinator (unified, HTLC or notary two-phase
 * commit), under each of §7's faults, on two real ledgers deployed afresh
 * for each run. The kit observes both ledgers: what a lock's claim or
 * commit moved is the instruction's part on that ledger, approved by
 * whoever locked it. Interop runs measure the ledgers, not the banks' books
 * (§7), so this engine keeps none the kit can read.
 *
 * Atomicity must fail exactly where §7 says each coordinator leaves the
 * ledgers disagreeing.
 */

const L1 = "ledger 1";
const L2 = "ledger 2";
const COORDINATOR_FAULTS: readonly CoordinatorFault[] = ["coordinator-crash", "message-loss", "participant-offline", "late-commit"];
const { ConditionalSettlement, SettlementEngine } = contracts;

export interface InteropOptions {
  readonly coordinator: CoordinatorName;
  /** Two fresh Anvils for each run (the default), or the two running networks. */
  readonly chain?: { readonly kind: "anvil" } | { readonly kind: "network"; readonly network1: Network; readonly network2: Network };
  readonly log?: (line: string) => void;
}

let nextChainId = 20_400;

export class InteropAdapter implements EngineAdapter {
  readonly name: string;
  private readonly options: InteropOptions;
  private anvils: Anvil[] = [];
  private world!: InteropWorld;
  private scenario!: Scenario;
  private clients = new Map<string, PublicClient>();
  private observers = new Map<string, ChainObserver>();
  private route: { payerBank: string; payer: string; payeeBank: string; payee: string } | undefined;

  constructor(options: InteropOptions) {
    this.options = options;
    this.name = `interop ${options.coordinator}`;
  }

  get capabilities(): Capabilities {
    const across = (this.scenario?.currencies.length ?? 1) > 1;
    return {
      flows: [across ? "pay-fx" : "pay"],
      faults: COORDINATOR_FAULTS,
      books: false,
      ...(this.route ? { routes: [this.route] } : {}),
    };
  }

  async reset(scenario: Scenario): Promise<Directory> {
    await this.close();
    this.scenario = scenario;
    if (!scenario.interop) throw new Error(`${scenario.id} has no interop ledger`);
    let network1: Network;
    let network2: Network;
    if (this.options.chain?.kind === "network") {
      ({ network1, network2 } = this.options.chain);
    } else {
      // Each pair of chains gets ids of its own: a nonce is kept per address and chain id.
      const chainId = (nextChainId += 2);
      const [a, b] = [startAnvil({ chainId, blockTimeSeconds: 1 }), startAnvil({ chainId: chainId + 1, blockTimeSeconds: 1 })];
      this.anvils = [a, b];
      network1 = { ...localNetwork(scenario, a.rpcUrl), chainId };
      network2 = {
        scenario: scenario.id,
        chainId: chainId + 1,
        nodes: scenario.interop.validators.map((participant) => ({ participant, validator: "0x0000000000000000000000000000000000000000", rpcUrl: b.rpcUrl, wsUrl: "", enode: "" })),
      };
    }
    const { deployment } = await deployScenario(scenario, network1, { force: true });
    const { deployment: interop } = await deployInterop(scenario, { network: network1, deployment }, network2, { force: true });
    const world = InteropWorld.of({ scenario, deployment, interop, network1, network2 });
    this.world = world;
    // Setup, before the kit looks: the payer's bank and the payer funded on ledger 1, the dealer in both ledgers.
    await world.fund(parseMoney(world.currency, "50000.00").minor);

    const operator = registryOperator(scenario).id;
    const client = (network: Network) =>
      createPublicClient({ chain: sandboxChain(network.chainId, rpcUrlFor(network, operator)), transport: http(rpcUrlFor(network, operator), { batch: { batchSize: 256 } }), cacheTime: 0 }) as PublicClient;
    this.clients = new Map([[L1, client(network1)], [L2, client(network2)]]);
    const lower = (a: string) => a.toLowerCase();
    const firstCustomer = (bank: string) => scenario.ledgers.find((l) => l.participant === bank)!.customers[0]!.id;
    this.route = { payerBank: world.payerBank, payer: firstCustomer(world.payerBank), payeeBank: world.payeeBank, payee: firstCustomer(world.payeeBank) };

    const tokens: Record<string, Directory["tokens"][string]> = {};
    for (const [symbol, t] of Object.entries(deployment.tokens)) {
      tokens[symbol] = { symbol, ledger: L1, address: lower(t.address), kind: t.kind, issuer: t.issuer, currency: t.currency };
    }
    for (const [symbol, t] of Object.entries(interop.ledger2.tokens)) {
      tokens[`${symbol}@${L2}`] = { symbol, ledger: L2, address: lower(t.address), kind: t.kind, issuer: t.issuer, currency: t.currency };
    }
    const balance = (ledger: string, symbol: string, holder: string) =>
      this.clients.get(ledger)!.readContract({
        address: (ledger === L1 ? deployment.tokens[symbol] : interop.ledger2.tokens[symbol])!.address,
        abi: contracts.WholesaleToken.abi,
        functionName: "balanceOf",
        args: [holder as Address],
      }) as Promise<bigint>;
    const wholesale: { bank: string; currency: Directory["tokens"][string]["currency"]; amount: bigint }[] = [
      { bank: world.payerBank, currency: world.currency, amount: await balance(L1, wholesaleFor(scenario, world.currency).symbol, world.address(world.payerBank)) },
    ];
    if (world.dealer) {
      const symbol = wholesaleFor(scenario, world.targetCurrency).symbol;
      const [one, two] = [await balance(L1, symbol, world.address(world.dealer)), await balance(L2, symbol, world.address(world.dealer))];
      wholesale.push({ bank: world.dealer, currency: world.targetCurrency, amount: one < two ? one : two });
    }
    const directory: Directory = {
      ledgers: [L1, L2],
      startBlocks: { [L1]: await this.clients.get(L1)!.getBlockNumber(), [L2]: await this.clients.get(L2)!.getBlockNumber() },
      participants: Object.fromEntries(Object.entries(deployment.participants).map(([id, p]) => [id, { address: lower(p.address), kind: p.kind }])),
      customers: Object.fromEntries(Object.entries(deployment.customers).map(([ref, c]) => [ref, { address: lower(c.address), bank: c.bank }])),
      tokens,
      funded: {
        wholesale,
        tokenized: [{ bank: world.payerBank, customer: this.route.payer, amount: await balance(L1, depositOf(scenario, world.payerBank).symbol, world.payer) }],
      },
    };
    const conditional = { [L1]: interop.ledger1.conditional, [L2]: interop.ledger2.conditional };
    const engines = { [L1]: deployment.contracts.engine, [L2]: interop.ledger2.engine };
    const chainIds = { [L1]: network1.chainId, [L2]: network2.chainId };
    for (const [ledger, registry] of [[L1, deployment.contracts.registry], [L2, interop.ledger2.registry]] as const) {
      const settlers = [conditional[ledger]!, ...(engines[ledger] ? [engines[ledger]!] : [])];
      this.observers.set(
        ledger,
        new ChainObserver({
          ledger,
          client: this.clients.get(ledger)!,
          directory,
          registry,
          settlers,
          settlerAbi: [...ConditionalSettlement.abi, ...SettlementEngine.abi] as Abi,
          identify: (tx) => this.identify(ledger, chainIds[ledger]!, engines[ledger], conditional[ledger]!, tx),
        }),
      );
    }
    this.options.log?.(`  deployed ${scenario.id} afresh on two ledgers (chains ${network1.chainId} and ${network2.chainId})`);
    return directory;
  }

  async submit(flow: KitFlow): Promise<Outcome> {
    return this.run(flow, "none");
  }

  async fault(step: FaultStep): Promise<FaultReport> {
    if (!COORDINATOR_FAULTS.includes(step.fault as CoordinatorFault)) throw new FaultNotApplicable(`a coordinator stages no ${step.fault}`);
    const flow = (step as { flow: KitFlow }).flow;
    const outcome = await this.run(flow, step.fault as Fault);
    return { submitted: [{ flow, outcome }], attempts: [], note: outcome.reason ?? outcome.status };
  }

  /** One coordinator case: the payment moved under one fault, to its end on both ledgers. */
  private async run(flow: KitFlow, fault: Fault): Promise<Outcome> {
    if ((flow.kind !== "pay" && flow.kind !== "pay-fx") || !this.route || flow.payerBank !== this.route.payerBank || flow.payeeBank !== this.route.payeeBank) {
      return { status: "refused", reason: `${this.name} moves only ${this.route?.payerBank}'s payments to ${this.route?.payeeBank}` };
    }
    const result = await runCase(this.world, this.options.coordinator, fault, { amount: flow.amount, uetr: flow.id });
    const story = `${result.outcome}: ${Object.entries(result.summary.final).map(([part, state]) => `${part} ${state}`).join(", ")}`;
    this.options.log?.(`    ${this.options.coordinator}/${fault}: ${story}`);
    const quote = this.world.dealer ? { quote: { rate: this.rate(), source: flow.amount, target: this.world.targetOf(flow.amount) } } : {};
    if (result.outcome === "committed" || result.outcome === "inconsistent") return { status: "settled", reason: story, ...quote };
    return { status: "refused", reason: story, ...quote };
  }

  private rate(): string {
    return this.scenario.fx!.rates.find((r) => r.from === this.world.currency && r.to === this.world.targetCurrency)!.rate;
  }

  /**
   * What a transaction settled: through the engine, the instruction and its
   * co-signers; through a conditional settlement's claim or commit, the
   * instruction it locked, approved by whoever locked it and every valid
   * co-signature on the lock.
   */
  private async identify(
    ledger: string,
    chainId: number,
    engine: Address | undefined,
    conditional: Address,
    tx: { hash: Hex; logs: readonly Log[] },
  ): Promise<Identified> {
    const client = this.clients.get(ledger)!;
    const participantAt = (a: string) => Object.entries(this.world.deployment.participants).find(([, p]) => p.address.toLowerCase() === a.toLowerCase())?.[0];
    const approversOf = async (hash: Hex, digest: (input: readonly unknown[]) => Promise<Hex>, abi: Abi) => {
      const sent = await client.getTransaction({ hash });
      const sender = participantAt(sent.from);
      const approvers = sender ? [sender] : [];
      const { args } = decodeFunctionData({ abi, data: sent.input });
      const approvals = (args as readonly unknown[])[1] as readonly Approval[];
      const hashed = await digest(args as readonly unknown[]);
      for (const a of approvals) {
        const signer = await recoverAddress({ hash: hashed, signature: a.signature }).catch(() => undefined);
        const participant = signer && signer.toLowerCase() === a.signer.toLowerCase() ? participantAt(signer) : undefined;
        if (participant && !approvers.includes(participant)) approvers.push(participant);
      }
      return approvers;
    };
    const fromEngine = engine ? engineId(tx.logs, engine) : undefined;
    if (fromEngine) {
      const approvers = await approversOf(tx.hash, async (args) => instructionDigest(chainId, engine!, args[0] as ChainInstruction), SettlementEngine.abi as Abi);
      return { id: kitId(fromEngine), approvers };
    }
    const settled = parseEventLogs({ abi: ConditionalSettlement.abi, logs: tx.logs as Log[], eventName: "Settled", strict: false }).find(
      (e) => e.address.toLowerCase() === conditional.toLowerCase(),
    );
    const id = (settled?.args as { id?: Hex } | undefined)?.id;
    if (!id) {
      const sent = await client.getTransaction({ hash: tx.hash });
      const sender = participantAt(sent.from);
      return { id: null, approvers: sender ? [sender] : [] };
    }
    const [locked] = await client.getContractEvents({ address: conditional, abi: ConditionalSettlement.abi, eventName: "Locked", args: { id }, fromBlock: 0n });
    const approvers = locked?.transactionHash
      ? await approversOf(
          locked.transactionHash,
          (args) =>
            client.readContract({ address: conditional, abi: ConditionalSettlement.abi, functionName: "digest", args: [args[0], args[2]] as never, blockNumber: locked.blockNumber! }) as Promise<Hex>,
          ConditionalSettlement.abi as Abi,
        )
      : [];
    return { id: kitId(id), approvers };
  }

  head(ledger: string): Promise<bigint> {
    return this.clients.get(ledger)!.getBlockNumber();
  }

  observe(ledger: string, block: bigint): Promise<Observation> {
    return this.observers.get(ledger)!.observe(block);
  }

  async quiesce(): Promise<void> {}

  async close(): Promise<void> {
    for (const anvil of this.anvils) anvil.stop();
    this.anvils = [];
    this.observers.clear();
  }
}
