import { type CurrencyCode, isCurrencyCode, parseDecimal, parseRate } from "@oul/domain";
import { z } from "zod";

/** Raw shapes of a scenario folder's YAML files, before cross-checks. */

const id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase words joined by hyphens");

const currency = z
  .string()
  .refine(isCurrencyCode, "a supported ISO 4217 code")
  .transform((code) => code as CurrencyCode);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

const decimalString = z.string().refine((value) => {
  try {
    parseDecimal(value);
    return true;
  } catch {
    return false;
  }
}, "a plain decimal string, quoted");

const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "an IANA time zone");

const weekday = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

export const participantKind = z.enum(["central-bank", "bank", "issuer"]);

const participant = z.strictObject({
  id,
  name: z.string().min(1),
  kind: participantKind,
  validator: z.boolean().default(false),
  /** An issuer acts through a bank as its issuing and paying agent. */
  agent: id.optional(),
  /** A central bank's currency: the one its wholesale token is in. */
  currency: currency.optional(),
  /** The currencies a bank holds reserves in, each at that currency's central bank. */
  reserves: z.array(currency).optional(),
});

/** A cash token: its symbol, the participant whose liability it is, and its currency. */
const cashToken = z.strictObject({ symbol: z.string().min(1), issuer: id, currency });

const bond = z.strictObject({
  symbol: z.string().min(1),
  name: z.string().min(1),
  issuer: id,
  agent: id,
  /** Face amount of one unit, in the scenario's currency (a scenario with bonds has one). */
  face: decimalString,
  units: z.coerce.bigint().positive(),
  couponRate: decimalString,
  frequency: z.enum(["annual", "semiannual", "quarterly"]),
  dayCount: z.enum(["ACT/365F", "ACT/ACT-ICMA", "30/360"]),
  issueDate: isoDate,
  maturityDate: isoDate,
  /** Business days between the record date and each payment date. */
  recordDays: z.number().int().min(0).max(10),
  rounding: z.enum(["half-even", "half-up", "down", "up"]),
});

/**
 * Interop mode (SPEC.md §7): a second, separate ledger, the validators that
 * run it, the deposit tokens that also live there, and the notary that
 * coordinates two-phase commit across the two. In a scenario of two
 * currencies (SPEC.md §13) the second currency lives there: its wholesale
 * token and the deposits in it, so a payment across currencies splits by
 * currency.
 */
const interop = z.strictObject({
  validators: z.array(id).min(1),
  wholesale: z.array(z.string().min(1)).default([]),
  deposits: z.array(z.string().min(1)).min(1),
  notary: z.strictObject({ id, name: z.string().min(1) }),
});

/**
 * Payment versus payment (SPEC.md §13): the bank that quotes FX, the rates it
 * quotes (target currency per unit of source currency), and how long a
 * quote holds.
 */
const fx = z.strictObject({
  dealer: id,
  quoteSeconds: z.number().int().min(10).max(3600),
  rates: z
    .array(
      z.strictObject({
        from: currency,
        to: currency,
        rate: z.string().refine((value) => {
          try {
            parseRate(value);
            return true;
          } catch {
            return false;
          }
        }, "a positive decimal string with at most 6 decimal places, quoted"),
      }),
    )
    .min(1),
});

/**
 * Repo (SPEC.md §5.7–§5.10): the conventions every repo between the
 * scenario's banks follows. Each repo's own terms are agreed by both sides.
 */
const repo = z.strictObject({
  /** Repo interest's day count: the purchase price × rate × days held / 365. */
  dayCount: z.literal("ACT/365F"),
  /** The scenario's bonds a repo accepts as collateral, and substitutes one for another. */
  collateral: z.array(z.string().min(1)).min(1),
  /** How long a margin call may stay unmet, in seconds of block time, before it is overdue on both sides. */
  marginCallSeconds: z.number().int().min(10).max(86_400),
});

export const scenarioFile = z.strictObject({
  id,
  name: z.string().min(1),
  /** One currency, or two for cross-border payment versus payment (SPEC.md §13). */
  currencies: z.array(currency).min(1).max(2),
  timeZone,
  /**
   * The jurisdiction, as an ISO 3166-1 numeric code: what each bond holder's
   * identity records as its country (ERC-3643). Needed with bonds.
   */
  country: z.number().int().min(1).max(999).optional(),
  calendar: z.strictObject({
    weekend: z.array(weekday).min(1),
    holidays: z.array(isoDate).default([]),
  }),
  participants: z.array(participant).min(1),
  instruments: z.strictObject({
    /** One per currency, issued by that currency's central bank. */
    wholesale: z.array(cashToken).min(1),
    deposits: z.array(cashToken),
    bonds: z.array(bond).default([]),
  }),
  interop: interop.optional(),
  fx: fx.optional(),
  /**
   * Client custody (SPEC.md §15): the banks that hold bonds for some of their
   * customers at an omnibus address, and which customers.
   */
  custody: z.array(z.strictObject({ bank: id, clients: z.array(id).min(1) })).default([]),
  repo: repo.optional(),
});

const openingLine = z.union([
  z.strictObject({ debit: z.string().min(1), amount: z.string() }),
  z.strictObject({ credit: z.string().min(1), amount: z.string() }),
]);

export const accountsFile = z.record(
  id,
  z.strictObject({
    customers: z.array(z.strictObject({ id, name: z.string().min(1) })).default([]),
    opening: z.array(openingLine).default([]),
  }),
);

export type ScenarioFile = z.infer<typeof scenarioFile>;
export type AccountsFile = z.infer<typeof accountsFile>;
export type ParticipantKind = z.infer<typeof participantKind>;
export type BondTerms = z.infer<typeof bond>;
export type InteropSpec = z.infer<typeof interop>;
export type FxSpec = z.infer<typeof fx>;
export type RepoSpec = z.infer<typeof repo>;
