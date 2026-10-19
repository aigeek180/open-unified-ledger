import { createHash } from "node:crypto";
import { type CurrencyCode, formatMoney, type Money } from "@oul/domain";
import { type MessageVersion, namespace } from "./schemas.ts";
import { el, text, type XmlElement } from "./xml.ts";

/**
 * How the sandbox's parties appear in ISO 20022 messages:
 *   - a bank has no BIC; it is a member of the proprietary clearing system
 *     `OUL` (the unified ledger), identified by its participant id;
 *   - an account is identified by its id in the servicing bank's books
 *     (at most 34 characters), and its on-chain address travels as the
 *     account's proxy, of proprietary type `EVM`;
 *   - settlement is by clearing through `OUL`.
 */
export const SETTLEMENT_SYSTEM = "OUL";

export interface BankRef {
  readonly id: string;
  readonly name: string;
}

export interface AccountRef {
  /** The account id in the servicer's books, at most 34 characters. */
  readonly id: string;
  readonly owner: string;
  readonly servicer: BankRef;
  readonly currency: CurrencyCode;
  /** The on-chain address whose balance the account mirrors, if any. */
  readonly address?: string;
  readonly name?: string;
}

/** BranchAndFinancialInstitutionIdentification6 for a sandbox bank. */
export function agent(tag: string, bank: BankRef): XmlElement {
  return el(
    tag,
    el(
      "FinInstnId",
      el("ClrSysMmbId", el("ClrSysId", text("Prtry", SETTLEMENT_SYSTEM)), text("MmbId", bank.id)),
      text("Nm", bank.name),
    ),
  );
}

/** CashAccount38 (pacs) or CashAccount39 (camt, with `owner` and `servicer`). */
export function account(tag: string, ref: AccountRef, withOwner = false): XmlElement {
  if (ref.id.length > 34) throw new RangeError(`Account id "${ref.id}" is longer than 34 characters`);
  return el(
    tag,
    el("Id", el("Othr", text("Id", ref.id), el("SchmeNm", text("Prtry", SETTLEMENT_SYSTEM)))),
    withOwner ? text("Ccy", ref.currency) : undefined,
    text("Nm", ref.name),
    ref.address ? el("Prxy", el("Tp", text("Prtry", "EVM")), text("Id", ref.address)) : undefined,
    withOwner ? el("Ownr", text("Nm", ref.owner)) : undefined,
    withOwner ? agent("Svcr", ref.servicer) : undefined,
  );
}

export function amount(tag: string, value: Money): XmlElement {
  if (value.minor < 0n) throw new RangeError(`${tag} cannot be negative`);
  return text(tag, formatMoney(value), { Ccy: value.currency })!;
}

/** ISODateTime in UTC, to the second. */
export const dateTime = (instant: Date) => instant.toISOString().replace(/\.\d{3}Z$/, "Z");

/** ISODate of an instant, in UTC. */
export const date = (instant: Date) => instant.toISOString().slice(0, 10);

/**
 * A deterministic identifier of at most 35 characters: a prefix and a hash of
 * what the identifier names, so the same message always gets the same id.
 */
export function identifier(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${prefix}-${hash}`.slice(0, 35);
}

/** The end-to-end id of an instruction: its UETR without dashes (32 characters). */
export const endToEndId = (uetr: string) => uetr.replaceAll("-", "");

/** The root `Document` element of a message. */
export function document(version: MessageVersion, body: XmlElement): XmlElement {
  return el("Document", { xmlns: namespace(version) }, body);
}

export interface Built {
  readonly version: MessageVersion;
  readonly msgId: string;
  readonly xml: string;
}
