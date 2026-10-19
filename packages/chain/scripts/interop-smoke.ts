/**
 * Settle one interbank transfer across interop mode's two ledgers (SPEC.md
 * §7) through the real contracts, once by hashlock and once by notary, both
 * ending consistently: the payer's deposit burned and wholesale moved to the
 * payee's bank on ledger 1, the payee's deposit minted on ledger 2. Proves the
 * deployment on both ledgers; `pnpm interop` runs the coordinators and their
 * faults.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { formatMoney, money, parseMoney } from "@oul/domain";
import { registryOperator, type Scenario, soleCurrency } from "@oul/scenario";
import { type Address, createPublicClient, createWalletClient, type Hex, http, parseEventLogs, type PublicClient, sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type ChainLeg,
  contracts,
  customerAddress,
  devKeys,
  type InteropDeployment,
  leg,
  type Network,
  readDeployment,
  readInteropDeployment,
  rpcUrlFor,
  sandboxChain,
  uetrToId,
  ZERO_FEES,
} from "../src/index.ts";

const { ConditionalSettlement, SettlementEngine, DepositToken } = contracts;
const HASHLOCK = 0;
const NOTARY = 1;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export async function interopSmoke(scenario: Scenario, ledger1: Network, ledger2: Network): Promise<void> {
  const deployment = await readDeployment(scenario.id);
  const interop = await readInteropDeployment(scenario.id);
  if (!deployment || !interop) throw new Error(`Deploy first: pnpm deploy ${scenario.id} && pnpm interop:deploy ${scenario.id}`);
  const spec = scenario.interop!;
  const currency = soleCurrency(scenario, "The interop smoke run (`pnpm interop <scenario> --fault none` pays across currencies)");
  const cbId = registryOperator(scenario).id;
  const payeeBank = interop.ledger2.tokens[spec.deposits[0]!]!.issuer;
  const payerBank = scenario.participants.find((p) => p.kind === "bank" && p.id !== payeeBank)!.id;
  const payer = customerAddress(payerBank, scenario.ledgers.find((l) => l.participant === payerBank)!.customers[0]!.id);
  const payee = customerAddress(payeeBank, scenario.ledgers.find((l) => l.participant === payeeBank)!.customers[0]!.id);
  const wholesale = Object.values(deployment.tokens).find((t) => t.kind === "wholesale")!.address;
  const deposit1 = Object.values(deployment.tokens).find((t) => t.kind === "deposit" && t.issuer === payerBank)!.address;
  const deposit2 = interop.ledger2.tokens[spec.deposits[0]!]!.address;
  const amount = parseMoney(currency, "2500.00").minor;
  const show = (minor: bigint) => `${formatMoney(money(currency, minor))} ${currency}`;

  const ledger = (network: Network, conditional: Address) => {
    const client = createPublicClient({ chain: sandboxChain(network.chainId, rpcUrlFor(network, cbId)), transport: http(), cacheTime: 0 }) as PublicClient;
    const send = async (id: string, address: Address, abi: typeof ConditionalSettlement.abi | typeof SettlementEngine.abi, functionName: string, args: readonly unknown[]) => {
      const wallet = createWalletClient({
        account: privateKeyToAccount(devKeys.participant(id)),
        chain: sandboxChain(network.chainId, rpcUrlFor(network, id)),
        transport: http(),
      });
      const hash = await wallet.writeContract({ address, abi, functionName, args, ...ZERO_FEES } as never);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} by ${id} reverted on chain ${network.chainId}`);
      return receipt;
    };
    const now = async () => (await client.getBlock()).timestamp;
    const lock = async (by: string, uetr: string, legs: ChainLeg[], condition: { kind: number; hashlock: Hex; notary: Address; timeout: bigint }) =>
      send(by, conditional, ConditionalSettlement.abi, "lock", [
        { id: uetrToId(uetr), legs, deadline: (await now()) + 3600n },
        [],
        condition,
      ]);
    const balance = (token: Address, holder: Address) =>
      client.readContract({ address: token, abi: DepositToken.abi, functionName: "balanceOf", args: [holder] }) as Promise<bigint>;
    return { client, send, now, lock, balance, conditional };
  };
  const l1 = ledger(ledger1, interop.ledger1.conditional);
  const l2 = ledger(ledger2, interop.ledger2.conditional);

  console.log(`Interop smoke for ${scenario.id}: ledger 1 is chain ${ledger1.chainId}, ledger 2 is chain ${ledger2.chainId}`);

  // Funds on ledger 1: wholesale for the payer's bank, a tokenized deposit for its customer.
  const settle = (by: string, legs: ChainLeg[]) =>
    l1.now().then((now) =>
      l1.send(by, deployment.contracts.engine, SettlementEngine.abi, "settle", [{ id: uetrToId(randomUUID()), legs, deadline: now + 600n }, []]),
    );
  await settle(cbId, [leg.mint(wholesale, deployment.participants[payerBank]!.address, amount * 4n)]);
  await settle(payerBank, [leg.mint(deposit1, payer, amount * 4n)]);
  console.log(`  funded ${payerBank} with ${show(amount * 4n)} of wholesale and its customer with ${show(amount * 4n)} of deposit tokens`);

  const ledger1Legs = [leg.burn(deposit1, payer, amount), leg.transfer(wholesale, deployment.participants[payerBank]!.address, deployment.participants[payeeBank]!.address, amount)];
  const ledger2Legs = [leg.mint(deposit2, payee, amount)];
  const before = {
    wholesale: (await l1.balance(wholesale, deployment.participants[payeeBank]!.address)) as bigint,
    payee: await l2.balance(deposit2, payee),
  };

  // Hashlock: the payer's bank holds the secret, locks first with the longer timeout.
  {
    const uetr = randomUUID();
    const secret = `0x${randomBytes(32).toString("hex")}` as Hex;
    const hashlock = sha256(secret);
    await l1.lock(payerBank, uetr, ledger1Legs, { kind: HASHLOCK, hashlock, notary: ZERO_ADDRESS, timeout: (await l1.now()) + 600n });
    await l2.lock(payeeBank, uetr, ledger2Legs, { kind: HASHLOCK, hashlock, notary: ZERO_ADDRESS, timeout: (await l2.now()) + 300n });
    const claimed = await l2.send(payerBank, l2.conditional, ConditionalSettlement.abi, "claim", [uetrToId(uetr), secret]);
    // The payee's bank learns the secret from ledger 2, where the claim published it.
    const [settled] = parseEventLogs({ abi: ConditionalSettlement.abi, logs: claimed.logs, eventName: "Settled" });
    const published = (settled!.args as { preimage: Hex }).preimage;
    await l1.send(payeeBank, l1.conditional, ConditionalSettlement.abi, "claim", [uetrToId(uetr), published]);
    console.log(`  hashlock ${uetr.slice(0, 8)}: locked on both ledgers, claimed on ledger 2 by ${payerBank}, then on ledger 1 by ${payeeBank} with the published secret`);
  }

  // Notary: both banks lock naming it; it commits ledger 1, then ledger 2.
  {
    const uetr = randomUUID();
    const condition = async (l: typeof l1) => ({ kind: NOTARY, hashlock: ZERO32, notary: interop.notary.address, timeout: (await l.now()) + 600n });
    await l1.lock(payerBank, uetr, ledger1Legs, await condition(l1));
    await l2.lock(payeeBank, uetr, ledger2Legs, await condition(l2));
    await l1.send(interop.notary.id, l1.conditional, ConditionalSettlement.abi, "commit", [uetrToId(uetr)]);
    await l2.send(interop.notary.id, l2.conditional, ConditionalSettlement.abi, "commit", [uetrToId(uetr)]);
    console.log(`  notary ${uetr.slice(0, 8)}: locked on both ledgers, committed on ledger 1, then on ledger 2`);
  }

  const paid = (await l1.balance(wholesale, deployment.participants[payeeBank]!.address)) - before.wholesale;
  const credited = (await l2.balance(deposit2, payee)) - before.payee;
  const ok = paid === amount * 2n && credited === amount * 2n;
  console.log(`  ${payeeBank} received ${show(paid)} of wholesale on ledger 1; its customer was credited ${show(credited)} on ledger 2`);
  if (!ok) throw new Error("The ledgers disagree after two transfers that should both have completed");
  console.log("Both transfers ended the same way on both ledgers.");
}
