import { type Approval, sandboxSlot } from "@oul/chain";
import { type CurrencyCode, formatMoney, isCurrencyCode, isUetr, money, parseMoney } from "@oul/domain";
import {
  type ChangeRequest,
  type Flow,
  FlowRejected,
  operatorByToken,
  type Participant,
  PeerUnavailable,
  type Peers,
  type Quote,
  type QuoteRequest,
  type RejectionReason,
} from "@oul/participant";
import type { Scenario } from "@oul/scenario";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/**
 * What every service speaks over HTTP: problem details for errors (RFC 9457),
 * amounts as decimal strings in major units with their currency, flows on the
 * wire between participants, and the client one service uses to reach
 * another.
 */

// ---------------------------------------------------------------- problems

export const PROBLEM_BASE = "urn:oul:problem:";

const STATUS_OF: Record<RejectionReason, number> = {
  "insufficient-funds": 422,
  "invalid-flow": 422,
  "not-a-party": 403,
  "unknown-customer": 404,
  "conflicting-instruction": 409,
  unauthenticated: 401,
  "not-permitted": 403,
  "not-found": 404,
};

export function problem(reply: FastifyReply, status: number, type: string, title: string, detail?: string) {
  return reply
    .status(status)
    .type("application/problem+json")
    .send({ type: `${PROBLEM_BASE}${type}`, title, status, ...(detail ? { detail } : {}) });
}

export function notFound(reply: FastifyReply, detail: string) {
  return problem(reply, 404, "not-found", "Not found", detail);
}

/** Map the errors a handler can raise to problem details; anything else is a 500 without internals. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof FlowRejected) {
      return problem(reply, STATUS_OF[error.reason], error.reason, "The flow was refused", error.message);
    }
    if (error instanceof PeerUnavailable) {
      return problem(reply, 503, "peer-unavailable", "A counterparty could not be reached", error.message);
    }
    if (error instanceof z.ZodError) {
      return problem(reply, 400, "validation", "The request is invalid", z.prettifyError(error));
    }
    if ("validation" in error && error.validation) {
      return problem(reply, 400, "validation", "The request is invalid", error.message);
    }
    if ("statusCode" in error && typeof error.statusCode === "number" && error.statusCode < 500) {
      return problem(reply, error.statusCode, "request", error.message);
    }
    request.log.error(error);
    return problem(reply, 500, "internal", "Something went wrong");
  });
}

// ---------------------------------------------------------------- operators

/**
 * The operator a request comes from (SPEC.md §15): `Authorization: Bearer
 * <token>`, the sandbox token of one of this participant's operators. A real
 * bank would put its identity provider here; the policy checks behind it
 * would not change.
 */
export function operatorOf(participant: Participant, request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  const token = /^Bearer\s+([0-9a-f]{64})$/i.exec(header)?.[1]?.toLowerCase();
  if (!token) throw new FlowRejected("unauthenticated", `An operator of ${participant.id} must start this: send Authorization: Bearer <operator token>`);
  const operator = operatorByToken(participant.rt.scenario, participant.id, token);
  if (!operator) throw new FlowRejected("unauthenticated", `The token is not one of ${participant.id}'s operators`);
  return operator.id;
}

// ---------------------------------------------------------------- amounts

/** A positive decimal amount in major units, e.g. "2500.00", parsed exactly in the scenario's currency. */
export function amountSchema(currency: CurrencyCode) {
  return z.string().transform((value, ctx) => {
    try {
      const amount = parseMoney(currency, value);
      if (amount.minor <= 0n) throw new RangeError("must be positive");
      return amount.minor.toString();
    } catch (error) {
      ctx.addIssue({ code: "custom", message: `amount: ${(error as Error).message}` });
      return z.NEVER;
    }
  });
}

export const uetrSchema = z.string().refine(isUetr, "a UETR: a lowercase UUID version 4");

export const currencySchema = z
  .string()
  .refine(isCurrencyCode, "a supported ISO 4217 code")
  .transform((code) => code as CurrencyCode);

export function formatAmount(currency: CurrencyCode, minor: bigint | string) {
  return { amount: formatMoney(money(currency, BigInt(minor))), currency };
}

// ---------------------------------------------------------------- flows between participants

const id = z.string().min(1);
const minor = z.string().regex(/^[1-9]\d*$/, "positive minor units");
const minorOrZero = z.string().regex(/^(0|[1-9]\d*)$/, "minor units");
const whole = z.string().regex(/^[1-9]\d*$/, "a positive whole number");
const head = { uetr: uetrSchema, deadline: z.number().int().positive() };
const base = { ...head, amount: minor };
const payment = { ...head, bond: id, period: z.number().int().positive(), recordBlock: minorOrZero, issuerDebit: minor };
const walletAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address") as unknown as z.ZodType<`0x${string}`>;
/** Units held for a custody client at its custodian's omnibus wallet (SPEC.md §15). */
const custody = z.strictObject({ client: id, wallet: walletAddress });

/** A dealer's signed FX quote, as it travels between participants. */
export const quoteSchema: z.ZodType<Quote> = z.strictObject({
  id: uetrSchema,
  dealer: id,
  requester: id,
  from: currencySchema,
  to: currencySchema,
  sourceAmount: minor,
  rate: z.string().regex(/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/, "a rate with at most 6 decimal places"),
  targetAmount: minor,
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
}) as z.ZodType<Quote>;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address") as unknown as z.ZodType<`0x${string}`>;
const signature = z.string().regex(/^0x[0-9a-fA-F]+$/, "a signature") as unknown as z.ZodType<`0x${string}`>;

/** An administrative change one participant asks of another (SPEC.md §15). */
export const changeRequestSchema: z.ZodType<ChangeRequest> = z.union([
  z.strictObject({ action: z.literal("bind-address"), op: z.literal("rotate").optional(), participant: id, oldKey: address, newKey: address, consent: signature, proof: signature }),
  z.strictObject({ action: z.literal("bind-address"), op: z.literal("holding"), participant: id, wallet: address }),
  z.strictObject({ action: z.literal("recovery"), op: z.literal("recover"), bond: id, holder: id, lostWallet: address, newWallet: address }),
]) as unknown as z.ZodType<ChangeRequest>;

export const quoteRequestSchema: z.ZodType<QuoteRequest> = z.strictObject({
  requester: id,
  from: currencySchema,
  to: currencySchema,
  sourceAmount: minor,
}) as z.ZodType<QuoteRequest>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const fraction = z.string().regex(/^0(\.\d{1,18})?$/, "a fraction in [0, 1), e.g. \"0.02\"");
const repoParties = { lender: id, borrower: id };
const collateralUnits = z.strictObject({ bond: id, units: whole });
const marks = z.array(z.strictObject({ bond: id, price: minor })).min(1);

/** A repo flow as one participant sends it to another (SPEC.md §5.7–§5.10). */
const repoFlowSchemas = [
  z.strictObject({
    kind: z.literal("repo-open"),
    ...head,
    ...repoParties,
    bond: id,
    units: whole,
    mark: minor,
    cash: minor,
    rate: fraction,
    haircut: fraction,
    startDate: isoDate,
    endDate: isoDate,
  }),
  z.strictObject({ kind: z.literal("repo-margin"), ...head, ...repoParties, repo: uetrSchema, direction: z.enum(["deliver", "return"]), bond: id, units: whole, marks, asOf: isoDate }),
  z.strictObject({ kind: z.literal("repo-substitute"), ...head, ...repoParties, repo: uetrSchema, outgoing: collateralUnits, incoming: collateralUnits, marks, asOf: isoDate }),
  z.strictObject({ kind: z.literal("repo-close"), ...head, ...repoParties, repo: uetrSchema, collateral: z.array(collateralUnits).min(1), cash: minor, interest: minorOrZero }),
  z.strictObject({
    kind: z.literal("repo-manufactured"),
    ...head,
    ...repoParties,
    repo: uetrSchema,
    bond: id,
    period: z.number().int().positive(),
    recordBlock: minorOrZero,
    units: whole,
    amount: minor,
  }),
] as const;

/** A margin call one side of a repo tells the other of (SPEC.md §5.8). */
export const marginCallSchema = z.strictObject({ flow: repoFlowSchemas[1], dueBy: z.number().int().positive() });

/** A flow as one participant sends it to another (minor units and whole units, never major units). */
export const flowSchema: z.ZodType<Flow> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["fund", "redeem"]), bank: id, currency: currencySchema, ...base }),
  z.strictObject({ kind: z.enum(["tokenize", "detokenize"]), bank: id, customer: id, ...base }),
  z.strictObject({ kind: z.literal("interbank"), payerBank: id, payer: id, payeeBank: id, payee: id, ...base }),
  z.strictObject({ kind: z.literal("pvp"), ...head, payerBank: id, payer: id, payeeBank: id, payee: id, quote: quoteSchema }),
  z.strictObject({
    kind: z.literal("bond-issue"),
    ...head,
    bond: id,
    price: minor,
    allocations: z.array(z.strictObject({ bank: id, units: whole, custody: custody.optional() })).min(1),
  }),
  z.strictObject({
    kind: z.literal("bond-trade"),
    ...head,
    bond: id,
    seller: id,
    buyer: id,
    units: whole,
    price: minor,
    sellerCustody: custody.optional(),
    buyerCustody: custody.optional(),
  }),
  z.strictObject({
    kind: z.literal("bond-coupon"),
    ...payment,
    payments: z.array(z.strictObject({ bank: id, units: whole, amount: minor, wallet: walletAddress.optional() })).min(1),
  }),
  z.strictObject({
    kind: z.literal("bond-redeem"),
    ...payment,
    payments: z.array(z.strictObject({ bank: id, units: whole, principal: minor, coupon: minorOrZero, wallet: walletAddress.optional() })).min(1),
  }),
  ...repoFlowSchemas,
]) as z.ZodType<Flow>;

/** Whole units over HTTP: a positive integer, as a JSON number or a string. */
export const unitsSchema = z
  .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/)])
  .transform(String);

export const approvalSchema: z.ZodType<Approval> = z.strictObject({
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
}) as z.ZodType<Approval>;

// ---------------------------------------------------------------- directory and peers

/**
 * Where each participant's service listens: `OUL_URL_<PARTICIPANT>` if set
 * (e.g. OUL_URL_BANK_A), otherwise port 7100 (7200 in sandbox OUL_SLOT=1, and so on) plus its position among the
 * scenario's central bank and banks.
 */
export function serviceUrl(scenario: Scenario, participant: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`OUL_URL_${participant.toUpperCase().replaceAll("-", "_")}`];
  if (override) return override.replace(/\/$/, "");
  return `http://127.0.0.1:${servicePort(scenario, participant)}`;
}

export function servicePort(scenario: Scenario, participant: string): number {
  const ordered = scenario.participants.filter((p) => p.kind === "central-bank" || p.kind === "bank");
  const index = ordered.findIndex((p) => p.id === participant);
  if (index < 0) throw new RangeError(`"${participant}" runs no service in ${scenario.id}`);
  return 7100 + 100 * sandboxSlot() + index;
}

/**
 * Reach other participants over HTTP. A refusal comes back as problem details
 * and is raised again as the same FlowRejected, so the initiator's caller sees
 * why the counterparty said no.
 *
 * In this sandbox the endpoints are not authenticated: what protects a
 * participant is that it rebuilds and checks every flow against its own books
 * before signing or booking. Production would add mutual TLS.
 */
export class HttpPeers implements Peers {
  private readonly scenario: Scenario;
  private readonly env: NodeJS.ProcessEnv;

  constructor(scenario: Scenario, env: NodeJS.ProcessEnv = process.env) {
    this.scenario = scenario;
    this.env = env;
  }

  async approve(participant: string, flow: Flow): Promise<Approval> {
    return approvalSchema.parse(await this.post(participant, "/peer/approvals", flow));
  }

  async requestFunding(centralBank: string, flow: Flow): Promise<void> {
    await this.post(centralBank, "/peer/funding", flow);
  }

  async quote(dealer: string, request: QuoteRequest): Promise<Quote> {
    return quoteSchema.parse(await this.post(dealer, "/peer/quotes", request));
  }

  async requestChange(participant: string, request: ChangeRequest): Promise<void> {
    await this.post(participant, "/peer/changes", request);
  }

  async marginCall(participant: string, call: { flow: Flow; dueBy: number }): Promise<void> {
    await this.post(participant, "/peer/repos/calls", call);
  }

  async custodyWallet(bank: string): Promise<`0x${string}`> {
    let response: Response;
    try {
      response = await fetch(`${serviceUrl(this.scenario, bank, this.env)}/custody`, { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new PeerUnavailable(bank, error);
    }
    const body = (await response.json().catch(() => ({}))) as { wallets?: { address: `0x${string}`; status: string }[] };
    const wallet = body.wallets?.find((w) => w.status === "active")?.address;
    if (!response.ok || !wallet) throw new FlowRejected("invalid-flow", `${bank} holds no bonds for clients`);
    return wallet;
  }

  private async post(participant: string, path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${serviceUrl(this.scenario, participant, this.env)}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new PeerUnavailable(participant, error);
    }
    const payload = (await response.json().catch(() => ({}))) as { type?: string; detail?: string; title?: string };
    if (!response.ok) {
      const reason = payload.type?.startsWith(PROBLEM_BASE) ? payload.type.slice(PROBLEM_BASE.length) : undefined;
      const known = reason && reason in STATUS_OF ? (reason as RejectionReason) : "invalid-flow";
      throw new FlowRejected(known, `${participant}: ${payload.detail ?? payload.title ?? response.statusText}`);
    }
    return payload;
  }
}
