/**
 * Who sees what, in each mode (SPEC.md §10). The same interbank payment is
 * made twice: once in the baseline mode, three legs through the settlement
 * engine on plain deposit tokens; once in confidential mode, over the banks'
 * Noto deposits. Then each observer is asked what it can actually see:
 *   - every validator, by decoding the shared-ledger transaction and reading
 *     public balances;
 *   - each bank, through its own Paladin node's private states;
 *   - the central bank, which runs a validator and no Paladin node.
 * Writes sim/runs/confidential/latest.json for the console.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatMoney, money } from "@oul/domain";
import { registryOperator, type Scenario, soleCurrency } from "@oul/scenario";
import { type Address, createPublicClient, createWalletClient, decodeFunctionData, type Hex, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  approve,
  ConfidentialPayments,
  contracts,
  customerAddress,
  devKeys,
  leg,
  type Network,
  paladinContract,
  paladinKeys,
  readConfidentialDeployment,
  readDeployment,
  REPO_ROOT,
  rpcUrlFor,
  sandboxChain,
  uetrToId,
  ZERO_FEES,
} from "../src/index.ts";

export type FactKey = "payer" | "payee" | "amount" | "wholesale" | "payerBalance" | "payeeBalance";

export interface Seen {
  readonly visible: boolean;
  /** What the observer sees, when it sees it. */
  readonly value?: string;
  /** How: where the evidence came from, or why there is none. */
  readonly how: string;
}

export interface Observer {
  readonly id: string;
  readonly label: string;
  readonly facts: Readonly<Record<FactKey, Seen>>;
}

export interface ModeReport {
  readonly tx: Hex;
  readonly block: string;
  readonly observers: readonly Observer[];
}

export interface VisibilityReport {
  readonly scenario: string;
  readonly at: string;
  readonly payment: {
    payerBank: string;
    payer: string;
    payeeBank: string;
    payee: string;
    /** Display names, so a reader needs no running service to know who they are. */
    names: { payerBank: string; payer: string; payeeBank: string; payee: string };
    amount: string;
    currency: string;
  };
  readonly modes: { readonly plain: ModeReport; readonly confidential: ModeReport };
}

const RUNS_DIR = path.join(REPO_ROOT, "sim/runs/confidential");

export async function confidentialCompare(scenario: Scenario, network: Network): Promise<void> {
  const deployment = await readDeployment(scenario.id);
  const confidential = await readConfidentialDeployment(scenario.id);
  if (!deployment || !confidential?.contracts.settlement || Object.keys(confidential.tokens).length === 0) {
    throw new Error(`Set up confidential mode first: pnpm confidential:deploy, confidential:up, confidential:setup ${scenario.id}`);
  }
  const currency = soleCurrency(scenario, "Confidential mode");
  const cbId = registryOperator(scenario).id;
  const banks = Object.keys(confidential.nodes);
  const [payerBank, payeeBank] = banks as [string, string];
  const bystander = banks.find((b) => b !== payerBank && b !== payeeBank);
  const payer = scenario.ledgers.find((l) => l.participant === payerBank)!.customers[0]!.id;
  const payee = scenario.ledgers.find((l) => l.participant === payeeBank)!.customers[0]!.id;
  const amount = 1_750_00n;
  const show = (minor: bigint) => formatMoney(money(currency, minor));
  const name = (id: string) => scenario.participants.find((p) => p.id === id)?.name ?? id;
  const customerName = (bank: string, id: string) => scenario.ledgers.find((l) => l.participant === bank)?.customers.find((c) => c.id === id)?.name ?? id;

  const client = createPublicClient({ chain: sandboxChain(network.chainId, rpcUrlFor(network, cbId)), transport: http(), pollingInterval: 500 }) as PublicClient;
  const wallet = (id: string) =>
    createWalletClient({ account: privateKeyToAccount(devKeys.participant(id)), chain: sandboxChain(network.chainId, rpcUrlFor(network, id)), transport: http() });
  const tokenOf = (kind: "wholesale" | "deposit", bank?: string) =>
    Object.values(deployment.tokens).find((t) => t.kind === kind && (!bank || t.issuer === bank))!.address;
  const wholesale = tokenOf("wholesale");
  const publicBalance = (token: Address, holder: Address) =>
    client.readContract({ address: token, abi: contracts.DepositToken.abi, functionName: "balanceOf", args: [holder] }) as Promise<bigint>;
  /** Fund through the engine, as the central bank or a bank would: one leg on its own authority. */
  const engineSettle = async (submitter: string, legs: ReturnType<typeof leg.mint>[]) => {
    const now = (await client.getBlock()).timestamp;
    const instruction = { id: uetrToId(crypto.randomUUID()), legs, deadline: now + 600n };
    const hash = await wallet(submitter).writeContract({
      address: deployment.contracts.engine,
      abi: contracts.SettlementEngine.abi,
      functionName: "settle",
      args: [instruction, []],
      ...ZERO_FEES,
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Settlement by ${submitter} reverted`);
    return { instruction, receipt };
  };

  console.log(`Who sees what: ${customerName(payerBank, payer)} at ${name(payerBank)} pays ${customerName(payeeBank, payee)} at ${name(payeeBank)} ${show(amount)} ${currency}, in each mode`);

  // Funds for both payments: wholesale for the payer's bank, a plain and a private deposit for the payer.
  await engineSettle(cbId, [leg.mint(wholesale, deployment.participants[payerBank]!.address, amount * 4n)]);
  await engineSettle(payerBank, [leg.mint(tokenOf("deposit", payerBank), customerAddress(payerBank, payer), amount * 2n)]);
  const payments = new ConfidentialPayments(scenario, network, deployment, confidential);
  await payments.tokenize(payerBank, payer, amount * 2n);

  // ---------------------------------------------------------------- baseline mode
  const payerAddress = customerAddress(payerBank, payer);
  const payeeAddress = customerAddress(payeeBank, payee);
  const plainLegs = [
    leg.burn(tokenOf("deposit", payerBank), payerAddress, amount),
    leg.transfer(wholesale, deployment.participants[payerBank]!.address, deployment.participants[payeeBank]!.address, amount),
    leg.mint(tokenOf("deposit", payeeBank), payeeAddress, amount),
  ];
  const now = (await client.getBlock()).timestamp;
  const plainInstruction = { id: uetrToId(crypto.randomUUID()), legs: plainLegs, deadline: now + 600n };
  const plainApproval = await approve(privateKeyToAccount(devKeys.participant(payeeBank)), network.chainId, deployment.contracts.engine, plainInstruction);
  const plainHash = await wallet(payerBank).writeContract({
    address: deployment.contracts.engine,
    abi: contracts.SettlementEngine.abi,
    functionName: "settle",
    args: [plainInstruction, [plainApproval]],
    ...ZERO_FEES,
  } as never);
  const plainReceipt = await client.waitForTransactionReceipt({ hash: plainHash });
  if (plainReceipt.status !== "success") throw new Error("The baseline payment reverted");
  console.log(`  baseline: settled in block ${plainReceipt.blockNumber}`);

  // What any validator reads from the baseline transaction: the legs in the clear.
  const plainTx = await client.getTransaction({ hash: plainHash });
  const decoded = decodeFunctionData({ abi: contracts.SettlementEngine.abi, data: plainTx.input });
  const decodedLegs = (decoded.args[0] as { legs: readonly { from: Address; to: Address; amount: bigint }[] }).legs;
  const whose = (address: Address) => {
    const entry = Object.entries(deployment.customers).find(([, c]) => c.address.toLowerCase() === address.toLowerCase());
    return entry ? `${customerName(entry[1].bank, entry[0].split("/")[1]!)} (${address.slice(0, 10)}…)` : address;
  };
  const publicFacts: Record<FactKey, Seen> = {
    payer: { visible: true, value: whose(decodedLegs[0]!.from), how: "the burn leg's holder, in the transaction's input" },
    payee: { visible: true, value: whose(decodedLegs[2]!.to), how: "the mint leg's holder, in the transaction's input" },
    amount: { visible: true, value: show(decodedLegs[0]!.amount), how: "every leg's amount, in the transaction's input" },
    wholesale: { visible: true, value: `${name(payerBank)} → ${name(payeeBank)}, ${show(decodedLegs[1]!.amount)}`, how: "the wholesale leg, in the transaction's input" },
    payerBalance: { visible: true, value: show(await publicBalance(tokenOf("deposit", payerBank), payerAddress)), how: "balanceOf on the deposit token, open to anyone" },
    payeeBalance: { visible: true, value: show(await publicBalance(tokenOf("deposit", payeeBank), payeeAddress)), how: "balanceOf on the deposit token, open to anyone" },
  };
  const everyone = [
    { id: "validators", label: "Every validator" },
    { id: cbId, label: name(cbId) },
    { id: payerBank, label: `${name(payerBank)} (payer's bank)` },
    { id: payeeBank, label: `${name(payeeBank)} (payee's bank)` },
    ...(bystander ? [{ id: bystander, label: `${name(bystander)} (not a party)` }] : []),
  ];
  const plain: ModeReport = {
    tx: plainHash,
    block: plainReceipt.blockNumber.toString(),
    // Each participant runs a validator, so each reads the whole shared ledger.
    observers: everyone.map((o) => ({ ...o, facts: publicFacts })),
  };

  // ---------------------------------------------------------------- confidential mode
  const paid = await payments.pay({ payerBank, payer, payeeBank, payee, amount });
  const settleTx = paid.steps.at(-1)!.tx!;
  console.log(`  confidential: settled in block ${paid.settledBlock}`);
  await new Promise((resolve) => setTimeout(resolve, 4000)); // let the nodes index the spent locks

  const tx = await client.getTransaction({ hash: settleTx });
  const input = tx.input.toLowerCase();
  const payment = decodeFunctionData({ abi: contracts.ConfidentialSettlement.abi, data: tx.input }).args[0] as {
    readonly legs: readonly { from: Address; to: Address; amount: bigint }[];
    readonly notoLegs: readonly { noto: Address; lockId: Hex }[];
  };
  const owners = {
    payer: await payments.node(payerBank).resolveAddress(payer),
    payee: await payments.node(payeeBank).resolveAddress(payee),
  };
  const appears = (address: Address) => input.includes(address.slice(2).toLowerCase());
  const tokenName = (noto: Address) => Object.entries(confidential.tokens).find(([, t]) => t.address.toLowerCase() === noto.toLowerCase())?.[0] ?? noto;
  const notoSummary = payment.notoLegs.map((n) => `${tokenName(n.noto)} lock ${n.lockId.slice(0, 10)}…`).join(", ");
  const onLedger: Record<FactKey, Seen> = {
    payer: appears(owners.payer)
      ? { visible: true, value: owners.payer, how: "the payer's key appears in the transaction" }
      : { visible: false, how: `the transaction names locks (${notoSummary}), not holders` },
    payee: appears(owners.payee)
      ? { visible: true, value: owners.payee, how: "the payee's key appears in the transaction" }
      : { visible: false, how: "the mint lock carries a state hash, not its owner" },
    amount: {
      visible: true,
      value: show(payment.legs[0]!.amount),
      how: "inferred from the wholesale leg, which moves the same amount; the deposit locks carry hashes",
    },
    wholesale: {
      visible: true,
      value: `${name(payerBank)} → ${name(payeeBank)}, ${show(payment.legs[0]!.amount)}`,
      how: "the wholesale leg, in the transaction's input",
    },
    payerBalance: { visible: false, how: "Noto balances are private states; the ledger holds their hashes" },
    payeeBalance: { visible: false, how: "Noto balances are private states; the ledger holds their hashes" },
  };

  const nodeBalance = async (node: string, bank: string, customer: string) =>
    payments
      .node(node)
      .call<{ totalBalance: string; totalStates: string }>("ptx_call", {
        type: "private",
        domain: "noto",
        to: payments.noto(bank),
        abi: (await paladinContract("INotoPrivate")).abi,
        function: "balanceOf",
        from: paladinKeys(node).notary,
        data: { account: `${customer}@${bank}` },
      })
      .then((r) => ({ balance: BigInt(r.totalBalance), states: BigInt(r.totalStates) }))
      .catch(() => ({ balance: 0n, states: 0n }));
  const bankView = async (node: string): Promise<Record<FactKey, Seen>> => {
    const payerSeen = await nodeBalance(node, payerBank, payer);
    const payeeSeen = await nodeBalance(node, payeeBank, payee);
    const holdsPayer = payerSeen.states > 0n;
    const holdsPayee = payeeSeen.states > 0n;
    return {
      payer: holdsPayer
        ? { visible: true, value: `${customerName(payerBank, payer)} (${owners.payer.slice(0, 10)}…)`, how: "its own customer, whose states its node holds" }
        : { visible: false, how: "its node holds none of the payer's states" },
      payee: holdsPayee
        ? { visible: true, value: `${customerName(payeeBank, payee)} (${owners.payee.slice(0, 10)}…)`, how: "its own customer, whose states its node holds" }
        : { visible: false, how: "its node holds none of the payee's states" },
      amount: { ...onLedger.amount, how: holdsPayer || holdsPayee ? "its own lock's amount, and the wholesale leg" : onLedger.amount.how },
      wholesale: onLedger.wholesale,
      payerBalance: holdsPayer
        ? { visible: true, value: show(payerSeen.balance), how: `${payerSeen.states} unspent states on its node` }
        : { visible: false, how: "not held on its node" },
      payeeBalance: holdsPayee
        ? { visible: true, value: show(payeeSeen.balance), how: `${payeeSeen.states} unspent states on its node` }
        : { visible: false, how: "not held on its node" },
    };
  };
  const confidentialReport: ModeReport = {
    tx: settleTx,
    block: String(paid.settledBlock),
    observers: [
      { id: "validators", label: "Every validator", facts: onLedger },
      { id: cbId, label: name(cbId), facts: onLedger },
      { id: payerBank, label: `${name(payerBank)} (payer's bank)`, facts: await bankView(payerBank) },
      { id: payeeBank, label: `${name(payeeBank)} (payee's bank)`, facts: await bankView(payeeBank) },
      ...(bystander ? [{ id: bystander, label: `${name(bystander)} (not a party)`, facts: await bankView(bystander) }] : []),
    ],
  };

  const report: VisibilityReport = {
    scenario: scenario.id,
    at: new Date().toISOString(),
    payment: {
      payerBank,
      payer,
      payeeBank,
      payee,
      names: { payerBank: name(payerBank), payer: customerName(payerBank, payer), payeeBank: name(payeeBank), payee: customerName(payeeBank, payee) },
      amount: show(amount),
      currency,
    },
    modes: { plain, confidential: confidentialReport },
  };
  await mkdir(RUNS_DIR, { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path.join(RUNS_DIR, `${report.at.replaceAll(":", "-")}.json`), body);
  await writeFile(path.join(RUNS_DIR, "latest.json"), body);

  for (const [mode, r] of Object.entries(report.modes)) {
    console.log(`\n  ${mode}: transaction ${r.tx.slice(0, 12)}… in block ${r.block}`);
    for (const o of r.observers) {
      const seen = (Object.keys(o.facts) as FactKey[]).filter((k) => o.facts[k].visible);
      console.log(`    ${o.label.padEnd(26)} sees ${seen.join(", ") || "nothing"}`);
    }
  }
  const leaked = confidentialReport.observers.find((o) => o.id === "validators")!.facts;
  const bystanderView = confidentialReport.observers.find((o) => o.id === bystander)?.facts;
  if (leaked.payer.visible || leaked.payee.visible || leaked.payerBalance.visible || leaked.payeeBalance.visible) {
    throw new Error("Validators see a customer or a balance in confidential mode");
  }
  if (bystanderView && (bystanderView.payer.visible || bystanderView.payee.visible)) throw new Error("A bank not party to the payment sees a customer");
  console.log(`\n  Saved sim/runs/confidential/latest.json for the console`);
}
