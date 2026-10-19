/**
 * Settle SPEC.md flows 5.1 to 5.3 on the running network, through the real
 * contracts, with approvals signed in TypeScript: fund two banks with
 * wholesale tokens, tokenize a customer deposit, then the three-leg interbank
 * transfer co-signed by the payee bank. Then resubmit it to show it settles
 * only once. Proves the deployment and that the EIP-712 encoding here matches
 * the engine's.
 */
import { randomUUID } from "node:crypto";
import { formatMoney, money, parseMoney } from "@oul/domain";
import { registryOperator, type Scenario, soleCurrency } from "@oul/scenario";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type Approval,
  approve,
  type ChainInstruction,
  contracts,
  customerAddress,
  devKeys,
  instructionDigest,
  leg,
  readDeployment,
  rpcUrlFor,
  sandboxChain,
  uetrToId,
  ZERO_FEES,
  type Network,
} from "../src/index.ts";

const { SettlementEngine, WholesaleToken, DepositToken } = contracts;

export async function smoke(scenario: Scenario, network: Network): Promise<void> {
  const deployment = await readDeployment(scenario.id);
  if (!deployment) throw new Error(`No deployment for ${scenario.id}; run \`pnpm deploy ${scenario.id}\` first`);
  const engine = deployment.contracts.engine;
  const currency = soleCurrency(scenario, "The network smoke run");
  const cbId = registryOperator(scenario).id;
  const [payerBank, payeeBank] = scenario.ledgers.filter((l) => l.participant !== cbId);
  if (!payerBank?.customers[0] || !payeeBank?.customers[0]) throw new Error("Need two banks with a customer each");
  const payer = payerBank.customers[0].id;
  const payee = payeeBank.customers[0].id;
  const depositOf = (bank: string) =>
    Object.entries(deployment.tokens).find(([, t]) => t.kind === "deposit" && t.issuer === bank)![1].address;
  const wholesale = Object.values(deployment.tokens).find((t) => t.kind === "wholesale")!.address;

  const client = createPublicClient({
    chain: sandboxChain(network.chainId, rpcUrlFor(network, cbId)),
    transport: http(),
  }) as PublicClient;
  const accountOf = (id: string) => privateKeyToAccount(devKeys.participant(id));
  const amount = (value: string) => parseMoney(currency, value).minor;
  const show = (minor: bigint) => `${formatMoney(money(currency, minor))} ${currency}`;

  async function submit(submitter: string, instruction: ChainInstruction, approvals: Approval[] = []) {
    const wallet = createWalletClient({
      account: accountOf(submitter),
      chain: sandboxChain(network.chainId, rpcUrlFor(network, submitter)),
      transport: http(),
    });
    const args = [{ ...instruction, legs: [...instruction.legs] }, approvals] as const;
    await client.simulateContract({ address: engine, abi: SettlementEngine.abi, functionName: "settle", args, account: wallet.account });
    const hash = await wallet.writeContract({
      address: engine,
      abi: SettlementEngine.abi,
      functionName: "settle",
      args,
      ...ZERO_FEES,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`settle ${instruction.id} reverted`);
    return receipt.blockNumber;
  }

  async function instruction(legs: ChainInstruction["legs"]): Promise<ChainInstruction> {
    const block = await client.getBlock();
    return { id: uetrToId(randomUUID()), legs, deadline: block.timestamp + 3600n };
  }

  const balance = (token: Address, holder: Address, abi: typeof WholesaleToken.abi | typeof DepositToken.abi) =>
    client.readContract({ address: token, abi, functionName: "balanceOf", args: [holder] }) as Promise<bigint>;

  console.log(`Smoke run on ${scenario.id}, chain ${network.chainId}`);

  // §5.1: the central bank funds both banks with wholesale tokens.
  const funding = amount("10000000");
  for (const bank of [payerBank.participant, payeeBank.participant]) {
    const at = await submit(cbId, await instruction([leg.mint(wholesale, deployment.participants[bank]!.address, funding)]));
    console.log(`  5.1 fund ${bank} with ${show(funding)} wholesale            block ${at}`);
  }

  // §5.2: the payer's bank tokenizes part of the customer's deposit.
  const payerAddress = customerAddress(payerBank.participant, payer);
  const payeeAddress = customerAddress(payeeBank.participant, payee);
  const tokenized = amount("5000");
  let at = await submit(
    payerBank.participant,
    await instruction([leg.mint(depositOf(payerBank.participant), payerAddress, tokenized)]),
  );
  console.log(`  5.2 tokenize ${show(tokenized)} for ${payer}              block ${at}`);

  // §5.3: the interbank transfer, co-signed by the payee's bank.
  const sent = amount("2500");
  const transfer = await instruction([
    leg.burn(depositOf(payerBank.participant), payerAddress, sent),
    leg.transfer(
      wholesale,
      deployment.participants[payerBank.participant]!.address,
      deployment.participants[payeeBank.participant]!.address,
      sent,
    ),
    leg.mint(depositOf(payeeBank.participant), payeeAddress, sent),
  ]);
  const onChainDigest = await client.readContract({
    address: engine,
    abi: SettlementEngine.abi,
    functionName: "digest",
    args: [{ ...transfer, legs: [...transfer.legs] }],
  });
  const localDigest = instructionDigest(network.chainId, engine, transfer);
  if (onChainDigest !== localDigest) throw new Error(`EIP-712 mismatch: engine ${onChainDigest}, local ${localDigest}`);
  const cosign = await approve(accountOf(payeeBank.participant), network.chainId, engine, transfer);
  at = await submit(payerBank.participant, transfer, [cosign]);
  console.log(`  5.3 ${payer} pays ${payee} ${show(sent)}, three legs   block ${at}`);

  // Exactly once: the same instruction again is refused.
  try {
    await submit(payerBank.participant, transfer, [cosign]);
    throw new Error("A resubmitted instruction settled twice");
  } catch (error) {
    const revert = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    if (name !== "AlreadySettled") throw error;
    console.log("  resubmitting the same instruction: refused (AlreadySettled)");
  }

  const rows: [string, bigint][] = [
    [`${payer} ${scenario.instruments.deposits.find((d) => d.issuer === payerBank.participant)!.symbol}`, await balance(depositOf(payerBank.participant), payerAddress, DepositToken.abi)],
    [`${payee} ${scenario.instruments.deposits.find((d) => d.issuer === payeeBank.participant)!.symbol}`, await balance(depositOf(payeeBank.participant), payeeAddress, DepositToken.abi)],
    [`${payerBank.participant} ${scenario.instruments.wholesale[0]!.symbol}`, await balance(wholesale, deployment.participants[payerBank.participant]!.address, WholesaleToken.abi)],
    [`${payeeBank.participant} ${scenario.instruments.wholesale[0]!.symbol}`, await balance(wholesale, deployment.participants[payeeBank.participant]!.address, WholesaleToken.abi)],
  ];
  console.log("Balances on chain:");
  for (const [label, value] of rows) console.log(`  ${label.padEnd(36)} ${show(value)}`);
  const settledAt = await client.readContract({
    address: engine,
    abi: SettlementEngine.abi,
    functionName: "settledAt",
    args: [transfer.id],
  });
  console.log(`Interbank instruction ${transfer.id.slice(0, 34)}… settled in block ${settledAt}`);
}
