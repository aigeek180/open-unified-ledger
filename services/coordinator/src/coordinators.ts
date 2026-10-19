import { appendFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { type Hex, sha256 } from "viem";
import { hashlockCondition, type InteropWorld, notaryCondition, sleep, type Transfer } from "./ledgers.ts";

/**
 * Interop mode's three coordinators behind one interface (SPEC.md §7), and
 * the faults injected into each. A coordinator moves one transfer: the
 * unified one on the shared ledger in one transaction; the HTLC and notary
 * ones across both ledgers, each part locked and then settled or released on
 * its own ledger by ConditionalSettlement. The ledgers are real; each fault is
 * a party doing, at one step, what a crash, a lost message, an outage or a
 * slow commit would make it do.
 */

export type CoordinatorName = "unified" | "htlc" | "notary";
export type Fault = "none" | "coordinator-crash" | "message-loss" | "participant-offline" | "late-commit";

export const COORDINATOR_NAMES: readonly CoordinatorName[] = ["unified", "htlc", "notary"];
export const FAULT_NAMES: readonly Fault[] = ["none", "coordinator-crash", "message-loss", "participant-offline", "late-commit"];

/**
 * What each fault is, for each coordinator: who does what, and when. Bank A
 * is the payer's bank; on ledger 2 the counterparty is the payee's bank, or
 * across currencies the dealer, which delivers the target currency there.
 */
export function faultStory(world: InteropWorld, coordinator: CoordinatorName, fault: Fault): string {
  const a = world.nameOf(world.payerBank);
  const b = world.nameOf(world.counterparty);
  const payee = world.nameOf(world.payeeBank);
  const signers = world.dealer ? `${b}'s and ${payee}'s signatures` : `${b}'s signature`;
  const legs = world.dealer ? "all four legs" : "all three legs";
  const stories: Record<CoordinatorName, Record<Fault, string>> = {
    unified: {
      none: `${a} gets ${signers} and settles ${legs} in one transaction.`,
      "coordinator-crash": `${a}, which submits, crashes once it has ${signers} and restarts 10 seconds later.`,
      "message-loss": `${a}'s request for ${signers} is lost; ${a} asks again 8 seconds later.`,
      "participant-offline": `${b} is offline until past the instruction's deadline and never signs.`,
      "late-commit": `${a} sends the instruction only once its deadline has passed.`,
    },
    htlc: {
      none: `Both lock; ${a} claims on ledger 2 with the secret; ${b} claims on ledger 1 with it.`,
      "coordinator-crash": `${a}, which holds the secret, crashes after both locks and is back only after both timeouts.`,
      "message-loss": `${a}'s payment message to ${b}, carrying the hashlock, is lost; ${b} never locks.`,
      "participant-offline": `${b} goes offline once the payee is credited and is back only after ledger 1's timeout.`,
      "late-commit": `${b}'s claim on ledger 1 is sent in the last second before the timeout and lands after it.`,
    },
    notary: {
      none: "Both lock naming the notary; it commits ledger 1, then ledger 2.",
      "coordinator-crash": "The notary crashes between its two commits and restarts after ledger 2's timeout.",
      "message-loss": "The notary's commit to ledger 2 is lost; it checks 8 seconds later and sends it again.",
      "participant-offline": `${b} is offline and never locks; the notary aborts.`,
      "late-commit": "The notary's commit to ledger 2 is sent in the last second before the timeout and lands after it.",
    },
  };
  return stories[coordinator][fault];
}

/** The outcome each case must end in: the windows SPEC.md §7 says each coordinator has, and the unified mode's absence of one. */
export const EXPECTED: Record<CoordinatorName, Record<Fault, "committed" | "aborted" | "inconsistent">> = {
  unified: { none: "committed", "coordinator-crash": "committed", "message-loss": "committed", "participant-offline": "aborted", "late-commit": "aborted" },
  htlc: { none: "committed", "coordinator-crash": "aborted", "message-loss": "aborted", "participant-offline": "inconsistent", "late-commit": "inconsistent" },
  notary: { none: "committed", "coordinator-crash": "inconsistent", "message-loss": "committed", "participant-offline": "aborted", "late-commit": "inconsistent" },
};

/** Timeouts, in seconds of ledger time, short enough for a demonstration. */
export const TIMING = { htlcLong: 40n, htlcShort: 20n, notary: 30n, deadline: 30n } as const;

export interface RunContext {
  readonly world: InteropWorld;
  readonly transfer: Transfer;
  readonly fault: Fault;
  /** Something a party did or saw, for the run's narrative. */
  readonly note: (actor: string, text: string) => void;
  /** Where the notary keeps its decisions, so a restarted notary finishes what it decided. */
  readonly notaryLog: string;
}

export type Coordinator = (ctx: RunContext) => Promise<void>;

/** A message between parties, off any ledger: the thing a lost-message fault drops. */
class Mailbox<T> {
  private value: T | undefined;
  private waiters: ((value: T) => void)[] = [];
  deliver(value: T): void {
    this.value = value;
    for (const w of this.waiters) w(value);
    this.waiters = [];
  }
  /** The message, or undefined if none came before `give` resolves. */
  receive(give: Promise<void>): Promise<T | undefined> {
    if (this.value !== undefined) return Promise.resolve(this.value);
    return Promise.race([new Promise<T>((resolve) => this.waiters.push(resolve)), give.then(() => undefined)]);
  }
}

const outcomeOf = (sent: { ok: true; block: bigint } | { ok: false; reason: string }) =>
  sent.ok ? `in block ${sent.block}` : `refused: ${sent.reason}`;

// ---------------------------------------------------------------- unified

const unified: Coordinator = async ({ world, transfer, fault, note }) => {
  const a = world.payerBank;
  const b = world.counterparty;
  const deadline = (await world.l1.now()) + TIMING.deadline;
  const legs = world.unifiedLegs(transfer);
  const instruction = world.instruction(transfer, legs, deadline);
  note(a, `prepares one instruction of ${legs.length} legs on the shared ledger, deadline in ${TIMING.deadline}s`);

  if (fault === "participant-offline") {
    note(b, "is offline");
    await world.l1.until(deadline + 1n);
    note(a, `reaches the deadline without ${world.nameOf(b)}'s signature; nothing was sent, nothing moved`);
    return;
  }
  if (fault === "message-loss") {
    note(a, `asks ${world.nameOf(b)} to sign; the request is lost`);
    await sleep(8_000);
    note(a, "has no answer and asks again");
  }
  const approvals = await world.unifiedApprovals(instruction);
  if (world.dealer) note(world.dealer, "signs: its wholesale in the target currency leaves it");
  note(world.payeeBank, "signs: the mint creates its liability");
  if (fault === "coordinator-crash") {
    note(a, "crashes before sending");
    await sleep(10_000);
    note(a, "restarts and sends the same instruction");
  }
  if (fault === "late-commit") {
    await world.l1.until(deadline + 1n);
    note(a, "sends after the deadline");
  }
  const sent = await world.settle(a, instruction, approvals);
  note(a, `all ${legs.length} legs ${sent.ok ? "settled together" : "settled not at all"}, ${outcomeOf(sent)}`);
};

// ---------------------------------------------------------------- HTLC

const htlc: Coordinator = async ({ world, transfer, fault, note }) => {
  const a = world.payerBank;
  const b = world.counterparty;
  const secret = `0x${randomBytes(32).toString("hex")}` as Hex;
  const hashlock = sha256(secret);
  const t1 = (await world.l1.now()) + TIMING.htlcLong;
  const paymentMessage = new Mailbox<{ hashlock: Hex; t1: bigint }>();
  const l1Gone = world.l1.until(t1 + 2n);

  const bankA = async () => {
    const locked = await world.l1.lock(a, world.instruction(transfer, world.ledger1Legs(transfer), t1), hashlockCondition(hashlock, t1));
    note(a, `locks ledger 1's part under the hash of its secret, timeout in ${TIMING.htlcLong}s: ${outcomeOf(locked)}`);
    if (!locked.ok) return;
    if (fault === "message-loss") note(a, `sends ${world.nameOf(b)} the payment message with the hashlock; it is lost`);
    else paymentMessage.deliver({ hashlock, t1 });

    // Wait for Bank B's lock on ledger 2, until ledger 1's timeout.
    let l2Locked = false;
    while ((await world.l1.now()) < t1) {
      if ((await world.l2.lockOf(transfer.id)).state === "locked") {
        l2Locked = true;
        break;
      }
      await sleep(500);
    }
    if (l2Locked) {
      if (fault === "coordinator-crash") {
        note(a, "crashes before revealing the secret");
        await world.l1.until(t1 + 2n);
        note(a, "is back, after both timeouts");
      } else {
        const claimed = await world.l2.claim(a, transfer.id, secret);
        note(a, `claims ledger 2's part with the secret, crediting the payee and publishing the secret: ${outcomeOf(claimed)}`);
      }
    }
    // Bank A's own watch: take its funds back if ledger 1's part has not settled by its timeout.
    await world.l1.until(t1);
    if ((await world.l1.lockOf(transfer.id)).state === "locked") {
      const refunded = await world.l1.refund(a, transfer.id);
      note(a, `ledger 1's timeout passed unsettled; refunds its part: ${outcomeOf(refunded)}`);
    }
  };

  const bankB = async () => {
    const message = await paymentMessage.receive(l1Gone);
    if (!message) {
      note(b, "never hears of the payment, so never locks");
      return;
    }
    // Check ledger 1 holds what the message says before creating anything here.
    const l1 = await world.l1.lockOf(transfer.id);
    if (l1.state !== "locked" || l1.timeout !== message.t1) {
      note(b, "does not find ledger 1's part locked as described; does nothing");
      return;
    }
    const t2 = (await world.l2.now()) + TIMING.htlcShort;
    const part = world.instruction(transfer, world.ledger2Legs(transfer), t2);
    const condition = hashlockCondition(message.hashlock, t2);
    const locked = await world.l2.lock(b, part, condition, await world.ledger2Approvals(part, condition));
    const what = world.dealer ? `its ${world.targetCurrency} to ${world.nameOf(world.payeeBank)} and the payee's mint, co-signed by ${world.nameOf(world.payeeBank)},` : "the payee's mint";
    note(b, `sees ledger 1 locked and locks ${what} on ledger 2 under the same hash, timeout in ${TIMING.htlcShort}s: ${outcomeOf(locked)}`);
    if (!locked.ok) return;

    // Wait for the secret to appear on ledger 2, until its own timeout.
    let preimage: Hex | undefined;
    while ((await world.l2.now()) < t2) {
      preimage = await world.l2.publishedPreimage(transfer.id);
      if (preimage) break;
      await sleep(500);
    }
    if (!preimage) {
      await world.l2.until(t2);
      const refunded = await world.l2.refund(b, transfer.id);
      note(b, `the secret never came; refunds ledger 2's part at its timeout: ${outcomeOf(refunded)}`);
      return;
    }
    note(b, "reads the secret on ledger 2");
    if (fault === "participant-offline") {
      note(b, "goes offline");
      await world.l1.until(message.t1 + 2n);
      note(b, "is back, after ledger 1's timeout");
    }
    if (fault === "late-commit") {
      await world.l1.until(message.t1 - 1n);
      note(b, "sends its claim in the last second before ledger 1's timeout");
    }
    const claimed = await world.l1.claim(b, transfer.id, preimage);
    note(b, `claims ledger 1's part with the secret: ${outcomeOf(claimed)}`);
  };

  await Promise.all([bankA(), bankB()]);
};

// ---------------------------------------------------------------- notary two-phase commit

interface Decision {
  readonly id: Hex;
  readonly decision: "commit" | "abort";
}

/** The notary's decisions, durable before it acts on them: what a restarted notary finishes. */
class NotaryLog {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  async decide(d: Decision): Promise<void> {
    await appendFile(this.file, `${JSON.stringify(d)}\n`);
  }
  async decisionFor(id: Hex): Promise<Decision | undefined> {
    const text = await readFile(this.file, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Decision)
      .find((d) => d.id === id);
  }
}

const notary: Coordinator = async ({ world, transfer, fault, note, notaryLog }) => {
  const a = world.payerBank;
  const b = world.counterparty;
  const n = world.notary;
  const log = new NotaryLog(notaryLog);
  const t1 = (await world.l1.now()) + TIMING.notary;
  const t2 = (await world.l2.now()) + TIMING.notary;
  note(n.id, `asks both banks to lock their parts naming it, timeouts in ${TIMING.notary}s`);

  // Phase one: each bank locks its own part, and keeps watch to refund it after its timeout.
  const bankLock = async (bank: string, ledger: typeof world.l1, legs: ReturnType<typeof world.ledger1Legs>, timeout: bigint) => {
    if (bank === b && fault === "participant-offline") {
      note(b, "is offline and does not lock");
      return;
    }
    const part = world.instruction(transfer, legs, timeout);
    const condition = notaryCondition(n.address, timeout);
    const approvals = ledger === world.l2 ? await world.ledger2Approvals(part, condition) : [];
    const locked = await ledger.lock(bank, part, condition, approvals);
    note(bank, `locks its part on ${ledger.name}: ${outcomeOf(locked)}`);
    if (!locked.ok) return;
    await ledger.until(timeout);
    if ((await ledger.lockOf(transfer.id)).state === "locked") {
      const refunded = await ledger.refund(bank, transfer.id);
      note(bank, `its part on ${ledger.name} is past its timeout uncommitted; refunds it: ${outcomeOf(refunded)}`);
    }
  };
  const watches = [bankLock(a, world.l1, world.ledger1Legs(transfer), t1), bankLock(b, world.l2, world.ledger2Legs(transfer), t2)];

  const coordinate = async () => {
    // Wait for both locks, leaving time to commit before the timeouts.
    const prepareBy = t1 - 12n;
    let prepared = false;
    while ((await world.l1.now()) < prepareBy) {
      const [p1, p2] = await Promise.all([world.l1.lockOf(transfer.id), world.l2.lockOf(transfer.id)]);
      if (p1.state === "locked" && p2.state === "locked") {
        prepared = true;
        break;
      }
      await sleep(500);
    }
    const decision: Decision = { id: transfer.id, decision: prepared ? "commit" : "abort" };
    await log.decide(decision);
    note(n.id, prepared ? "sees both parts locked; decides to commit, and logs it" : "has not seen both parts locked in time; decides to abort, and logs it");

    if (!prepared) {
      for (const ledger of [world.l1, world.l2]) {
        if ((await ledger.lockOf(transfer.id)).state === "locked") note(n.id, `aborts ${ledger.name}'s part: ${outcomeOf(await ledger.abort(n.id, transfer.id))}`);
      }
      return;
    }
    note(n.id, `commits ledger 1's part: ${outcomeOf(await world.l1.commit(n.id, transfer.id))}`);

    if (fault === "coordinator-crash") {
      note(n.id, "crashes before committing ledger 2");
      await world.l2.until(t2 + 2n);
      note(n.id, "restarts and reads its log");
      await recoverNotary(world, transfer, log, note);
      return;
    }
    if (fault === "message-loss") {
      note(n.id, "sends the commit to ledger 2; it is lost");
      await sleep(8_000);
      if ((await world.l2.lockOf(transfer.id)).state === "locked") {
        note(n.id, `finds ledger 2's part still locked and sends the commit again: ${outcomeOf(await world.l2.commit(n.id, transfer.id))}`);
      }
      return;
    }
    if (fault === "late-commit") {
      await world.l2.until(t2 - 1n);
      note(n.id, "sends the commit to ledger 2 in the last second before its timeout");
    }
    note(n.id, `commits ledger 2's part: ${outcomeOf(await world.l2.commit(n.id, transfer.id))}`);
  };

  await Promise.all([coordinate(), ...watches]);
};

/** A restarted notary finishes what its log says it decided, for whatever parts are still locked. */
async function recoverNotary(world: InteropWorld, transfer: Transfer, log: NotaryLog, note: RunContext["note"]): Promise<void> {
  const decided = await log.decisionFor(transfer.id);
  if (!decided) {
    note(world.notary.id, "finds no decision; the banks' timeouts will release their parts");
    return;
  }
  for (const ledger of [world.l1, world.l2]) {
    if ((await ledger.lockOf(transfer.id)).state !== "locked") {
      note(world.notary.id, `finds ${ledger.name}'s part already ${(await ledger.lockOf(transfer.id)).state}`);
      continue;
    }
    const sent = decided.decision === "commit" ? await ledger.commit(world.notary.id, transfer.id) : await ledger.abort(world.notary.id, transfer.id);
    note(world.notary.id, `${decided.decision}s ${ledger.name}'s part: ${outcomeOf(sent)}`);
  }
}

export const COORDINATORS: Record<CoordinatorName, Coordinator> = { unified, htlc, notary };
