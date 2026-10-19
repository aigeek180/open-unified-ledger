/**
 * Confidential mode's interbank payment (SPEC.md §10), on the running Paladin
 * nodes and the shared ledger: a customer of one bank pays a customer of
 * another, settled atomically over both banks' Noto deposits and wholesale;
 * then a second payment whose payee bank cancels before it settles, leaving
 * everything as it was. Prints each bank's view and the wholesale moved.
 */
import { registryOperator, type Scenario } from "@oul/scenario";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ConfidentialPayments,
  contracts,
  devKeys,
  leg,
  type Network,
  paladinContract,
  readConfidentialDeployment,
  readDeployment,
  rpcUrlFor,
  sandboxChain,
  uetrToId,
  ZERO_FEES,
} from "../src/index.ts";

export async function confidentialPay(scenario: Scenario, network: Network): Promise<void> {
  const deployment = await readDeployment(scenario.id);
  const confidential = await readConfidentialDeployment(scenario.id);
  if (!deployment || !confidential?.contracts.settlement || Object.keys(confidential.tokens).length === 0) {
    throw new Error(`Set up confidential mode first: pnpm confidential:deploy, confidential:up, confidential:setup ${scenario.id}`);
  }
  const payments = new ConfidentialPayments(scenario, network, deployment, confidential);
  const [payerBank, payeeBank] = Object.keys(confidential.nodes) as [string, string];
  const payer = scenario.ledgers.find((l) => l.participant === payerBank)!.customers[0]!.id;
  const payee = scenario.ledgers.find((l) => l.participant === payeeBank)!.customers[0]!.id;
  const wholesale = Object.values(deployment.tokens).find((t) => t.kind === "wholesale")!.address;
  const client = createPublicClient({ chain: sandboxChain(network.chainId, rpcUrlFor(network, payerBank)), transport: http() }) as PublicClient;
  const wholesaleOf = (bank: string) =>
    client.readContract({ address: wholesale, abi: contracts.WholesaleToken.abi, functionName: "balanceOf", args: [deployment.participants[bank]!.address] }) as Promise<bigint>;

  // Funds: wholesale for the payer's bank (through the engine, as the central bank), a private deposit for the payer.
  const amount = 2_500_00n;
  if ((await wholesaleOf(payerBank)) < amount * 4n) {
    const cbId = registryOperator(scenario).id;
    const cb = createWalletClient({ account: privateKeyToAccount(devKeys.participant(cbId)), chain: sandboxChain(network.chainId, rpcUrlFor(network, cbId)), transport: http() });
    const now = (await client.getBlock()).timestamp;
    const hash = await cb.writeContract({
      address: deployment.contracts.engine,
      abi: contracts.SettlementEngine.abi,
      functionName: "settle",
      args: [{ id: uetrToId(crypto.randomUUID()), legs: [leg.mint(wholesale, deployment.participants[payerBank]!.address, amount * 40n)], deadline: now + 600n }, []],
      ...ZERO_FEES,
    } as never);
    await client.waitForTransactionReceipt({ hash });
  }
  if ((await payments.balance(payerBank, payer)) < amount * 4n) await payments.tokenize(payerBank, payer, amount * 40n);

  const view = async () => ({
    payer: await payments.balance(payerBank, payer),
    payee: await payments.balance(payeeBank, payee),
    payerAtPayeeNode: await payments.node(payeeBank).call<{ totalBalance: string }>("ptx_call", {
      type: "private",
      domain: "noto",
      to: payments.noto(payerBank),
      abi: (await paladinContract("INotoPrivate")).abi,
      function: "balanceOf",
      from: "notary",
      data: { account: `${payer}@${payerBank}` },
    }).then((r) => BigInt(r.totalBalance)).catch(() => 0n),
    wholesaleToPayee: await wholesaleOf(payeeBank),
  });
  const settledState = async (before: Awaited<ReturnType<typeof view>>, expect: bigint) => {
    // The nodes see a spent lock once they index its block.
    for (let i = 0; i < 40; i++) {
      const now = await view();
      if (before.payer - now.payer === expect && now.payee - before.payee === expect) return now;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return view();
  };

  console.log(`Confidential payment for ${scenario.id}: ${payer} at ${payerBank} pays ${payee} at ${payeeBank}`);
  const before = await view();
  const paid = await payments.pay({ payerBank, payer, payeeBank, payee, amount });
  for (const s of paid.steps) console.log(`  ${s.who.padEnd(7)} ${s.what}${s.tx ? `  (${s.tx.slice(0, 12)}…)` : ""}`);
  const after = await settledState(before, amount);
  console.log(`  settled in block ${paid.settledBlock}:`);
  console.log(`    ${payerBank}'s node: ${payer} ${before.payer} → ${after.payer}`);
  console.log(`    ${payeeBank}'s node: ${payee} ${before.payee} → ${after.payee}`);
  console.log(`    ${payeeBank}'s node sees ${payer}'s balance as ${after.payerAtPayeeNode} (not a holder of it)`);
  console.log(`    wholesale at ${payeeBank}: ${before.wholesaleToPayee} → ${after.wholesaleToPayee}`);
  const ok = before.payer - after.payer === amount && after.payee - before.payee === amount && after.wholesaleToPayee - before.wholesaleToPayee === amount && after.payerAtPayeeNode === 0n;
  if (!ok) throw new Error("The payment did not move exactly the amount on all three legs, privately");

  console.log(`\nA second payment, whose payee bank cancels its lock before it settles:`);
  const cancelled = await payments.pay({ payerBank, payer, payeeBank, payee, amount, payeeCancels: true });
  for (const s of cancelled.steps) console.log(`  ${s.who.padEnd(7)} ${s.what}${s.tx ? `  (${s.tx.slice(0, 12)}…)` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const end = await view();
  console.log(`  ${payer} ${end.payer}, ${payee} ${end.payee}, wholesale at ${payeeBank} ${end.wholesaleToPayee}: as before`);
  if (end.payer !== after.payer || end.payee !== after.payee || end.wholesaleToPayee !== after.wholesaleToPayee) throw new Error("The cancelled payment moved something");
  console.log("One payment settled whole, privately; the cancelled one moved nothing.");
}
