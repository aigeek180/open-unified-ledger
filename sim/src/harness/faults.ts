import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { approve, devKeys, REPO_ROOT } from "@oul/chain";
import { type Flow, legsOf } from "@oul/participant";
import { privateKeyToAccount } from "viem/accounts";
import type { Harness } from "./actions.ts";
import { type Action, canPay } from "./model.ts";

/**
 * The faults of SPEC.md §9. Each does its damage, checks the outcome it
 * expects, and keeps the model in step with whatever did settle; the
 * per-block invariant checks run underneath all of them.
 */

const run = promisify(execFile);
const COMPOSE = path.join(REPO_ROOT, "infra/besu/generated/compose.yaml");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FaultKind =
  | "validator-down"
  | "service-crash"
  | "listener-behind"
  | "duplicate-submission"
  | "stale-signature"
  | "frozen-counterparty";

export const FAULTS: readonly FaultKind[] = [
  "validator-down",
  "service-crash",
  "listener-behind",
  "duplicate-submission",
  "stale-signature",
  "frozen-counterparty",
];

/** A fault with nothing to act on yet (no tokens to freeze, no payment possible): skipped, not failed. */
export class NotApplicable extends Error {
  override readonly name = "NotApplicable";
}

export async function runFault(h: Harness, kind: FaultKind): Promise<string> {
  switch (kind) {
    case "validator-down":
      return validatorDown(h);
    case "service-crash":
      return serviceCrash(h);
    case "listener-behind":
      return listenerBehind(h);
    case "duplicate-submission":
      return duplicateSubmission(h);
    case "stale-signature":
      return staleSignature(h);
    case "frozen-counterparty":
      return frozenCounterparty(h);
  }
}

function pay(h: Harness): Extract<Action, { kind: "pay" }> {
  if (!canPay(h.model, h.banks)) throw new NotApplicable("no feasible payment yet");
  return h.model.next(h.rng, { kinds: ["pay"] }) as Extract<Action, { kind: "pay" }>;
}

async function steps(h: Harness, count: number, only: Parameters<Harness["model"]["next"]>[1]): Promise<string> {
  const done: string[] = [];
  for (let i = 0; i < count; i++) {
    const action = h.model.next(h.rng, only);
    done.push(`${h.describe(action)} (${await h.perform(action)})`);
  }
  return done.join("; ");
}

/** QBFT tolerates one faulty validator in four: stop one, keep settling, bring it back. */
async function validatorDown(h: Harness): Promise<string> {
  const down = h.rng.pick(h.banks);
  const others = h.banks.filter((b) => b !== down);
  await run("docker", ["compose", "-f", COMPOSE, "stop", `besu-${down}`]);
  let flows: string;
  try {
    flows = await steps(h, 2, { banks: others, kinds: ["fund", "tokenize", "detokenize", "pay", "pvp"] });
  } finally {
    await run("docker", ["compose", "-f", COMPOSE, "start", `besu-${down}`]);
  }
  // The node rejoins, syncs, and its bank's service catches up through it.
  const node = h.clientFor(down);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const head = await h.client.getBlockNumber();
    const there = await node.getBlockNumber().catch(() => -1n);
    if (there >= head - 1n) break;
    if (Date.now() > deadline) throw new Error(`validator ${down} did not resync`);
    await sleep(1000);
  }
  return `validator ${down} stopped while: ${flows}; restarted and resynced`;
}

/** Kill a bank's service the moment a payment is accepted; the payment must still settle, once. */
async function serviceCrash(h: Harness): Promise<string> {
  const action = pay(h);
  const victim = h.rng.next() < 0.5 ? action.payerBank : action.payeeBank;
  const uetr = (await h.start(action))!;
  await h.services.kill(victim, "SIGKILL");
  await sleep(3000);
  await h.services.restart(victim);
  const block = await h.settled(uetr, h.bookers(action));
  h.model.apply(action);
  return `${h.describe(action)}: ${victim} killed mid-flow, restarted; settled once in block ${block}`;
}

/** Stop a participant's service, let the chain move on, and have its listener catch up. */
async function listenerBehind(h: Harness): Promise<string> {
  // A central bank's books follow the chain; with one per currency, any of them.
  const cbDown = h.rng.next() < 0.5;
  const victim = cbDown ? (h.centralBanks.length === 1 ? h.cb : h.rng.pick(h.centralBanks)) : h.rng.pick(h.banks);
  const others = cbDown ? h.banks : h.banks.filter((b) => b !== victim);
  const kinds = cbDown ? (["tokenize", "detokenize", "pay", "pvp"] as const) : (["fund", "tokenize", "detokenize", "pay", "pvp"] as const);
  const from = await h.client.getBlockNumber();
  await h.services.kill(victim, "SIGTERM");
  let flows: string;
  try {
    flows = await steps(h, 3, { banks: others, kinds: [...kinds] });
  } finally {
    await h.services.restart(victim);
  }
  const head = await h.client.getBlockNumber();
  const deadline = Date.now() + 120_000;
  for (;;) {
    const health = await h.api(victim, "GET", "/health");
    if (health.body["reconciledBlock"] !== null && BigInt(health.body["reconciledBlock"]) >= head) {
      return `${victim} stopped for ${head - from} blocks while: ${flows}; caught up and reconciled at block ${health.body["reconciledBlock"]}`;
    }
    if (Date.now() > deadline) throw new Error(`${victim} did not catch up to block ${head}`);
    await sleep(500);
  }
}

/** The same payment requested three times at once, then resubmitted on chain after it settled. */
async function duplicateSubmission(h: Harness): Promise<string> {
  const action = pay(h);
  const uetr = randomUUID();
  const answers = await Promise.all([0, 1, 2].map(() => h.start(action, uetr)));
  if (answers.some((a) => a !== uetr)) throw new Error(`retries answered ${answers.join(", ")}`);
  const block = await h.settled(uetr, h.bookers(action));
  h.model.apply(action);

  const view = (await h.api(action.payerBank, "GET", `/instructions/${uetr}`)).body;
  const flow: Flow = {
    kind: "interbank",
    uetr,
    deadline: Math.floor(Date.parse(view["deadline"]) / 1000),
    payerBank: action.payerBank,
    payer: action.payer,
    payeeBank: action.payeeBank,
    payee: action.payee,
    amount: action.amount.toString(),
  };
  const refusal = await h.rawSettle(action.payerBank, legsOf(flow, h), []);
  if (refusal !== "AlreadySettled") throw new Error(`a resubmitted instruction was ${refusal}`);
  return `${h.describe(action)}: 3 concurrent requests, one instruction settled in block ${block}; resubmitted on chain → ${refusal}`;
}

/** Approvals that do not cover what is submitted: signed for other legs, or past the deadline. */
async function staleSignature(h: Harness): Promise<string> {
  const peersOf = (bank: string) => h.banks.filter((b) => b !== bank && h.currencyOf(b) === h.currencyOf(bank));
  const payerBank = h.rng.pick(h.banks.filter((b) => peersOf(b).length > 0));
  const payeeBank = h.rng.pick(peersOf(payerBank));
  const customer = (bank: string) => h.rng.pick([...h.model.banks.get(bank)!.deposits.keys()]);
  const now = await h.chainTime();
  const base: Flow = {
    kind: "interbank",
    uetr: randomUUID(),
    deadline: Number(now) + 600,
    payerBank,
    payer: customer(payerBank),
    payeeBank,
    payee: customer(payeeBank),
    amount: "1",
  };
  const payee = privateKeyToAccount(devKeys.participant(payeeBank));
  const engine = h.deployment.contracts.engine;
  const approval = await approve(payee, h.network.chainId, engine, legsOf(base, h));
  const altered = await h.rawSettle(payerBank, legsOf({ ...base, amount: "2" }, h), [approval]);
  if (altered !== "InvalidApproval") throw new Error(`an approval for other legs was ${altered}`);

  const late: Flow = { ...base, uetr: randomUUID(), deadline: Number(now) - 10 };
  const lateApproval = await approve(payee, h.network.chainId, engine, legsOf(late, h));
  const expired = await h.rawSettle(payerBank, legsOf(late, h), [lateApproval]);
  if (expired !== "InstructionExpired") throw new Error(`an instruction past its deadline was ${expired}`);
  return `${payerBank} submitted on chain an approval from ${payeeBank} for other legs → ${altered}; one past its deadline → ${expired}`;
}

/**
 * A bank freezes its customer's tokens on chain behind its own books, then the
 * customer pays: the engine refuses, the payer's entry is voided, the payee's
 * side expires, and nothing moves.
 */
async function frozenCounterparty(h: Harness): Promise<string> {
  const candidates = h.banks.flatMap((bank) => {
    const state = h.model.banks.get(bank)!;
    const peers = h.banks.some((b) => b !== bank && h.currencyOf(b) === h.currencyOf(bank));
    return peers && h.model.wholesale(bank) > 0n ? [...state.tokenized].filter(([, t]) => t > 0n).map(([c, t]) => ({ bank, customer: c, held: t })) : [];
  });
  if (candidates.length === 0) throw new NotApplicable("no customer holds tokens to freeze yet");
  const { bank, customer, held } = h.rng.pick(candidates);
  const payeeBank = h.rng.pick(h.banks.filter((b) => b !== bank && h.currencyOf(b) === h.currencyOf(bank)));
  const payee = h.rng.pick([...h.model.banks.get(payeeBank)!.deposits.keys()]);
  const wholesale = h.model.wholesale(bank);
  const amount = h.rng.share(held < wholesale ? held : wholesale);

  const symbol = h.scenario.instruments.deposits.find((d) => d.issuer === bank)!.symbol;
  const token = h.deployment.tokens[symbol]!.address;
  const holder = h.deployment.customers[`${bank}/${customer}`]!.address;
  await h.tokenCall(bank, token, "setFrozenTokens", [holder, held]);
  try {
    const action = { kind: "pay", payerBank: bank, payer: customer, payeeBank, payee, amount, overspend: false } as const;
    const uetr = (await h.start(action))!;
    const [payer] = await h.waitFor(uetr, [bank], ["failed"]);
    await h.waitFor(uetr, [payeeBank], ["expired"]);
    const status = String((await h.api(bank, "GET", `/instructions/${uetr}/messages/pacs.002`)).body["raw"] ?? "");
    if (!status.includes("<TxSts>RJCT</TxSts>")) throw new Error("the payer's pacs.002 does not report RJCT");
    return `${h.describe(action)} with the payer's tokens frozen: ${payer!["error"]}; ${payeeBank}'s side expired; pacs.002 RJCT`;
  } finally {
    await h.tokenCall(bank, token, "setFrozenTokens", [holder, 0n]);
  }
}
