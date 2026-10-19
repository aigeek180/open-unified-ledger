import { type CollateralLine, collateralValue, convert, formatMoney, isCovered, money, type RepoTerms, repurchasePrice } from "@oul/domain";
import { dealerOf, depositOf, fxRate, wholesaleFor } from "@oul/scenario";
import type { Movement } from "./adapter.ts";
import { type KitFlow, kitMarks, type Leg, repoCurrency } from "./flows.ts";
import { type Trace, TraceIndex } from "./trace.ts";

/**
 * The checks of SPEC.md §14: §6's invariants stated against the adapter
 * alone. Each reads a recorded run (a `Trace`) and nothing else, and says
 * pass, fail with what failed, or skipped with what it would need.
 * docs/conformance.md states what each proves, what it needs and what it
 * cannot see.
 */

export type CheckName =
  | "atomicity"
  | "exactly-once"
  | "authority"
  | "eligibility"
  | "supply-equals-liability"
  | "liability-conservation"
  | "books-equal-ledger"
  | "fx-consistency"
  | "repo-collateral";

export interface CheckResult {
  readonly name: CheckName;
  /** The invariants of SPEC.md §6 it states. */
  readonly invariants: string;
  readonly status: "pass" | "fail" | "skipped";
  /** On a pass, what was checked; on a skip, why. */
  readonly summary: string;
  /** On a fail, each thing that failed (the first few). */
  readonly failures: readonly string[];
}

export interface Check {
  readonly name: CheckName;
  readonly invariants: string;
  run(index: TraceIndex): CheckResult;
}

const MAX_FAILURES = 12;

function result(check: Pick<Check, "name" | "invariants">, failures: string[], summary: string): CheckResult {
  return {
    name: check.name,
    invariants: check.invariants,
    status: failures.length === 0 ? "pass" : "fail",
    summary,
    failures: failures.length > MAX_FAILURES ? [...failures.slice(0, MAX_FAILURES), `… and ${failures.length - MAX_FAILURES} more`] : failures,
  };
}

function skipped(check: Pick<Check, "name" | "invariants">, why: string): CheckResult {
  return { name: check.name, invariants: check.invariants, status: "skipped", summary: why, failures: [] };
}

/** Which of a flow's legs each movement settles: index into `legs`, or -1 for one the flow does not move. */
function matchLegs(index: TraceIndex, legs: readonly Leg[], movements: readonly Movement[]): { matched: number[]; target?: bigint } {
  const used = new Set<number>();
  let target: bigint | undefined;
  const matched = movements.map((m) => {
    const i = legs.findIndex((leg, n) => {
      if (used.has(n) || index.symbolOf(m.token) !== leg.symbol) return false;
      const from = leg.from === null ? null : index.addressOf(leg.from);
      const to = leg.to === null ? null : index.addressOf(leg.to);
      if ((m.from?.toLowerCase() ?? null) !== from || (m.to?.toLowerCase() ?? null) !== to) return false;
      if (leg.amount === "target") return target === undefined || m.amount === target;
      return m.amount === leg.amount;
    });
    if (i >= 0) {
      used.add(i);
      if (legs[i]!.amount === "target") target = m.amount;
    }
    return i;
  });
  return target === undefined ? { matched } : { matched, target };
}

const legKey = (indices: readonly number[]) => [...indices].sort((a, b) => a - b).join(",");

/**
 * Atomicity (invariant 5): every instruction moves all of its flow's legs or
 * none. On one ledger its legs settle in one transaction: every transaction
 * under an id carries the same legs. Across ledgers each ledger's part
 * settles whole, and the parts together are every leg, or there are none: a
 * run that ends with one ledger's part settled and another's not fails. No
 * transaction moves a token outside an instruction, none moves anything its
 * flow does not, and what the engine reported (settled or refused) is what
 * the ledgers show.
 */
export const atomicity: Check = {
  name: "atomicity",
  invariants: "5",
  run(index) {
    const failures: string[] = [];
    let whole = 0;
    let crossing = 0;
    let widest = 0n;
    for (const s of index.unattributed) {
      failures.push(`block ${s.block} on ${s.ledger}: ${s.movements.map((m) => index.describe(m)).join(", ")} outside any instruction`);
    }
    for (const [id, settlements] of index.settlementsById) {
      const record = index.byId.get(id);
      if (!record) {
        failures.push(`${id} settled on ${settlements[0]!.ledger} in block ${settlements[0]!.block}, but no flow the kit asked for has that id`);
        continue;
      }
      const parts = new Map<string, string>();
      const covered = new Set<number>();
      let split = false;
      for (const s of settlements) {
        const { matched } = matchLegs(index, record.legs, s.movements);
        const extra = s.movements.filter((_, i) => matched[i]! < 0);
        if (extra.length > 0) failures.push(`${id} (${record.flow.kind}) moved what its flow does not: ${extra.map((m) => index.describe(m)).join(", ")}`);
        const key = legKey(matched.filter((i) => i >= 0));
        const seen = parts.get(s.ledger);
        if (seen !== undefined && seen !== key && !split) {
          split = true;
          const count = settlements.filter((x) => x.ledger === s.ledger).length;
          failures.push(`${id} (${record.flow.kind}): its legs settled in ${count} transactions on ${s.ledger}, not one`);
        }
        if (seen === undefined) parts.set(s.ledger, key);
        for (const i of matched) if (i >= 0) covered.add(i);
      }
      if (parts.size > 1) {
        crossing++;
        const times = [...parts.keys()].map((ledger) => {
          const first = settlements.find((s) => s.ledger === ledger)!;
          return index.observation(ledger, first.block)?.time ?? 0n;
        });
        const window = times.reduce((a, b) => (a > b ? a : b)) - times.reduce((a, b) => (a < b ? a : b));
        if (window > widest) widest = window;
      }
      const missing = record.legs.map((_, i) => i).filter((i) => !covered.has(i));
      if (missing.length > 0) {
        const where = [...parts.keys()].join(" and ");
        failures.push(
          `${id} (${record.flow.kind}) ended partly settled: ${covered.size} of ${record.legs.length} legs, on ${where}; never: ${missing.map((i) => describeLeg(record.legs[i]!)).join(", ")}`,
        );
      } else if (!split) whole++;
      if (record.outcome.status === "refused") {
        failures.push(`${id} (${record.flow.kind}) was reported refused (${record.outcome.reason ?? "no reason"}), yet it moved tokens`);
      }
    }
    for (const record of index.byId.values()) {
      if (record.outcome.status === "settled" && !index.settlementsById.has(record.flow.id) && record.legs.length > 0) {
        failures.push(`${record.flow.id} (${record.flow.kind}) was reported settled, yet no ledger shows it`);
      }
    }
    const across = crossing > 0 ? `; ${crossing} crossed ledgers, the widest ${widest}s between their parts` : "";
    return result(atomicity, failures, `${whole} instructions each settled whole, every other flow moved nothing${across}`);
  },
};

function describeLeg(leg: Leg): string {
  return `${leg.amount === "target" ? "the target amount" : leg.amount} ${leg.symbol} ${leg.from ?? "∅"}→${leg.to ?? "∅"}`;
}

/**
 * Exactly once (invariant 6): an instruction id settles at most once,
 * however often it is submitted: no movement under an id happens twice.
 */
export const exactlyOnce: Check = {
  name: "exactly-once",
  invariants: "6",
  run(index) {
    const failures: string[] = [];
    let ids = 0;
    for (const [id, settlements] of index.settlementsById) {
      ids++;
      const seen = new Map<string, number>();
      for (const s of settlements) {
        for (const m of s.movements) {
          const key = `${s.ledger}|${m.token}|${m.from}|${m.to}|${m.amount}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      const repeated = [...seen.values()].filter((n) => n > 1);
      if (repeated.length > 0) {
        const blocks = [...new Set(settlements.map((s) => `${s.block}`))].join(", ");
        failures.push(`${id} settled ${Math.max(...repeated)} times (blocks ${blocks})`);
      }
    }
    const resent = index.trace.flows.filter((r) => r.source === "attempt" && index.trace.flows.some((o) => o !== r && o.flow.id === r.flow.id)).length;
    return result(exactlyOnce, failures, `${ids} instruction ids each settled once${resent ? `, ${resent} resubmitted` : ""}`);
  },
};

/**
 * Authority (invariant 9): no movement settles without the approval of the
 * participant whose liability it creates (a mint: the token's issuer) or
 * whose account it debits (a burn or transfer out: the holder, or for a
 * customer address, its bank, the token's issuer).
 */
export const authority: Check = {
  name: "authority",
  invariants: "9",
  run(index) {
    const failures: string[] = [];
    let movements = 0;
    const all = [...[...index.settlementsById.values()].flat(), ...index.unattributed];
    for (const s of all) {
      for (const m of s.movements) {
        movements++;
        const issuer = index.directory.tokens[m.token]?.issuer;
        const needed = m.from === null ? issuer : (index.participantAt(m.from) ?? issuer);
        if (!needed || !s.approvers.includes(needed)) {
          failures.push(
            `${s.id ?? `block ${s.block}`}: ${index.describe(m)} without ${needed ?? "an identifiable"}'s approval (approved by ${s.approvers.join(", ") || "no one"})`,
          );
        }
      }
    }
    return result(authority, failures, `${movements} movements, each approved by whoever's account or liability it touched`);
  },
};

/**
 * Eligibility (invariant 7): no movement lands on an address the token's
 * issuer has not admitted, and none takes frozen tokens: within an
 * instruction, what leaves a holder is at most its balance not frozen.
 */
export const eligibility: Check = {
  name: "eligibility",
  invariants: "7",
  run(index) {
    const failures: string[] = [];
    let credits = 0;
    for (const ledger of index.directory.ledgers) {
      const list = index.trace.observations.get(ledger) ?? [];
      for (let n = 1; n < list.length; n++) {
        const [before, after] = [list[n - 1]!, list[n]!];
        const status = (o: typeof after, token: string, holder: string) =>
          o.holders.find((h) => h.token === token && h.holder.toLowerCase() === holder.toLowerCase());
        const running = new Map<string, bigint>();
        const balance = (token: string, holder: string) => {
          const key = `${token}|${holder.toLowerCase()}`;
          return running.get(key) ?? before.balances.find((b) => b.token === token && b.holder.toLowerCase() === holder.toLowerCase())?.amount ?? 0n;
        };
        for (const s of [...after.settlements].sort((a, b) => a.index - b.index)) {
          for (const m of s.movements) {
            if (m.to !== null) {
              credits++;
              const [was, is] = [status(before, m.token, m.to), status(after, m.token, m.to)];
              if (!was && !is) failures.push(`${s.id ?? `block ${s.block}`}: no holder status reported for ${index.partyAt(m.to) ?? m.to} on ${index.symbolOf(m.token)}`);
              else if (!was?.admitted && !is?.admitted) failures.push(`${s.id ?? `block ${s.block}`}: ${index.describe(m)} landed on ${index.partyAt(m.to) ?? m.to}, which ${index.symbolOf(m.token)}'s issuer has not admitted`);
            }
            if (m.from !== null && s.id !== null) {
              const frozen = [status(before, m.token, m.from)?.frozen ?? 0n, status(after, m.token, m.from)?.frozen ?? 0n].reduce((a, b) => (a < b ? a : b));
              const held = balance(m.token, m.from);
              if (m.amount > held - frozen) {
                failures.push(`${s.id}: ${index.describe(m)} took frozen tokens (${held} held, ${frozen} frozen)`);
              }
            }
            if (m.from !== null) running.set(`${m.token}|${m.from.toLowerCase()}`, balance(m.token, m.from) - m.amount);
            if (m.to !== null) running.set(`${m.token}|${m.to.toLowerCase()}`, balance(m.token, m.to) + m.amount);
          }
        }
      }
    }
    return result(eligibility, failures, `${credits} credits, each to an admitted holder, and no frozen tokens moved`);
  },
};

/** The books blocks each participant reported, in order. */
function bookBlocks(index: TraceIndex, participant: string): bigint[] {
  return [...(index.trace.books.get(participant)?.keys() ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Supply equals liability (invariants 2, 3): each cash token's total supply
 * is the liability its issuer's books record for it, at every block where
 * tokens moved.
 */
export const supplyEqualsLiability: Check = {
  name: "supply-equals-liability",
  invariants: "2, 3",
  run(index) {
    if (!index.trace.capabilities.books) return skipped(supplyEqualsLiability, "the engine keeps no books the kit can read");
    const failures: string[] = [];
    let compared = 0;
    const ledger = index.directory.ledgers[0]!;
    for (const [key, token] of Object.entries(index.directory.tokens)) {
      if (token.kind === "bond" || token.ledger !== ledger) continue;
      for (const block of bookBlocks(index, token.issuer)) {
        const books = index.trace.books.get(token.issuer)!.get(block)!;
        const supply = index.observation(ledger, block)?.supplies[key];
        const issued = books.issued.find((i) => i.token === key)?.amount;
        if (supply === undefined) continue;
        compared++;
        if (issued === undefined) failures.push(`block ${block}: ${token.issuer}'s books record no liability for ${token.symbol}`);
        else if (issued !== supply) failures.push(`block ${block}: ${token.symbol} supply ${supply}, ${token.issuer}'s books ${issued}`);
      }
    }
    return result(supplyEqualsLiability, failures, `${compared} supplies, each equal to its issuer's recorded liability`);
  },
};

/** The on-ledger balances each participant's books must mirror: what it holds, and what it owes. */
function expectedMirrors(index: TraceIndex, participant: string): { token: string; holder: string }[] {
  const { scenario } = index.trace;
  const meta = scenario.participants.find((p) => p.id === participant);
  const out: { token: string; holder: string }[] = [];
  const token = (symbol: string) => index.bookToken(symbol);
  if (meta?.kind === "central-bank") {
    const key = token(wholesaleFor(scenario, meta.currency!).symbol);
    for (const bank of scenario.participants.filter((p) => p.kind === "bank" && p.reserves.includes(meta.currency!))) {
      if (key) out.push({ token: key, holder: index.addressOf(bank.id) });
    }
  } else if (meta?.kind === "bank") {
    for (const currency of meta.reserves) {
      const key = token(wholesaleFor(scenario, currency).symbol);
      if (key) out.push({ token: key, holder: index.addressOf(participant) });
    }
    const deposit = token(depositOf(scenario, participant).symbol);
    for (const [ref, c] of Object.entries(index.directory.customers)) {
      if (c.bank === participant && deposit) out.push({ token: deposit, holder: index.addressOf(ref) });
    }
    for (const bond of scenario.instruments.bonds) {
      const key = token(bond.symbol);
      if (key && bond.agent !== participant) out.push({ token: key, holder: index.addressOf(participant) });
    }
  }
  return out;
}

/** Where each participant's books disagree with the ledger: `<participant>@<block>`. */
function bookBreaks(index: TraceIndex): { failures: string[]; broken: Set<string>; compared: number } {
  const failures: string[] = [];
  const broken = new Set<string>();
  let compared = 0;
  const ledger = index.directory.ledgers[0]!;
  for (const [participant, byBlock] of index.trace.books) {
    const mirrors = expectedMirrors(index, participant);
    for (const [block, books] of byBlock) {
      const observation = index.observation(ledger, block);
      if (!observation) continue;
      const fail = (text: string) => {
        failures.push(`block ${block}: ${participant} ${text}`);
        broken.add(`${participant}@${block}`);
      };
      for (const [currency, off] of Object.entries(books.imbalance)) {
        if (off !== 0n) fail(`books do not balance: off by ${off} in ${currency}`);
      }
      for (const mirror of mirrors) {
        if (!books.holdings.some((h) => h.token === mirror.token && h.holder.toLowerCase() === mirror.holder)) {
          fail(`books do not mirror ${index.symbolOf(mirror.token)} held by ${index.partyAt(mirror.holder) ?? mirror.holder}`);
        }
      }
      for (const h of books.holdings) {
        compared++;
        const onLedger = observation.balances.find((b) => b.token === h.token && b.holder.toLowerCase() === h.holder.toLowerCase())?.amount ?? 0n;
        if (onLedger !== h.amount) fail(`books say ${h.amount} ${index.symbolOf(h.token)} for ${index.partyAt(h.holder) ?? h.holder}; the ledger says ${onLedger}`);
      }
    }
  }
  return { failures, broken, compared };
}

/**
 * Books equal the ledger (invariants 1, 2, 3, 10): each participant's books
 * balance in each currency, and mirror every on-ledger balance it holds or
 * owes, equal to the ledger at every block where tokens moved.
 */
export const booksEqualLedger: Check = {
  name: "books-equal-ledger",
  invariants: "1, 2, 3, 10",
  run(index) {
    if (!index.trace.capabilities.books) return skipped(booksEqualLedger, "the engine keeps no books the kit can read");
    const { failures, compared } = bookBreaks(index);
    return result(booksEqualLedger, failures, `${compared} mirrored balances, each equal to the ledger`);
  },
};

/**
 * Liability conservation (invariant 4): a bank's deposit liabilities,
 * ordinary and tokenized together, change only by payments to and from its
 * customers and, at a bond's agent, by the issuer's proceeds and payments:
 * tokenizing and detokenizing never change them. Judged where the bank's
 * books equal the ledger; elsewhere books-equal-ledger has failed.
 */
export const liabilityConservation: Check = {
  name: "liability-conservation",
  invariants: "4",
  run(index) {
    if (!index.trace.capabilities.books) return skipped(liabilityConservation, "the engine keeps no books the kit can read");
    const { broken } = bookBreaks(index);
    const failures: string[] = [];
    let judged = 0;
    let unjudged = 0;
    const { scenario } = index.trace;
    const settlements = [...index.settlementsById.values()].flat();
    for (const bank of scenario.participants.filter((p) => p.kind === "bank")) {
      const deposit = index.bookToken(depositOf(scenario, bank.id).symbol);
      const blocks = bookBlocks(index, bank.id);
      for (let n = 1; n < blocks.length; n++) {
        const [b0, b1] = [blocks[n - 1]!, blocks[n]!];
        if (broken.has(`${bank.id}@${b0}`) || broken.has(`${bank.id}@${b1}`)) {
          unjudged++;
          continue;
        }
        const [d0, d1] = [index.trace.books.get(bank.id)!.get(b0)!.deposits, index.trace.books.get(bank.id)!.get(b1)!.deposits];
        if (d0 === undefined || d1 === undefined) {
          failures.push(`${bank.id}'s books report no deposit total`);
          break;
        }
        let expected = 0n;
        const counted = new Set<string>();
        for (const s of settlements) {
          if (s.block <= b0 || s.block > b1 || s.ledger !== index.directory.ledgers[0]) continue;
          const record = index.byId.get(s.id!);
          if (record?.deposits && !counted.has(s.id!)) {
            counted.add(s.id!);
            expected += record.deposits[bank.id] ?? 0n;
          }
          const kind = record?.flow.kind;
          if (kind !== "pay" && kind !== "pay-fx") continue;
          for (const m of s.movements) {
            if (m.token !== deposit) continue;
            if (m.from === null) expected += m.amount;
            if (m.to === null) expected -= m.amount;
          }
        }
        judged++;
        if (d1 - d0 !== expected) {
          const currency = depositOf(scenario, bank.id).currency;
          failures.push(
            `${bank.id}, blocks ${b0}–${b1}: deposits moved by ${formatMoney(money(currency, d1 - d0))}, payments by ${formatMoney(money(currency, expected))}`,
          );
        }
      }
    }
    const note = unjudged > 0 ? `; ${unjudged} where books differ from the ledger left to books-equal-ledger` : "";
    return result(liabilityConservation, failures, `${judged} spans of bank books, deposits moved only by payments and bond flows at the agent${note}`);
  },
};

/**
 * FX consistency (invariant 11): each payment across currencies moved the
 * source amount out of the payer and to the dealer, and the target amount
 * from the dealer and to the payee, where the target is the source at the
 * dealer's rate for that direction, rounded once, half-even, to the target
 * currency's minor unit; and it is what the dealer quoted.
 */
export const fxConsistency: Check = {
  name: "fx-consistency",
  invariants: "11",
  run(index) {
    const { scenario } = index.trace;
    const dealer = dealerOf(scenario);
    if (!dealer) return skipped(fxConsistency, `${scenario.id} has one currency`);
    const failures: string[] = [];
    let checked = 0;
    for (const record of index.byId.values()) {
      const { flow } = record;
      if (flow.kind !== "pay-fx") continue;
      const settlements = index.settlementsById.get(flow.id);
      if (!settlements) continue;
      const [from, to] = [depositOf(scenario, flow.payerBank).currency, depositOf(scenario, flow.payeeBank).currency];
      const rate = fxRate(scenario, from, to);
      const moved = (symbol: string, a: string | null, b: string | null): bigint | undefined => {
        const [x, y] = [a === null ? null : index.addressOf(a), b === null ? null : index.addressOf(b)];
        const m = settlements
          .flatMap((s) => s.movements)
          .find((mv) => index.symbolOf(mv.token) === symbol && (mv.from?.toLowerCase() ?? null) === x && (mv.to?.toLowerCase() ?? null) === y);
        return m?.amount;
      };
      const payer = `${flow.payerBank}/${flow.payer}`;
      const payee = `${flow.payeeBank}/${flow.payee}`;
      const legs = [
        moved(depositOf(scenario, flow.payerBank).symbol, payer, null),
        moved(wholesaleFor(scenario, from).symbol, flow.payerBank, dealer),
        moved(wholesaleFor(scenario, to).symbol, dealer, flow.payeeBank),
        moved(depositOf(scenario, flow.payeeBank).symbol, null, payee),
      ];
      if (legs.some((l) => l === undefined)) continue; // partial: atomicity's to judge
      checked++;
      const [burnt, sent, delivered, minted] = legs as bigint[];
      const expected = rate ? convert(money(from, flow.amount), rate, to).minor : undefined;
      const problems: string[] = [];
      if (burnt !== flow.amount || sent !== flow.amount) problems.push(`moved ${burnt} and ${sent} ${from}, not ${flow.amount}`);
      if (delivered !== minted) problems.push(`delivered ${delivered} ${to} to the payee's bank but minted ${minted}`);
      if (expected === undefined) problems.push(`the dealer quotes no rate from ${from} to ${to}`);
      else if (delivered !== expected) problems.push(`delivered ${delivered} ${to}; ${flow.amount} ${from} at ${rate}, rounded once, half-even, is ${expected}`);
      const quote = record.outcome.quote;
      if (quote && (quote.rate !== rate || quote.source !== flow.amount || quote.target !== delivered)) {
        problems.push(`the quote (${quote.source} at ${quote.rate} → ${quote.target}) is not what settled`);
      }
      if (problems.length > 0) failures.push(`${flow.id}: ${problems.join("; ")}`);
    }
    if (checked === 0) return skipped(fxConsistency, "no payment across currencies settled whole");
    return result(fxConsistency, failures, `${checked} payments across currencies, each at the dealer's rate, rounded once`);
  },
};

/**
 * Repo collateral (invariant 14): replaying each repo the kit opened from
 * what the ledger moved under its flows' ids, the units the lender holds as
 * collateral are its record: after a margin, they cover the cash lent plus
 * interest accrued at the flow's marks, after the haircut; a substitution
 * brings in at least the value it takes out; a close returns every unit and
 * moves exactly the purchase price plus interest, ACT/365F, rounded once,
 * half-even. Where the engine keeps books, each bank's recorded collateral
 * for each repo open at a block is the ledger's.
 */
export const repoCollateral: Check = {
  name: "repo-collateral",
  invariants: "14",
  run(index) {
    const { scenario } = index.trace;
    if (!scenario.repo) return skipped(repoCollateral, `${scenario.id} has no repo`);
    const currency = repoCurrency(scenario);
    const cashKey = index.bookToken(scenario.instruments.wholesale.find((w) => w.currency === currency)!.symbol);
    const failures: string[] = [];
    let repos = 0;
    let flows = 0;
    /** Each repo's collateral after each of its settlements, by block, for comparing books. */
    const timelines = new Map<string, { lender: string; borrower: string; at: { block: bigint; collateral: CollateralLine[] }[] }>();
    const describe = (lines: readonly CollateralLine[]) => (lines.length === 0 ? "none" : lines.map((c) => `${c.units} ${c.bond}`).join(", "));
    for (const open of index.trace.flows) {
      if (open.flow.kind !== "repo-open" || index.byId.get(open.flow.id) !== open) continue;
      const o = open.flow;
      const opened = index.settlementsById.get(o.id);
      if (!opened) continue;
      repos++;
      const terms: RepoTerms = { cash: money(currency, o.cash), rate: o.rate, haircut: o.haircut, startDate: o.startDate, endDate: o.endDate, dayCount: "ACT/365F" };
      const [lender, borrower] = [index.addressOf(o.lender), index.addressOf(o.borrower)];
      // What a settlement moved between the two banks: units to the lender (back, negative) per bond, cash to the lender.
      const moved = (settlements: readonly { movements: readonly { token: string; from: string | null; to: string | null; amount: bigint }[] }[]) => {
        const units = new Map<string, bigint>();
        let cash = 0n;
        for (const m of settlements.flatMap((s) => s.movements)) {
          const [from, to] = [m.from?.toLowerCase(), m.to?.toLowerCase()];
          const sign = from === borrower && to === lender ? 1n : from === lender && to === borrower ? -1n : 0n;
          if (sign === 0n) continue;
          if (m.token === cashKey) cash += sign * m.amount;
          else if (index.directory.tokens[m.token]?.kind === "bond") units.set(index.symbolOf(m.token), (units.get(index.symbolOf(m.token)) ?? 0n) + sign * m.amount);
        }
        return { units, cash };
      };
      const apply = (lines: CollateralLine[], units: Map<string, bigint>) => {
        const next = new Map(lines.map((c) => [c.bond, c.units]));
        for (const [bond, n] of units) next.set(bond, (next.get(bond) ?? 0n) + n);
        return [...next].filter(([, n]) => n !== 0n).map(([bond, n]) => ({ bond, units: n })).sort((a, b) => (a.bond < b.bond ? -1 : 1));
      };
      let collateral = apply([], moved(opened).units);
      const timeline = { lender: o.lender, borrower: o.borrower, at: [{ block: opened[0]!.block, collateral }] };
      timelines.set(o.id, timeline);
      flows++;
      for (const record of index.trace.flows) {
        const flow = record.flow as KitFlow;
        if (!("repo" in flow) || flow.repo !== o.id || index.byId.get(flow.id) !== record) continue;
        const settlements = index.settlementsById.get(flow.id);
        if (!settlements) continue;
        flows++;
        const { units, cash } = moved(settlements);
        const before = collateral;
        collateral = apply(collateral, units);
        timeline.at.push({ block: settlements[0]!.block, collateral });
        if (collateral.some((c) => c.units < 0n)) failures.push(`${flow.id} (${flow.kind}): returned more than the repo held: ${describe(collateral)}`);
        if (flow.kind === "repo-margin") {
          const marks = kitMarks(flow.marks, currency);
          if (!isCovered(terms, collateral, marks, flow.asOf)) {
            failures.push(`${flow.id} (repo-margin): left ${describe(collateral)}, which at its marks after the haircut does not cover the cash plus interest to ${flow.asOf}`);
          }
        } else if (flow.kind === "repo-substitute") {
          const marks = kitMarks(flow.marks, currency);
          const out = [...units].filter(([, n]) => n < 0n).map(([bond, n]) => ({ bond, units: -n }));
          const incoming = [...units].filter(([, n]) => n > 0n).map(([bond, n]) => ({ bond, units: n }));
          if (collateralValue(terms, incoming, marks).lessThan(collateralValue(terms, out, marks))) {
            failures.push(`${flow.id} (repo-substitute): brought in ${describe(incoming)}, worth less at its marks than the ${describe(out)} it took out`);
          }
        } else if (flow.kind === "repo-close") {
          const owed = repurchasePrice(terms).minor;
          if (collateral.length > 0) failures.push(`${flow.id} (repo-close): left ${describe(collateral)} with the lender, of ${describe(before)}`);
          if (cash !== owed) {
            failures.push(`${flow.id} (repo-close): repaid ${formatMoney(money(currency, cash))}; the purchase price plus interest is ${formatMoney(money(currency, owed))}`);
          }
        }
      }
    }
    // Books: each bank's record of each repo open at a block is what the ledger moved by then.
    let compared = 0;
    if (index.trace.capabilities.books) {
      for (const [participant, byBlock] of index.trace.books) {
        for (const [block, books] of byBlock) {
          if (!books.repos) continue;
          for (const [id, timeline] of timelines) {
            if (timeline.lender !== participant && timeline.borrower !== participant) continue;
            const at = [...timeline.at].reverse().find((t) => t.block <= block);
            const open = at !== undefined && at.collateral.length > 0;
            const reported = books.repos.find((r) => r.repo === id);
            if (!open && !reported) continue;
            compared++;
            const recorded = [...(reported?.collateral ?? [])].map((c) => ({ bond: c.bond, units: c.units })).sort((a, b) => (a.bond < b.bond ? -1 : 1));
            if (describe(recorded) !== describe(at?.collateral ?? [])) {
              failures.push(`block ${block}: ${participant}'s record of repo ${id.slice(0, 8)} is ${describe(recorded)}; the ledger moved ${describe(at?.collateral ?? [])}`);
            }
          }
        }
      }
    }
    if (repos === 0) return skipped(repoCollateral, "no repo opened");
    const books = compared > 0 ? `, ${compared} records in books equal to the ledger` : "";
    return result(repoCollateral, failures, `${repos} repos, ${flows} flows: collateral the record, margins covering, substitutions keeping value, closes repaying principal plus interest${books}`);
  },
};

export const CHECKS: readonly Check[] = [
  atomicity,
  exactlyOnce,
  authority,
  eligibility,
  supplyEqualsLiability,
  liabilityConservation,
  booksEqualLedger,
  fxConsistency,
  repoCollateral,
];

export function runChecks(trace: Trace): CheckResult[] {
  const index = new TraceIndex(trace);
  return CHECKS.map((check) => check.run(index));
}

/** For tests and reports: the names of the checks that failed. */
export const failing = (results: readonly CheckResult[]) => results.filter((r) => r.status === "fail").map((r) => r.name);
