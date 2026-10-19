import { contracts } from "@oul/chain";
import { couponPayment, couponSchedule, principal } from "@oul/domain";
import type { Executor } from "@oul/ledger";
import { sql } from "drizzle-orm";
import { type Address, type Hex, isAddressEqual } from "viem";
import type { RuntimeContext } from "./context.ts";
import { FlowRejected } from "./errors.ts";
import { type Affirmation, type BondFlow, bondInfo, type Custody, type Flow } from "./flows.ts";
import type { FlowRequest } from "./participant.ts";
import type { InstructionRow } from "./store.ts";

/**
 * The bond-specific checks of SPEC.md §5.4–§5.6: what the agent reads from
 * the chain to plan a payment, what a holder reads to verify one, and the
 * matching a buyer requires before it pays for units.
 */

const { Bond, ParticipantRegistry } = contracts;

function bondAddress(rt: RuntimeContext, symbol: string): Address {
  const token = rt.deployment.tokens[symbol];
  if (token?.kind !== "bond") throw new FlowRejected("invalid-flow", `No bond "${symbol}" is deployed`);
  return token.address;
}

async function read(rt: RuntimeContext, symbol: string, functionName: string, args: readonly unknown[]) {
  return (await rt.client.readContract({
    address: bondAddress(rt, symbol),
    abi: Bond.abi,
    functionName,
    args,
  } as never)) as bigint;
}

const unitsAt = (rt: RuntimeContext, symbol: string, holder: Address, block: bigint) =>
  read(rt, symbol, "balanceOfAt", [holder, block]);

/** This participant's coupon and redemption instructions for a bond that are not dead. */
async function livePayments(rt: RuntimeContext, symbol: string): Promise<InstructionRow[]> {
  const result = await rt.books.database.execute(sql`
    SELECT uetr, flow, status FROM instructions
     WHERE flow->>'bond' = ${symbol}
       AND flow->>'kind' IN ('bond-coupon', 'bond-redeem')
       AND status NOT IN ('failed', 'expired', 'rejected')
  `);
  return result.rows.map((r) => ({ uetr: String(r["uetr"]), flow: r["flow"] as Flow, status: r["status"] }) as never);
}

/**
 * The agent plans the next scheduled payment: the next unpaid period, the
 * register closed at the last completed block, each holder's units from the
 * bond's checkpoints (which must add up to the supply), and the amounts by the
 * bond's terms. The final period is the redemption.
 */
export async function planNextPayment(rt: RuntimeContext, symbol: string): Promise<FlowRequest> {
  const info = bondInfo(rt.scenario, symbol);
  if (info.agent !== rt.participant) {
    throw new FlowRejected("not-a-party", `${rt.participant} is not the paying agent of ${symbol}`);
  }
  const schedule = couponSchedule(info.terms, info.calendar);
  const paid = (await livePayments(rt, symbol)).map((r) => (r.flow as Extract<BondFlow, { period: number }>).period);
  const next = (paid.length === 0 ? 0 : Math.max(...paid)) + 1;
  const period = schedule[next - 1];
  if (!period) throw new FlowRejected("invalid-flow", `${symbol} has no payment left to make`);

  const latest = await rt.client.getBlockNumber();
  if (latest === 0n) throw new FlowRejected("invalid-flow", "No completed block to close the register at");
  const recordBlock = latest - 1n;
  // The register: every address the bond ever reached, as its Transfer events say, with its units at the
  // record block. A bank's own address is its holding; any other address bound to it is a custody wallet (§15).
  const holdings: { holder: string; units: bigint; wallet?: Address }[] = [];
  for (const address of await holdersOf(rt, symbol, recordBlock)) {
    const units = await unitsAt(rt, symbol, address, recordBlock);
    if (units === 0n) continue;
    const owner = (await rt.client.readContract({ address: rt.deployment.contracts.registry, abi: ParticipantRegistry.abi, functionName: "participantOf", args: [address] })) as Hex;
    const [id, p] = Object.entries(rt.deployment.participants).find(([, x]) => x.idHash === owner) ?? [];
    if (!id || !p || p.kind !== "bank") throw new FlowRejected("invalid-flow", `${address} holds ${units} units for no bank`);
    holdings.push({ holder: id, units, ...(isAddressEqual(address, p.address) ? {} : { wallet: address }) });
  }
  const supply = await read(rt, symbol, "totalSupplyAt", [recordBlock]);
  const registered = holdings.reduce((t, h) => t + h.units, 0n);
  if (supply === 0n) throw new FlowRejected("invalid-flow", `${symbol} has no units outstanding`);
  if (registered !== supply) {
    throw new FlowRejected("invalid-flow", `The register shows ${registered} units but ${supply} are outstanding`);
  }
  // Each holding is rounded once on its own: a custody wallet is paid apart from its bank's own holding.
  const keyOf = (h: { holder: string; wallet?: Address }) => `${h.holder}|${h.wallet ?? ""}`;
  const payment = couponPayment(info.terms, period, holdings.map((h) => ({ holder: keyOf(h), units: h.units })));
  const walletOf = (key: string) => holdings.find((h) => keyOf(h) === key)?.wallet;
  const bankOf = (key: string) => key.split("|")[0]!;
  const base = { bond: symbol, period: period.number, recordBlock: recordBlock.toString(), issuerDebit: "" };
  if (period.final) {
    const principalDebit = principal(info.terms, supply).minor;
    return {
      kind: "bond-redeem",
      ...base,
      issuerDebit: (principalDebit + payment.issuerDebit.minor).toString(),
      payments: payment.payments.map((p) => ({
        bank: bankOf(p.holder),
        units: p.units.toString(),
        principal: principal(info.terms, p.units).minor.toString(),
        coupon: p.amount.minor.toString(),
        ...(walletOf(p.holder) ? { wallet: walletOf(p.holder)! } : {}),
      })),
    };
  }
  return {
    kind: "bond-coupon",
    ...base,
    issuerDebit: payment.issuerDebit.minor.toString(),
    payments: payment.payments.map((p) => ({
      bank: bankOf(p.holder),
      units: p.units.toString(),
      amount: p.amount.minor.toString(),
      ...(walletOf(p.holder) ? { wallet: walletOf(p.holder)! } : {}),
    })),
  };
}

/** Every address a bond has been minted or transferred to up to `block`, from its Transfer events. */
async function holdersOf(rt: RuntimeContext, symbol: string, block: bigint): Promise<Address[]> {
  const logs = await rt.client.getContractEvents({
    address: bondAddress(rt, symbol),
    abi: Bond.abi,
    eventName: "Transfer",
    fromBlock: BigInt(rt.deployment.startBlock),
    toBlock: block,
  });
  const seen = new Map<string, Address>();
  for (const log of logs) {
    const to = (log.args as { to?: Address }).to;
    if (to && !/^0x0+$/.test(to)) seen.set(to.toLowerCase(), to);
  }
  return [...seen.values()];
}

/** The agent's checks on an issue: within the issue size, and never to itself. */
export async function checkIssue(rt: RuntimeContext, flow: Extract<BondFlow, { kind: "bond-issue" }>): Promise<void> {
  const info = bondInfo(rt.scenario, flow.bond);
  const banks = flow.allocations.map((a) => a.bank);
  if (banks.includes(info.agent)) throw new FlowRejected("invalid-flow", "The paying agent cannot hold the bond it pays");
  // A bank may have an allocation for its own book and one for each custody client (§15), each once.
  const holdings = flow.allocations.map((a) => `${a.bank}|${a.custody?.client ?? ""}`);
  if (new Set(holdings).size !== holdings.length) throw new FlowRejected("invalid-flow", "A holding appears twice in the allocations");
  const outstanding = await read(rt, flow.bond, "totalSupply", []);
  const issuing = flow.allocations.reduce((t, a) => t + BigInt(a.units), 0n);
  if (outstanding + issuing > info.totalUnits) {
    throw new FlowRejected("invalid-flow", `Issuing ${issuing} units would exceed the issue size of ${info.totalUnits}`);
  }
}

/**
 * A holder's check before it co-signs a coupon or redemption: the period is
 * the right kind and not already paid to it, its units are what the bond's
 * checkpoints say it held at the record block, and its amounts are what the
 * terms give for those units.
 */
export async function verifyHolderPayment(
  rt: RuntimeContext,
  flow: Extract<BondFlow, { kind: "bond-coupon" | "bond-redeem" }>,
): Promise<void> {
  const info = bondInfo(rt.scenario, flow.bond);
  const schedule = couponSchedule(info.terms, info.calendar);
  const period = schedule[flow.period - 1];
  if (!period || period.final !== (flow.kind === "bond-redeem")) {
    throw new FlowRejected("invalid-flow", `Period ${flow.period} of ${flow.bond} is not a ${flow.kind}`);
  }
  const entries = flow.payments.filter((p) => p.bank === rt.participant);
  if (entries.length === 0) throw new FlowRejected("not-a-party", `${rt.participant} is not paid in this ${flow.kind}`);
  const already = (await livePayments(rt, flow.bond)).find(
    (r) => r.uetr !== flow.uetr && (r.flow as Extract<BondFlow, { period: number }>).period === flow.period,
  );
  if (already) throw new FlowRejected("conflicting-instruction", `Period ${flow.period} is already paid by ${already.uetr}`);

  // Each of its holdings, its own address and any omnibus wallet (§15), checked apart and in full.
  const self = rt.deployment.participants[rt.participant]!.address;
  const wallets = [self, ...entries.filter((e) => e.wallet).map((e) => e.wallet!)];
  if (new Set(wallets.map((w) => w.toLowerCase())).size !== wallets.length) throw new FlowRejected("invalid-flow", "A holding is paid twice");
  for (const mine of entries) {
    const holder = mine.wallet ?? self;
    const units = await unitsAt(rt, flow.bond, holder, BigInt(flow.recordBlock));
    if (units.toString() !== mine.units) {
      throw new FlowRejected("invalid-flow", `${holder} held ${units} units at block ${flow.recordBlock}, not ${mine.units}`);
    }
    const expected = couponPayment(info.terms, period, [{ holder: rt.participant, units }]).payments[0]?.amount.minor ?? 0n;
    const offered = BigInt("amount" in mine ? mine.amount : mine.coupon);
    if (offered !== expected) {
      throw new FlowRejected("invalid-flow", `The coupon on ${units} units is ${expected} minor units, not ${offered}`);
    }
    if ("principal" in mine && BigInt(mine.principal) !== principal(info.terms, units).minor) {
      throw new FlowRejected("invalid-flow", `The principal on ${units} units is ${principal(info.terms, units).minor}`);
    }
  }
  // And nothing it held at the record block is left out.
  if (!entries.some((e) => !e.wallet)) {
    const own = await unitsAt(rt, flow.bond, self, BigInt(flow.recordBlock));
    if (own > 0n) throw new FlowRejected("invalid-flow", `${rt.participant}'s own ${own} units are not paid`);
  }
}

/** Record what this participant's operator agreed to buy, for matching. */
export async function recordAffirmation(db: Executor, flow: Affirmation, status: "proposed" | "affirmed"): Promise<void> {
  await db.execute(sql`
    INSERT INTO affirmations (uetr, flow, status) VALUES (${flow.uetr}, ${JSON.stringify(flow)}::jsonb, ${status})
    ON CONFLICT (uetr) DO UPDATE SET flow = excluded.flow, status = excluded.status
  `);
}

export async function setAffirmationStatus(db: Executor, uetr: string, status: "affirmed" | "rejected"): Promise<void> {
  await db.execute(sql`UPDATE affirmations SET status = ${status} WHERE uetr = ${uetr}`);
}

/**
 * A buyer co-signs an issue or trade only if its operator affirmed it: the
 * same UETR, bond and price, and for an issue its own allocation, for a trade
 * the same seller and units.
 */
export async function requireAffirmation(
  rt: RuntimeContext,
  flow: Extract<BondFlow, { kind: "bond-issue" | "bond-trade" }>,
): Promise<void> {
  // Only an affirmation its policy has let through counts.
  const result = await rt.books.database.execute(sql`SELECT flow FROM affirmations WHERE uetr = ${flow.uetr} AND status = 'affirmed'`);
  const affirmed = result.rows[0]?.["flow"] as Record<string, unknown> | undefined;
  const fail = () => {
    throw new FlowRejected("not-a-party", `${rt.participant} has not affirmed this ${flow.kind} (${flow.uetr})`);
  };
  if (!affirmed || affirmed["kind"] !== flow.kind || affirmed["bond"] !== flow.bond || affirmed["price"] !== flow.price) {
    return fail();
  }
  if (flow.kind === "bond-trade") {
    if (affirmed["seller"] !== flow.seller || affirmed["buyer"] !== flow.buyer || affirmed["units"] !== flow.units) fail();
    // The custody client it buys for, and its wallet, are its own to decide (§15).
    if (!sameCustody(affirmed["buyerCustody"] as Custody | undefined, flow.buyerCustody)) fail();
    return;
  }
  // Its allocations, each with the client it is for if any: exactly what it affirmed.
  const key = (a: { units: string; custody?: Custody }) => `${a.units}|${a.custody?.client ?? ""}|${a.custody?.wallet.toLowerCase() ?? ""}`;
  const mine = flow.allocations.filter((a) => a.bank === rt.participant).map(key).sort();
  const theirs = ((affirmed["allocations"] as { bank: string; units: string; custody?: Custody }[] | undefined) ?? [])
    .filter((a) => a.bank === rt.participant)
    .map(key)
    .sort();
  if (mine.length === 0 || mine.join(",") !== theirs.join(",")) fail();
}

const sameCustody = (a: Custody | undefined, b: Custody | undefined) =>
  a === undefined || b === undefined ? a === b : a.client === b.client && a.wallet.toLowerCase() === b.wallet.toLowerCase();

/** What a bank sees of a bond: its terms, the schedule with what has been paid, its holding, the units outstanding. */
export async function bondSummary(rt: RuntimeContext, symbol: string) {
  let info;
  try {
    info = bondInfo(rt.scenario, symbol);
  } catch (error) {
    throw new FlowRejected("invalid-flow", (error as Error).message);
  }
  const paid = new Map<number, { uetr: string; settledBlock: string | null }>();
  const result = await rt.books.database.execute(sql`
    SELECT uetr, flow, settled_block::text AS settled_block FROM instructions
     WHERE flow->>'bond' = ${symbol}
       AND flow->>'kind' IN ('bond-coupon', 'bond-redeem')
       AND status = 'settled'
  `);
  for (const row of result.rows) {
    const flow = row["flow"] as Extract<BondFlow, { period: number }>;
    paid.set(flow.period, { uetr: String(row["uetr"]), settledBlock: row["settled_block"] == null ? null : String(row["settled_block"]) });
  }
  const face = info.terms.face.minor;
  const holding =
    rt.kind === "bank" && rt.participant !== info.agent
      ? (await rt.books.balance(`bond-holdings/${symbol}`)).posted.minor / face
      : null;
  // ERC-3643 (SPEC.md §15): whether this bank may receive the bond, by its identity's claims.
  const regulation = rt.deployment.tokens[symbol]?.regulation;
  const self = rt.deployment.participants[rt.participant]?.address;
  const verified =
    regulation && self && rt.kind === "bank"
      ? ((await rt.client.readContract({ address: regulation.identityRegistry, abi: contracts.IdentityRegistry.abi, functionName: "isVerified", args: [self] })) as boolean)
      : null;
  return {
    symbol,
    agent: info.agent,
    issuer: info.issuer,
    terms: info.terms,
    regulation: regulation ?? null,
    verified,
    outstandingUnits: await read(rt, symbol, "totalSupply", []),
    holdingUnits: holding,
    schedule: couponSchedule(info.terms, info.calendar).map((period) => ({
      ...period,
      paid: paid.get(period.number) ?? null,
    })),
  };
}
