import { formatMoney, type Money, money } from "@oul/domain";
import { type AccountRef, account, amount, type Built, date, dateTime, document, endToEndId, identifier } from "./common.ts";
import { MESSAGES } from "./schemas.ts";
import { el, text, toXml } from "./xml.ts";

/**
 * Cash management messages from a bank to an account holder (SPEC.md §8):
 *   camt.054  a notification of credits and debits to an account;
 *   camt.053  an account statement over a period, with opening and closing
 *             balances.
 * Seen from the holder: what the bank owes the holder is a credit balance.
 */

export interface AccountEntry {
  /** The journal entry's reference in the servicer's books. */
  readonly ref: string;
  readonly amount: Money;
  readonly side: "credit" | "debit";
  readonly status: "BOOK" | "PDNG";
  readonly bookedAt: Date;
  /** A proprietary bank transaction code naming the flow, e.g. "INTERBANK". */
  readonly code: string;
  /** The settlement instruction behind the entry, if any. */
  readonly uetr?: string;
  /** The shared-ledger block the entry settled in, if any. */
  readonly block?: bigint;
  readonly info?: string;
}

function entry(e: AccountEntry) {
  return el(
    "Ntry",
    text("NtryRef", e.ref.slice(0, 35)),
    amount("Amt", e.amount),
    text("CdtDbtInd", e.side === "credit" ? "CRDT" : "DBIT"),
    el("Sts", text("Cd", e.status)),
    el("BookgDt", text("DtTm", dateTime(e.bookedAt))),
    el("ValDt", text("Dt", date(e.bookedAt))),
    e.block !== undefined ? text("AcctSvcrRef", `block-${e.block}`) : undefined,
    el("BkTxCd", el("Prtry", text("Cd", e.code), text("Issr", "OUL"))),
    e.uetr
      ? el(
          "NtryDtls",
          el(
            "TxDtls",
            el("Refs", text("EndToEndId", endToEndId(e.uetr)), text("UETR", e.uetr)),
            amount("Amt", e.amount),
            text("CdtDbtInd", e.side === "credit" ? "CRDT" : "DBIT"),
          ),
        )
      : undefined,
    text("AddtlNtryInf", e.info?.slice(0, 500)),
  );
}

export interface Notification {
  readonly createdAt: Date;
  readonly account: AccountRef;
  readonly entries: readonly AccountEntry[];
}

/** camt.054: credits and debits to one account. */
export function camt054(notification: Notification): Built {
  const version = MESSAGES["camt.054"];
  const refs = notification.entries.map((e) => e.ref);
  const msgId = identifier("OUL054", notification.account.id, ...refs);
  const body = el(
    "BkToCstmrDbtCdtNtfctn",
    el("GrpHdr", text("MsgId", msgId), text("CreDtTm", dateTime(notification.createdAt))),
    el(
      "Ntfctn",
      text("Id", identifier("N054", notification.account.id, ...refs)),
      text("CreDtTm", dateTime(notification.createdAt)),
      account("Acct", notification.account, true),
      notification.entries.map(entry),
    ),
  );
  return { version, msgId, xml: toXml(document(version, body)) };
}

export interface Statement {
  readonly createdAt: Date;
  readonly account: AccountRef;
  readonly from: Date;
  readonly to: Date;
  /** Balances from the holder's side: positive is owed to the holder (CRDT). */
  readonly opening: Money;
  readonly closing: Money;
  readonly entries: readonly AccountEntry[];
}

function balance(code: "OPBD" | "CLBD", value: Money, at: Date) {
  const negative = value.minor < 0n;
  return el(
    "Bal",
    el("Tp", el("CdOrPrtry", text("Cd", code))),
    amount("Amt", money(value.currency, negative ? -value.minor : value.minor)),
    text("CdtDbtInd", negative ? "DBIT" : "CRDT"),
    el("Dt", text("DtTm", dateTime(at))),
  );
}

/** camt.053: a statement of one account over a period. */
export function camt053(statement: Statement): Built {
  const version = MESSAGES["camt.053"];
  const period = [statement.account.id, dateTime(statement.from), dateTime(statement.to)];
  const msgId = identifier("OUL053", ...period);
  const credits = statement.entries.filter((e) => e.side === "credit");
  const debits = statement.entries.filter((e) => e.side === "debit");
  const total = (entries: readonly AccountEntry[]) =>
    money(statement.opening.currency, entries.reduce((t, e) => t + e.amount.minor, 0n));
  const body = el(
    "BkToCstmrStmt",
    el("GrpHdr", text("MsgId", msgId), text("CreDtTm", dateTime(statement.createdAt))),
    el(
      "Stmt",
      text("Id", identifier("S053", ...period)),
      text("CreDtTm", dateTime(statement.createdAt)),
      el("FrToDt", text("FrDtTm", dateTime(statement.from)), text("ToDtTm", dateTime(statement.to))),
      account("Acct", statement.account, true),
      balance("OPBD", statement.opening, statement.from),
      balance("CLBD", statement.closing, statement.to),
      el(
        "TxsSummry",
        el(
          "TtlNtries",
          text("NbOfNtries", String(statement.entries.length)),
        ),
        el("TtlCdtNtries", text("NbOfNtries", String(credits.length)), text("Sum", formatMoney(total(credits)))),
        el("TtlDbtNtries", text("NbOfNtries", String(debits.length)), text("Sum", formatMoney(total(debits)))),
      ),
      statement.entries.map(entry),
    ),
  );
  return { version, msgId, xml: toXml(document(version, body)) };
}
