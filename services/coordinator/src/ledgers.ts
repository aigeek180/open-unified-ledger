import {
  type Approval,
  approve,
  type ChainInstruction,
  type ChainLeg,
  contracts,
  customerAddress,
  type Deployment,
  devKeys,
  type InteropDeployment,
  leg,
  type Network,
  readDeployment,
  readInteropDeployment,
  readInteropNetwork,
  readNetwork,
  rpcUrlFor,
  sandboxChain,
  uetrToId,
  ZERO_FEES,
} from "@oul/chain";
import { convert, type CurrencyCode, money } from "@oul/domain";
import { centralBankFor, dealerOf, depositOf, fxRate, registryOperator, type Scenario, wholesaleFor } from "@oul/scenario";
import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { ConditionalSettlement, SettlementEngine, DepositToken } = contracts;

/** A lock's state as the contract records it (ConditionalSettlement.State). */
export type LockState = "none" | "locked" | "settled" | "released";
const STATES: readonly LockState[] = ["none", "locked", "settled", "released"];

export interface LockView {
  readonly state: LockState;
  readonly timeout: bigint;
}

/** What sending a transaction came to: mined in a block, or refused with the contract's reason. */
export type Sent = { readonly ok: true; readonly block: bigint } | { readonly ok: false; readonly reason: string };

/** One ledger, as interop mode uses it: its chain, its conditional settlement, each participant's wallet. */
export class Ledger {
  readonly name: "ledger 1" | "ledger 2";
  readonly network: Network;
  readonly client: PublicClient;
  readonly conditional: Address;
  private readonly wallets = new Map<string, WalletClient>();
  /** Each participant's next nonce on this ledger, and the queue its submissions go through. */
  private readonly nonces = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(name: "ledger 1" | "ledger 2", network: Network, conditional: Address, viaParticipant: string) {
    this.name = name;
    this.network = network;
    this.conditional = conditional;
    this.client = createPublicClient({
      chain: sandboxChain(network.chainId, rpcUrlFor(network, viaParticipant)),
      transport: http(),
      cacheTime: 0,
      // Receipts and blocks within half a block period, so the narrative keeps pace with the ledger.
      pollingInterval: 500,
    }) as PublicClient;
  }

  private wallet(participant: string): WalletClient {
    let wallet = this.wallets.get(participant);
    if (!wallet) {
      wallet = createWalletClient({
        account: privateKeyToAccount(devKeys.participant(participant)),
        chain: sandboxChain(this.network.chainId, rpcUrlFor(this.network, participant)),
        transport: http(),
      });
      this.wallets.set(participant, wallet);
    }
    return wallet;
  }

  /** The latest block's timestamp: the clock every timeout is measured against. */
  async now(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }

  /** Wait until this ledger's clock reaches `time`. */
  async until(time: bigint, isCancelled: () => boolean = () => false): Promise<void> {
    while (!isCancelled() && (await this.now()) < time) await sleep(500);
  }

  /**
   * Simulate, then send and wait for the receipt. A refusal at simulation is
   * returned with the contract's reason; a transaction that passed simulation
   * but reverted when mined (a race with the clock) is returned too.
   */
  async send(participant: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Sent> {
    const wallet = this.wallet(participant);
    try {
      await this.client.simulateContract({ address, abi, functionName, args, account: wallet.account! });
    } catch (error) {
      return { ok: false, reason: revertName(error) ?? (error as Error).message.split("\n")[0]! };
    }
    // Cases run at once and one party may send several transactions together: nonces are assigned
    // here, one submission at a time per participant, and read again from the chain if a send fails.
    const hash = await this.serially(participant, async () => {
      const nonce = this.nonces.get(participant) ?? (await this.client.getTransactionCount({ address: wallet.account!.address, blockTag: "pending" }));
      try {
        const sent = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account!, chain: wallet.chain, nonce, ...ZERO_FEES } as never);
        this.nonces.set(participant, nonce + 1);
        return sent;
      } catch (error) {
        this.nonces.delete(participant);
        throw error;
      }
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") return { ok: false, reason: `reverted when mined in block ${receipt.blockNumber}` };
    return { ok: true, block: receipt.blockNumber };
  }

  private serially<T>(participant: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(participant) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(participant, next);
    return next;
  }

  lock(participant: string, instruction: ChainInstruction, condition: Condition, approvals: readonly Approval[] = []): Promise<Sent> {
    return this.send(participant, this.conditional, ConditionalSettlement.abi, "lock", [
      { ...instruction, legs: [...instruction.legs] },
      [...approvals],
      condition,
    ]);
  }

  /** A participant's EIP-712 approval of locking `instruction` under `condition` on this ledger. */
  async lockApproval(participant: string, instruction: ChainInstruction, condition: Condition): Promise<Approval> {
    const hash = (await this.client.readContract({
      address: this.conditional,
      abi: ConditionalSettlement.abi,
      functionName: "digest",
      args: [{ ...instruction, legs: [...instruction.legs] }, condition],
    })) as Hex;
    const account = privateKeyToAccount(devKeys.participant(participant));
    return { signer: account.address, signature: await account.sign({ hash }) };
  }

  claim(participant: string, id: Hex, preimage: Hex): Promise<Sent> {
    return this.send(participant, this.conditional, ConditionalSettlement.abi, "claim", [id, preimage]);
  }

  commit(notary: string, id: Hex): Promise<Sent> {
    return this.send(notary, this.conditional, ConditionalSettlement.abi, "commit", [id]);
  }

  abort(notary: string, id: Hex): Promise<Sent> {
    return this.send(notary, this.conditional, ConditionalSettlement.abi, "abort", [id]);
  }

  refund(participant: string, id: Hex): Promise<Sent> {
    return this.send(participant, this.conditional, ConditionalSettlement.abi, "refund", [id]);
  }

  async lockOf(id: Hex): Promise<LockView> {
    const lock = (await this.client.readContract({
      address: this.conditional,
      abi: ConditionalSettlement.abi,
      functionName: "lockOf",
      args: [id],
    })) as { state: number; timeout: bigint };
    return { state: STATES[lock.state]!, timeout: lock.timeout };
  }

  /** The preimage a hashlock claim published on this ledger, once one has. */
  async publishedPreimage(id: Hex): Promise<Hex | undefined> {
    const logs = await this.client.getContractEvents({
      address: this.conditional,
      abi: ConditionalSettlement.abi,
      eventName: "Settled",
      args: { id },
      fromBlock: 0n,
    });
    return (logs[0]?.args as { preimage?: Hex } | undefined)?.preimage;
  }

  balanceOf(token: Address, holder: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: DepositToken.abi, functionName: "balanceOf", args: [holder] }) as Promise<bigint>;
  }
}

export interface Condition {
  readonly kind: 0 | 1;
  readonly hashlock: Hex;
  readonly notary: Address;
  readonly timeout: bigint;
}

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const NO_NOTARY = "0x0000000000000000000000000000000000000000" as Address;

export const hashlockCondition = (hashlock: Hex, timeout: bigint): Condition => ({ kind: 0, hashlock, notary: NO_NOTARY, timeout });
export const notaryCondition = (notary: Address, timeout: bigint): Condition => ({ kind: 1, hashlock: ZERO32, notary, timeout });

/** One interbank payment, as interop mode moves it. */
export interface Transfer {
  readonly uetr: string;
  readonly id: Hex;
  /** Minor units of the payer's currency. */
  readonly amount: bigint;
  /** Minor units of the payee's currency: the same as `amount` in one currency, at the dealer's rate across two. */
  readonly target: bigint;
}

/**
 * Everything a run needs: both ledgers, the parties, and the legs of an
 * interbank transfer, either whole on the shared ledger (unified) or split:
 * the payer's burn and the wholesale transfer on ledger 1, the payee's mint
 * on ledger 2 (SPEC.md §7). In a scenario of two currencies (SPEC.md §13)
 * the payment crosses them through the dealer and splits by currency: the
 * payer's burn and its bank's wholesale to the dealer on ledger 1, the
 * dealer's wholesale to the payee's bank and the payee's mint on ledger 2,
 * which the dealer locks with the payee's bank's co-signature.
 */
export class InteropWorld {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
  readonly interop: InteropDeployment;
  readonly l1: Ledger;
  readonly l2: Ledger;
  readonly centralBank: string;
  /** The payer's currency, and the payee's: one, or two across which the dealer exchanges. */
  readonly currency: CurrencyCode;
  readonly targetCurrency: CurrencyCode;
  readonly payerBank: string;
  readonly payeeBank: string;
  /** Across currencies, the dealer; otherwise none. */
  readonly dealer: string | undefined;
  /**
   * Who locks ledger 2's part, and claims ledger 1's in an HTLC: the payee's
   * bank, or across currencies the dealer, whose wholesale ledger 2's part
   * moves.
   */
  readonly counterparty: string;
  readonly notary: { readonly id: string; readonly address: Address };
  readonly payer: Address;
  readonly payee: Address;
  private readonly tokens: {
    wholesale1: Address;
    payerDeposit: Address;
    payeeDeposit1: Address;
    payeeDeposit2: Address;
    /** Across currencies: the target currency's wholesale on the shared ledger, and on ledger 2. */
    targetWholesale1?: Address;
    targetWholesale2?: Address;
  };

  private constructor(init: WorldInit) {
    const { scenario, deployment, interop } = init;
    this.scenario = scenario;
    this.deployment = deployment;
    this.interop = interop;
    this.centralBank = registryOperator(scenario).id;
    const symbol = scenario.interop!.deposits[0]!;
    this.payeeBank = interop.ledger2.tokens[symbol]!.issuer;
    this.targetCurrency = depositOf(scenario, this.payeeBank).currency;
    const across = scenario.currencies.length > 1;
    this.dealer = across ? dealerOf(scenario) : undefined;
    this.payerBank = scenario.participants.find(
      (p) => p.kind === "bank" && p.id !== this.payeeBank && p.id !== this.dealer && (across || depositOf(scenario, p.id).currency === this.targetCurrency),
    )!.id;
    this.currency = depositOf(scenario, this.payerBank).currency;
    this.counterparty = this.dealer ?? this.payeeBank;
    this.notary = interop.notary;
    const firstCustomer = (bank: string) => scenario.ledgers.find((l) => l.participant === bank)!.customers[0]!.id;
    this.payer = customerAddress(this.payerBank, firstCustomer(this.payerBank));
    this.payee = customerAddress(this.payeeBank, firstCustomer(this.payeeBank));
    const token = (s: string) => deployment.tokens[s]!.address;
    const targetWholesale = across ? wholesaleFor(scenario, this.targetCurrency).symbol : undefined;
    this.tokens = {
      wholesale1: token(wholesaleFor(scenario, this.currency).symbol),
      payerDeposit: token(depositOf(scenario, this.payerBank).symbol),
      payeeDeposit1: token(depositOf(scenario, this.payeeBank).symbol),
      payeeDeposit2: interop.ledger2.tokens[symbol]!.address,
      ...(targetWholesale ? { targetWholesale1: token(targetWholesale), targetWholesale2: interop.ledger2.tokens[targetWholesale]!.address } : {}),
    };
    this.l1 = new Ledger("ledger 1", init.network1, interop.ledger1.conditional, this.centralBank);
    this.l2 = new Ledger("ledger 2", init.network2, interop.ledger2.conditional, this.centralBank);
  }

  /** A world over deployments already read, for a runner that has them, or a test. */
  static of(init: WorldInit): InteropWorld {
    return new InteropWorld(init);
  }

  /** Whether the payment crosses two currencies through the dealer (SPEC.md §13). */
  get acrossCurrencies(): boolean {
    return this.dealer !== undefined;
  }

  /** What the payee's bank is paid for `amount` of the payer's currency: the same, or at the dealer's rate. */
  targetOf(amount: bigint): bigint {
    if (!this.dealer) return amount;
    const rate = fxRate(this.scenario, this.currency, this.targetCurrency);
    if (!rate) throw new Error(`The dealer quotes no rate from ${this.currency} to ${this.targetCurrency}`);
    return convert(money(this.currency, amount), rate, this.targetCurrency).minor;
  }

  /** The participants whose name a narrative uses: the payer's bank, the counterparty on ledger 2, the payee's bank. */
  nameOf(participant: string): string {
    return this.scenario.participants.find((p) => p.id === participant)?.name ?? participant;
  }

  static async open(scenario: Scenario): Promise<InteropWorld> {
    const deployment = await readDeployment(scenario.id);
    const interop = await readInteropDeployment(scenario.id);
    if (!deployment || !interop) {
      throw new Error(`Deploy both ledgers first: pnpm deploy ${scenario.id} && pnpm interop:deploy ${scenario.id}`);
    }
    if (interop.ledger1.startBlockHash !== deployment.startBlockHash) {
      throw new Error(`The interop deployment belongs to an older deployment of ${scenario.id}: run pnpm interop:deploy ${scenario.id}`);
    }
    return new InteropWorld({ scenario, deployment, interop, network1: await readNetwork(), network2: await readInteropNetwork() });
  }

  /** The central bank of the target currency, on ledger 2: what funds the dealer's reserves there. */
  get targetCentralBank(): string {
    return centralBankFor(this.scenario, this.targetCurrency).id;
  }

  address(participant: string): Address {
    return this.deployment.participants[participant]!.address;
  }

  /**
   * Ledger 1's part: burn the payer's deposit, move wholesale from the payer's bank to the payee's, or
   * across currencies to the dealer.
   */
  ledger1Legs(t: Transfer): ChainLeg[] {
    return [
      leg.burn(this.tokens.payerDeposit, this.payer, t.amount),
      leg.transfer(this.tokens.wholesale1, this.address(this.payerBank), this.address(this.counterparty), t.amount),
    ];
  }

  /** Ledger 2's part: mint the payee's deposit at its bank; across currencies, after the dealer's wholesale moves to it. */
  ledger2Legs(t: Transfer): ChainLeg[] {
    const mint = leg.mint(this.tokens.payeeDeposit2, this.payee, t.target);
    if (!this.dealer) return [mint];
    return [leg.transfer(this.tokens.targetWholesale2!, this.address(this.dealer), this.address(this.payeeBank), t.target), mint];
  }

  /**
   * The unified baseline: every leg on the shared ledger (SPEC.md §5.3), three, or four across
   * currencies (SPEC.md §13).
   */
  unifiedLegs(t: Transfer): ChainLeg[] {
    const mint = leg.mint(this.tokens.payeeDeposit1, this.payee, t.target);
    if (!this.dealer) return [...this.ledger1Legs(t), mint];
    return [...this.ledger1Legs(t), leg.transfer(this.tokens.targetWholesale1!, this.address(this.dealer), this.address(this.payeeBank), t.target), mint];
  }

  /** Who must co-sign ledger 2's lock besides the one who sends it: across currencies, the payee's bank. */
  ledger2Approvals(instruction: ChainInstruction, condition: Condition): Promise<Approval[]> {
    return this.dealer ? this.l2.lockApproval(this.payeeBank, instruction, condition).then((a) => [a]) : Promise.resolve([]);
  }

  instruction(t: Transfer, legs: ChainLeg[], deadline: bigint): ChainInstruction {
    return { id: t.id, legs, deadline };
  }

  /**
   * The signatures a unified instruction needs besides its sender's: the payee's bank's, since the mint
   * creates its liability, and across currencies the dealer's first, since its wholesale leaves it.
   */
  unifiedApprovals(instruction: ChainInstruction): Promise<Approval[]> {
    const sign = (id: string) => approve(privateKeyToAccount(devKeys.participant(id)), this.l1.network.chainId, this.deployment.contracts.engine, instruction);
    return Promise.all([...(this.dealer ? [this.dealer] : []), this.payeeBank].map(sign));
  }

  /** Settle on the shared ledger through the engine, at once. */
  settle(submitter: string, instruction: ChainInstruction, approvals: readonly Approval[]): Promise<Sent> {
    return this.l1.send(submitter, this.deployment.contracts.engine, SettlementEngine.abi, "settle", [
      { ...instruction, legs: [...instruction.legs] },
      [...approvals],
    ]);
  }

  async settledAt(id: Hex): Promise<bigint> {
    return (await this.l1.client.readContract({
      address: this.deployment.contracts.engine,
      abi: SettlementEngine.abi,
      functionName: "settledAt",
      args: [id],
    })) as bigint;
  }

  /**
   * Make sure the payer's bank has wholesale and the payer deposit tokens to
   * pay with, on ledger 1, and across currencies that the dealer holds the
   * target currency's wholesale on both ledgers: topping up through each
   * ledger's engine as its central bank and the bank would.
   */
  async fund(atLeast: bigint): Promise<void> {
    const topUp = async (ledger: Ledger, engine: Address, submitter: string, legs: ChainLeg[]) => {
      const now = await ledger.now();
      const sent = await ledger.send(submitter, engine, SettlementEngine.abi, "settle", [{ id: uetrToId(crypto.randomUUID()), legs, deadline: now + 600n }, []]);
      if (!sent.ok) throw new Error(`Funding failed: ${sent.reason}`);
    };
    const engine1 = this.deployment.contracts.engine;
    const payerCb = centralBankFor(this.scenario, this.currency).id;
    if ((await this.l1.balanceOf(this.tokens.wholesale1, this.address(this.payerBank))) < atLeast) {
      await topUp(this.l1, engine1, payerCb, [leg.mint(this.tokens.wholesale1, this.address(this.payerBank), atLeast * 10n)]);
    }
    if ((await this.l1.balanceOf(this.tokens.payerDeposit, this.payer)) < atLeast) {
      await topUp(this.l1, engine1, this.payerBank, [leg.mint(this.tokens.payerDeposit, this.payer, atLeast * 10n)]);
    }
    if (!this.dealer) return;
    const target = this.targetOf(atLeast);
    const dealer = this.address(this.dealer);
    if ((await this.l1.balanceOf(this.tokens.targetWholesale1!, dealer)) < target) {
      await topUp(this.l1, engine1, this.targetCentralBank, [leg.mint(this.tokens.targetWholesale1!, dealer, target * 10n)]);
    }
    if ((await this.l2.balanceOf(this.tokens.targetWholesale2!, dealer)) < target) {
      await topUp(this.l2, this.interop.ledger2.engine!, this.targetCentralBank, [leg.mint(this.tokens.targetWholesale2!, dealer, target * 10n)]);
    }
  }
}

export function newTransfer(world: InteropWorld, amount: bigint, uetr: string = crypto.randomUUID()): Transfer {
  return { uetr, id: uetrToId(uetr), amount, target: world.targetOf(amount) };
}

export interface WorldInit {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
  readonly interop: InteropDeployment;
  readonly network1: Network;
  readonly network2: Network;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ALL_ERRORS = Object.values(contracts).flatMap((c) => c.abi.filter((item) => item.type === "error"));

function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  if (revert.data?.errorName) return revert.data.errorName;
  if (revert.raw) {
    try {
      return decodeErrorResult({ abi: ALL_ERRORS, data: revert.raw as Hex }).errorName;
    } catch {
      // Not one of ours.
    }
  }
  return revert.reason ?? "reverted";
}
