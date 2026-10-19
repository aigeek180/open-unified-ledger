/**
 * Confidential mode's first proof (SPEC.md §10): through the running Paladin
 * nodes, a bank mints its Noto deposit token to a customer, the customer pays
 * another of the bank's customers, and then each place that could see it is
 * asked what it sees:
 *   - the issuing bank's node holds both customers' balances;
 *   - another bank's node holds none of them;
 *   - the shared ledger's transactions carry neither customer's address nor the amount;
 * and one bank's node resolves the other's notary over gRPC with mutual TLS,
 * which proves the private channel between them.
 */
import type { Scenario } from "@oul/scenario";
import { createPublicClient, type Hex, http, type PublicClient, toHex } from "viem";
import {
  type Network,
  PaladinRpc,
  paladinContract,
  paladinKeys,
  readConfidentialDeployment,
  rpcUrlFor,
  sandboxChain,
} from "../src/index.ts";

export async function confidentialSmoke(scenario: Scenario, network: Network): Promise<void> {
  const deployment = await readConfidentialDeployment(scenario.id);
  if (!deployment || Object.keys(deployment.tokens).length === 0) {
    throw new Error(`Set up confidential mode first: pnpm confidential:deploy, confidential:up, confidential:setup ${scenario.id}`);
  }
  const banks = Object.keys(deployment.nodes);
  const [bankA, bankB] = banks as [string, string];
  const token = Object.entries(deployment.tokens).find(([, t]) => t.bank === bankA)!;
  const [symbol, { address }] = token;
  const customers = scenario.ledgers.find((l) => l.participant === bankA)!.customers;
  const [payer, payee] = [customers[0]!.id, customers[1]!.id];
  const nodeA = new PaladinRpc(deployment.nodes[bankA]!.rpcUrl);
  const nodeB = new PaladinRpc(deployment.nodes[bankB]!.rpcUrl);
  const privateAbi = (await paladinContract("INotoPrivate")).abi;
  const client = createPublicClient({ chain: sandboxChain(network.chainId, rpcUrlFor(network, bankA)), transport: http() }) as PublicClient;

  const amountMint = 50_000_00n;
  const amountPay = 1_234_56n;
  const send = async (node: PaladinRpc, from: string, fn: string, data: object) => {
    const receipt = await node.receipt(await node.sendTransaction({ type: "private", to: address, abi: privateAbi, function: fn, from, data }));
    return receipt;
  };
  const balance = async (node: PaladinRpc, holder: string) => {
    const result = await node.call<{ totalBalance: string; totalStates: string }>("ptx_call", {
      type: "private",
      domain: "noto",
      to: address,
      abi: privateAbi,
      function: "balanceOf",
      from: paladinKeys(bankA).notary,
      data: { account: holder },
    });
    return BigInt(result.totalBalance);
  };

  console.log(`Confidential smoke for ${scenario.id}: ${symbol} is a Noto token at ${address}, notarized by ${deployment.tokens[symbol]!.notary}`);
  const minted = await send(nodeA, paladinKeys(bankA).notary, "mint", { to: `${payer}@${bankA}`, amount: amountMint.toString(), data: "0x" });
  console.log(`  ${bankA} mints ${amountMint} minor units to ${payer}: shared ledger transaction ${minted.transactionHash}`);
  const paid = await send(nodeA, payer, "transfer", { to: `${payee}@${bankA}`, amount: amountPay.toString(), data: "0x" });
  console.log(`  ${payer} pays ${payee} ${amountPay}: shared ledger transaction ${paid.transactionHash}`);

  // What the issuing bank's node holds.
  const payerAtA = await balance(nodeA, `${payer}@${bankA}`);
  const payeeAtA = await balance(nodeA, `${payee}@${bankA}`);
  console.log(`  ${bankA}'s node: ${payer} ${payerAtA}, ${payee} ${payeeAtA}`);
  if (payeeAtA < amountPay) throw new Error(`${bankA}'s node does not hold the payee's state`);

  // What another bank's node holds: nothing of either.
  const payerAtB = await balance(nodeB, `${payer}@${bankA}`).catch(() => 0n);
  const payeeAtB = await balance(nodeB, `${payee}@${bankA}`).catch(() => 0n);
  console.log(`  ${bankB}'s node: ${payer} ${payerAtB}, ${payee} ${payeeAtB}`);
  if (payerAtB !== 0n || payeeAtB !== 0n) throw new Error(`${bankB}'s node holds states it is not a party to`);

  // What every validator sees: the shared ledger's transactions. A customer holds Noto states under a key
  // its bank's Paladin node derives for it, so that is the address that must not appear.
  const owners = await Promise.all([payer, payee].map((c) => nodeA.resolveAddress(c)));
  console.log(`  ${payer} and ${payee} hold their states as ${owners.join(" and ")}, keys on ${bankA}'s node`);
  const amountHex = (n: bigint) => toHex(n, { size: 32 }).slice(2);
  for (const [what, receipt] of [["mint", minted], ["transfer", paid]] as const) {
    const tx = await client.getTransaction({ hash: receipt.transactionHash as Hex });
    const input = tx.input.toLowerCase();
    const leaks = [
      ...owners.map((a) => a.slice(2).toLowerCase()).filter((a) => input.includes(a)),
      ...[amountMint, amountPay].map(amountHex).filter((a) => input.includes(a)),
    ];
    console.log(`  shared ledger ${what}: ${input.length / 2 - 1} bytes of input, sent by ${tx.from}; customer addresses or amounts in it: ${leaks.length}`);
    if (leaks.length > 0) throw new Error(`The ${what} transaction on the shared ledger shows private data`);
  }

  // The private channel: bank B's node resolves bank A's notary key from bank A, over mutual TLS.
  const remote = await nodeB.call<string>("ptx_resolveVerifier", `${paladinKeys(bankA).notary}@${bankA}`, "ecdsa:secp256k1", "eth_address");
  const local = deployment.nodes[bankA]!.keys?.notary;
  console.log(`  ${bankB}'s node resolved ${bankA}'s notary over gRPC: ${remote}`);
  if (local && remote.toLowerCase() !== local.toLowerCase()) throw new Error("The notary resolved over gRPC does not match");
  console.log("Private holdings stayed with their bank; the shared ledger saw hashes and a notary's signature.");
}
