import { randomUUID } from "node:crypto";
import { convert, type CurrencyCode, Decimal, minorUnit, money, parseRate, toDecimal } from "@oul/domain";
import { dealerOf, depositOf, fxRate } from "@oul/scenario";
import { contracts, participantIdHash } from "@oul/chain";
import { type Hex, recoverTypedDataAddress } from "viem";
import type { RuntimeContext } from "./context.ts";
import { FlowRejected } from "./errors.ts";
import type { FxFlow, Quote } from "./flows.ts";
import { claimQuote, getQuote, insertQuote } from "./store.ts";

/**
 * The dealer's FX quotes for payment versus payment (SPEC.md §13). The
 * payer's bank asks the dealer for a quote; the dealer prices it from its
 * rates, signs it and keeps it. Every party to the payment checks the target
 * amount is the source amount times the quoted rate, rounded once,
 * half-even (invariant 11), and the dealer signs the instruction only for a
 * quote it issued, unexpired, to the bank that asked, claimed by that one
 * instruction. The instruction's deadline is no later than the quote's
 * expiry, so the engine itself refuses to settle at a rate past its time.
 */

const quoteTypes = {
  Quote: [
    { name: "id", type: "string" },
    { name: "dealer", type: "string" },
    { name: "requester", type: "string" },
    { name: "from", type: "string" },
    { name: "to", type: "string" },
    { name: "sourceAmount", type: "uint256" },
    { name: "rate", type: "string" },
    { name: "targetAmount", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

const quoteDomain = (chainId: number) => ({ name: "Open Unified Ledger FX quote", version: "1", chainId }) as const;

const message = (q: Omit<Quote, "signature">) => ({
  id: q.id,
  dealer: q.dealer,
  requester: q.requester,
  from: q.from,
  to: q.to,
  sourceAmount: BigInt(q.sourceAmount),
  rate: q.rate,
  targetAmount: BigInt(q.targetAmount),
  expiresAt: BigInt(q.expiresAt),
});

export interface QuoteRequest {
  /** The payer's bank, which will submit the payment. */
  readonly requester: string;
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** Minor units of `from`. */
  readonly sourceAmount: string;
}

/** What the target amount must be: the source amount at the rate, rounded once, half-even (invariant 11). */
export function quotedTarget(quote: Pick<Quote, "from" | "to" | "sourceAmount" | "rate">): bigint {
  return convert(money(quote.from, BigInt(quote.sourceAmount)), quote.rate, quote.to).minor;
}

/**
 * The target amount as this participant prices it: `quotedTarget`, or with
 * the conformance kit's `round-fx-twice` defect, rounded to a tenth of the
 * minor unit first and then to the unit.
 */
export function targetFor(rt: Pick<RuntimeContext, "defects">, quote: Pick<Quote, "from" | "to" | "sourceAmount" | "rate">): bigint {
  if (!rt.defects.has("round-fx-twice")) return quotedTarget(quote);
  const exact = toDecimal(money(quote.from, BigInt(quote.sourceAmount)))
    .times(parseRate(quote.rate))
    .times(new Decimal(10).toPower(minorUnit(quote.to)));
  return BigInt(exact.toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
}

/** As dealer, price, sign and keep a quote for a bank's payment. */
export async function issueQuote(rt: RuntimeContext, request: QuoteRequest, now: number): Promise<Quote> {
  const { scenario } = rt;
  if (dealerOf(scenario) !== rt.participant) {
    throw new FlowRejected("not-a-party", `${rt.participant} quotes no FX in ${scenario.id}`);
  }
  if (!/^[1-9]\d*$/.test(request.sourceAmount)) {
    throw new FlowRejected("invalid-flow", `The amount must be a positive whole number of minor units: "${request.sourceAmount}"`);
  }
  const requester = scenario.participants.find((p) => p.id === request.requester);
  if (requester?.kind !== "bank" || requester.id === rt.participant) {
    throw new FlowRejected("invalid-flow", `"${request.requester}" is not a bank the dealer quotes for`);
  }
  if (!requester.reserves.includes(request.from)) {
    throw new FlowRejected("invalid-flow", `${requester.id} holds no reserves in ${request.from}`);
  }
  const rate = fxRate(scenario, request.from, request.to);
  if (!rate) throw new FlowRejected("invalid-flow", `No rate is quoted from ${request.from} to ${request.to}`);
  const unsigned = {
    id: randomUUID(),
    dealer: rt.participant,
    requester: requester.id,
    from: request.from,
    to: request.to,
    sourceAmount: request.sourceAmount,
    rate,
    targetAmount: targetFor(rt, { ...request, rate }).toString(),
    expiresAt: now + scenario.fx!.quoteSeconds,
  };
  const signature = await rt.account.signTypedData({
    domain: quoteDomain(rt.network.chainId),
    types: quoteTypes,
    primaryType: "Quote",
    message: message(unsigned),
  });
  const quote: Quote = { ...unsigned, signature };
  await insertQuote(rt.books.database, "dealer", quote);
  rt.log(`quoted ${request.requester} ${request.from}→${request.to} at ${rate}, quote ${quote.id}`);
  return quote;
}

/**
 * Whether a quote is the scenario dealer's own, signed by it, and priced by
 * invariant 11. Every party checks this before it books or signs.
 */
/**
 * Check a quote: the dealer's, for a scenario rate, priced right, and signed
 * by one of the dealer's keys. A quote to pay at must be signed by a key the
 * dealer signs with now; one already `settled` stands if a key the dealer
 * signed with then, since retired by a rotation (SPEC.md §15), signed it.
 */
export async function verifyQuote(rt: RuntimeContext, quote: Quote, options: { settled?: boolean } = {}): Promise<void> {
  const dealer = dealerOf(rt.scenario);
  if (!dealer || quote.dealer !== dealer) throw new FlowRejected("invalid-flow", `"${quote.dealer}" is not the dealer of ${rt.scenario.id}`);
  if (quote.from === quote.to) throw new FlowRejected("invalid-flow", "A quote exchanges two different currencies");
  let target: bigint;
  try {
    target = targetFor(rt, quote);
  } catch (error) {
    throw new FlowRejected("invalid-flow", `The quote cannot be priced: ${(error as Error).message}`);
  }
  if (quote.targetAmount !== target.toString()) {
    throw new FlowRejected("invalid-flow", `The quote's target amount ${quote.targetAmount} is not ${target}, its source amount at ${quote.rate}`);
  }
  const { signature, ...unsigned } = quote;
  // Signed by one of the dealer's active signing keys, as the registry has them now (SPEC.md §15).
  const signer = await recoverTypedDataAddress({
    domain: quoteDomain(rt.network.chainId),
    types: quoteTypes,
    primaryType: "Quote",
    message: message(unsigned),
    signature,
  }).catch(() => undefined);
  const registry = { address: rt.deployment.contracts.registry, abi: contracts.ParticipantRegistry.abi } as const;
  const signsFor = !signer
    ? undefined
    : options.settled
      ? ((await rt.client.readContract({ ...registry, functionName: "keyOf", args: [signer] })) as readonly [Hex, boolean])[0]
      : ((await rt.client.readContract({ ...registry, functionName: "signerOf", args: [signer] })) as Hex);
  if (signsFor !== participantIdHash(dealer)) throw new FlowRejected("invalid-flow", `Quote ${quote.id} is not signed by ${dealer}`);
}

/** The checks a payment across currencies needs beyond any payment's: its banks, its currencies, its quote. */
export async function checkFxFlow(rt: RuntimeContext, flow: FxFlow, now: number): Promise<void> {
  const { quote } = flow;
  await verifyQuote(rt, quote);
  if (quote.requester !== flow.payerBank) throw new FlowRejected("invalid-flow", `Quote ${quote.id} was given to ${quote.requester}, not ${flow.payerBank}`);
  if (new Set([flow.payerBank, flow.payeeBank, quote.dealer]).size !== 3) {
    throw new FlowRejected("invalid-flow", "A payment across currencies needs a payer's bank, a payee's bank and a dealer, all different");
  }
  const [payer, payee] = [depositOf(rt.scenario, flow.payerBank), depositOf(rt.scenario, flow.payeeBank)];
  if (payer.currency !== quote.from || payee.currency !== quote.to) {
    throw new FlowRejected("invalid-flow", `The quote exchanges ${quote.from} for ${quote.to}, but ${payer.symbol} is in ${payer.currency} and ${payee.symbol} in ${payee.currency}`);
  }
  if (quote.expiresAt <= now) throw new FlowRejected("invalid-flow", `Quote ${quote.id} expired`);
  if (flow.deadline > quote.expiresAt) throw new FlowRejected("invalid-flow", `The instruction outlives quote ${quote.id}`);
}

/** As the payer's bank, a quote it asked for and kept, by id. */
export async function requestedQuote(rt: RuntimeContext, id: string): Promise<Quote> {
  const row = await getQuote(rt.books.database, id);
  if (!row || row.role !== "requester") throw new FlowRejected("invalid-flow", `${rt.participant} holds no quote ${id}`);
  return row.quote;
}

/** As the payer's bank, keep a quote the dealer gave it, once checked. */
export async function keepQuote(rt: RuntimeContext, quote: Quote, now: number): Promise<Quote> {
  await verifyQuote(rt, quote);
  if (quote.requester !== rt.participant) throw new FlowRejected("invalid-flow", `Quote ${quote.id} is for ${quote.requester}`);
  if (quote.expiresAt <= now) throw new FlowRejected("invalid-flow", `Quote ${quote.id} expired`);
  await insertQuote(rt.books.database, "requester", quote);
  return quote;
}

const QUOTE_FIELDS = [...quoteTypes.Quote.map((f) => f.name), "signature"] as const;

/** Field by field: a quote read back from jsonb keeps its values, not its key order. */
export function sameQuote(a: Quote, b: Quote): boolean {
  return QUOTE_FIELDS.every((field) => a[field] === b[field]);
}

/** As dealer, sign only for a quote of its own, unchanged, claimed by this instruction alone. */
export async function holdDealerQuote(rt: RuntimeContext, flow: FxFlow): Promise<void> {
  const row = await getQuote(rt.books.database, flow.quote.id);
  if (!row || row.role !== "dealer" || !sameQuote(row.quote, flow.quote)) {
    throw new FlowRejected("invalid-flow", `${rt.participant} gave no quote ${flow.quote.id} with these terms`);
  }
  if (!(await claimQuote(rt.books.database, flow.quote.id, flow.uetr))) {
    throw new FlowRejected("conflicting-instruction", `Quote ${flow.quote.id} already settles another instruction`);
  }
}
