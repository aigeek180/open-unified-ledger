import { registryOperator, type Scenario } from "@oul/scenario";
import { type Address, createPublicClient, createWalletClient, type Hex, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "./deployment.ts";
import { devKeys } from "./dev-keys.ts";
import { ConfidentialSettlement } from "./generated/contracts.ts";
import { leg, uetrToId } from "./instruction.ts";
import { type Network, rpcUrlFor, sandboxChain, ZERO_FEES } from "./network.ts";
import { type ConfidentialDeployment, PaladinRpc, paladinContract, paladinKeys } from "./paladin.ts";

/**
 * An interbank payment in confidential mode (SPEC.md §10): the payer's bank
 * locks a burn of its customer's Noto deposit, the payee's bank locks a mint
 * of its customer's, each delegates its lock to ConfidentialSettlement, the
 * payee's bank signs the payment (the mint creates its liability), and the
 * payer's bank settles: wholesale moves and both locks are spent in one
 * shared-ledger transaction. Each bank's lock is made on its own Paladin
 * node; no private state crosses between them.
 */

interface LockInfo {
  readonly lockId: Hex;
  readonly spendArgs: Hex;
  readonly cancelArgs: Hex;
}

export interface ConfidentialPaymentRequest {
  readonly payerBank: string;
  readonly payer: string;
  readonly payeeBank: string;
  readonly payee: string;
  /** Minor units. */
  readonly amount: bigint;
  /** Instead of settling, have the payee's bank cancel its lock first, then the payer's bank cancel its own. */
  readonly payeeCancels?: boolean;
}

export interface ConfidentialPaymentResult {
  readonly uetr: string;
  readonly outcome: "settled" | "cancelled";
  readonly settledBlock?: bigint;
  /** Each step, with the shared-ledger transaction it made, in order. */
  readonly steps: readonly { readonly who: string; readonly what: string; readonly tx?: Hex }[];
}

export class ConfidentialPayments {
  private readonly scenario: Scenario;
  private readonly network: Network;
  private readonly deployment: Deployment;
  private readonly confidential: ConfidentialDeployment;
  private readonly client: PublicClient;

  constructor(scenario: Scenario, network: Network, deployment: Deployment, confidential: ConfidentialDeployment) {
    this.scenario = scenario;
    this.network = network;
    this.deployment = deployment;
    this.confidential = confidential;
    const cbId = registryOperator(scenario).id;
    this.client = createPublicClient({ chain: sandboxChain(network.chainId, rpcUrlFor(network, cbId)), transport: http(), pollingInterval: 500 }) as PublicClient;
  }

  node(bank: string): PaladinRpc {
    const node = this.confidential.nodes[bank];
    if (!node) throw new Error(`${bank} runs no Paladin node`);
    return new PaladinRpc(node.rpcUrl);
  }

  noto(bank: string): Address {
    const token = Object.values(this.confidential.tokens).find((t) => t.bank === bank);
    if (!token) throw new Error(`${bank} has no Noto deposit token`);
    return token.address;
  }

  /** A customer's Noto balance as its bank's node holds it, in minor units. */
  async balance(bank: string, customer: string): Promise<bigint> {
    const result = await this.node(bank).call<{ totalBalance: string }>("ptx_call", {
      type: "private",
      domain: "noto",
      to: this.noto(bank),
      abi: (await paladinContract("INotoPrivate")).abi,
      function: "balanceOf",
      from: paladinKeys(bank).notary,
      data: { account: `${customer}@${bank}` },
    });
    return BigInt(result.totalBalance);
  }

  /** The bank mints its own Noto deposit to a customer: tokenizing, privately. */
  async tokenize(bank: string, customer: string, amount: bigint): Promise<Hex | undefined> {
    const rpc = this.node(bank);
    const receipt = await rpc.receipt(
      await rpc.sendTransaction({
        type: "private",
        to: this.noto(bank),
        abi: (await paladinContract("INotoPrivate")).abi,
        function: "mint",
        from: paladinKeys(bank).notary,
        data: { to: `${customer}@${bank}`, amount: amount.toString(), data: "0x" },
      }),
    );
    return receipt.transactionHash;
  }

  async pay(request: ConfidentialPaymentRequest): Promise<ConfidentialPaymentResult> {
    const { payerBank, payer, payeeBank, payee, amount } = request;
    const uetr = crypto.randomUUID();
    const id = uetrToId(uetr);
    const steps: { who: string; what: string; tx?: Hex }[] = [];
    const settlement = this.confidential.contracts.settlement;
    const privateAbi = (await paladinContract("INotoPrivate")).abi;

    // Each bank locks its own leg on its own node, then delegates the lock to the settlement contract.
    const lockAndDelegate = async (bank: string, from: string, fn: "createBurnLock" | "createMintLock", data: object, what: string): Promise<LockInfo> => {
      const rpc = this.node(bank);
      const created = await rpc.receipt(await rpc.sendTransaction({ type: "private", to: this.noto(bank), abi: privateAbi, function: fn, from, data }));
      const domain = await rpc.call<{ lockInfo?: { lockId: Hex; unlockParams?: { spendArgs: Hex }; cancelParams?: { cancelArgs: Hex } } }>(
        "ptx_getDomainReceipt",
        "noto",
        created.id,
      );
      const info = domain.lockInfo;
      if (!info?.unlockParams?.spendArgs || !info.cancelParams?.cancelArgs) throw new Error(`${bank}'s ${fn} gave no lock to spend`);
      steps.push({ who: bank, what, ...(created.transactionHash ? { tx: created.transactionHash } : {}) });
      const delegated = await rpc.receipt(
        await rpc.sendTransaction({
          type: "private",
          to: this.noto(bank),
          abi: privateAbi,
          function: "delegateLock",
          from,
          data: { lockId: info.lockId, delegate: settlement, data: "0x" },
        }),
      );
      steps.push({ who: bank, what: "delegates its lock to the settlement contract", ...(delegated.transactionHash ? { tx: delegated.transactionHash } : {}) });
      return { lockId: info.lockId, spendArgs: info.unlockParams.spendArgs, cancelArgs: info.cancelParams.cancelArgs };
    };
    const burn = await lockAndDelegate(
      payerBank,
      payer,
      "createBurnLock",
      { from: `${payer}@${payerBank}`, amount: amount.toString(), unlockData: "0x", data: "0x" },
      `locks a burn of ${payer}'s deposit`,
    );
    const mint = await lockAndDelegate(
      payeeBank,
      paladinKeys(payeeBank).notary,
      "createMintLock",
      { recipients: [{ to: `${payee}@${payeeBank}`, amount: amount.toString() }], unlockData: "0x", data: "0x" },
      `locks a mint of ${payee}'s deposit`,
    );

    const wallet = (bank: string) =>
      createWalletClient({
        account: privateKeyToAccount(devKeys.participant(bank)),
        chain: sandboxChain(this.network.chainId, rpcUrlFor(this.network, bank)),
        transport: http(),
      });
    const send = async (bank: string, functionName: string, args: readonly unknown[]) => {
      const hash = await wallet(bank).writeContract({ address: settlement, abi: ConfidentialSettlement.abi, functionName, args, ...ZERO_FEES } as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} by ${bank} reverted`);
      return receipt;
    };

    if (request.payeeCancels) {
      steps.push({ who: payeeBank, what: "cancels its mint lock", tx: (await send(payeeBank, "cancel", [this.noto(payeeBank), mint.lockId, mint.cancelArgs])).transactionHash });
      steps.push({ who: payerBank, what: "cancels its burn lock: the payer's deposit is back", tx: (await send(payerBank, "cancel", [this.noto(payerBank), burn.lockId, burn.cancelArgs])).transactionHash });
      return { uetr, outcome: "cancelled", steps };
    }

    const wholesale = Object.values(this.deployment.tokens).find((t) => t.kind === "wholesale")!.address;
    const payment = {
      id,
      legs: [leg.transfer(wholesale, this.deployment.participants[payerBank]!.address, this.deployment.participants[payeeBank]!.address, amount)],
      notoLegs: [
        { noto: this.noto(payerBank), lockId: burn.lockId, spendArgs: burn.spendArgs },
        { noto: this.noto(payeeBank), lockId: mint.lockId, spendArgs: mint.spendArgs },
      ],
      deadline: (await this.client.getBlock()).timestamp + 600n,
    };
    // The payee's bank consents to the mint of its liability by signing the whole payment.
    const digest = (await this.client.readContract({ address: settlement, abi: ConfidentialSettlement.abi, functionName: "digest", args: [payment] })) as Hex;
    const payeeAccount = privateKeyToAccount(devKeys.participant(payeeBank));
    const approval = { signer: payeeAccount.address, signature: await payeeAccount.sign({ hash: digest }) };
    steps.push({ who: payeeBank, what: "signs the payment" });
    const settled = await send(payerBank, "settle", [payment, [approval]]);
    steps.push({ who: payerBank, what: "settles: wholesale moves and both locks are spent, in one transaction", tx: settled.transactionHash });
    return { uetr, outcome: "settled", settledBlock: settled.blockNumber, steps };
  }
}
