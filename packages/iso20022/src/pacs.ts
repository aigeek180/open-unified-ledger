import type { Money } from "@oul/domain";
import {
  type AccountRef,
  account,
  agent,
  amount,
  type BankRef,
  type Built,
  date,
  dateTime,
  document,
  endToEndId,
  identifier,
  SETTLEMENT_SYSTEM,
} from "./common.ts";
import { MESSAGES } from "./schemas.ts";
import { el, text, toXml } from "./xml.ts";

/**
 * The payments messages of SPEC.md §8:
 *   pacs.008  a customer's payment to a customer of another bank (§5.3); for
 *             a payment across currencies (§13), the amount instructed in the
 *             payer's currency, the amount settled in the payee's, and the
 *             dealer's rate between them;
 *   pacs.009  each wholesale leg between banks, sent as a cover payment that
 *             carries the customer payment's UETR, as SWIFT CBPR+ does: one
 *             for a payment in one currency, one per currency across two;
 *   pacs.002  the instruction's outcome.
 * The UETR is the settlement engine's instruction id, so each message and its
 * settlement on the shared ledger can be matched in either direction.
 */

export interface CustomerPayment {
  readonly uetr: string;
  readonly createdAt: Date;
  /** When the shared ledger settled it, or will. */
  readonly settlementDate: Date;
  readonly amount: Money;
  readonly debtor: AccountRef;
  readonly creditor: AccountRef;
  /**
   * A payment across currencies: what the payer's bank instructed, in the
   * payer's currency, and the rate that turned it into `amount`, settled in
   * the payee's currency.
   */
  readonly instructed?: { readonly amount: Money; readonly rate: string };
}

/**
 * XchgRate is a BaseOneRate: at most 11 digits, 10 of them after the point.
 * A rate the message cannot carry is refused rather than rounded.
 */
function exchangeRate(rate: string) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!match) throw new RangeError(`Not a rate: "${rate}"`);
  const whole = match[1]!.replace(/^0+/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > 10 || whole.length + fraction.length > 11) {
    throw new RangeError(`Rate ${rate} has more digits than an ISO 20022 BaseOneRate holds`);
  }
  return text("XchgRate", rate);
}

function groupHeader(msgId: string, createdAt: Date, settlementDate: Date, total: Money) {
  return el(
    "GrpHdr",
    text("MsgId", msgId),
    text("CreDtTm", dateTime(createdAt)),
    text("NbOfTxs", "1"),
    amount("TtlIntrBkSttlmAmt", total),
    text("IntrBkSttlmDt", date(settlementDate)),
    el("SttlmInf", text("SttlmMtd", "CLRG"), el("ClrSys", text("Prtry", SETTLEMENT_SYSTEM))),
  );
}

function paymentId(uetr: string, instructionId: string) {
  return el(
    "PmtId",
    text("InstrId", instructionId),
    text("EndToEndId", endToEndId(uetr)),
    text("TxId", endToEndId(uetr)),
    text("UETR", uetr),
  );
}

/** pacs.008: the customer credit transfer, from the payer's bank to the payee's. */
export function pacs008(payment: CustomerPayment): Built {
  const version = MESSAGES["pacs.008"];
  const msgId = identifier("OUL008", payment.uetr);
  const body = el(
    "FIToFICstmrCdtTrf",
    groupHeader(msgId, payment.createdAt, payment.settlementDate, payment.amount),
    el(
      "CdtTrfTxInf",
      paymentId(payment.uetr, identifier("I008", payment.uetr)),
      amount("IntrBkSttlmAmt", payment.amount),
      payment.instructed ? amount("InstdAmt", payment.instructed.amount) : undefined,
      payment.instructed ? exchangeRate(payment.instructed.rate) : undefined,
      text("ChrgBr", "SLEV"),
      agent("InstgAgt", payment.debtor.servicer),
      agent("InstdAgt", payment.creditor.servicer),
      el("Dbtr", text("Nm", payment.debtor.owner)),
      account("DbtrAcct", payment.debtor),
      agent("DbtrAgt", payment.debtor.servicer),
      agent("CdtrAgt", payment.creditor.servicer),
      el("Cdtr", text("Nm", payment.creditor.owner)),
      account("CdtrAcct", payment.creditor),
    ),
  );
  return { version, msgId, xml: toXml(document(version, body)) };
}

export interface InterbankTransfer {
  readonly uetr: string;
  readonly createdAt: Date;
  readonly settlementDate: Date;
  readonly amount: Money;
  readonly debtorBank: BankRef & { readonly address?: string };
  readonly creditorBank: BankRef & { readonly address?: string };
  /** The customer payment this transfer covers, if any (a cover payment, pacs.009 COV). */
  readonly underlying?: CustomerPayment;
  /** Which of the instruction's wholesale legs this is, when it has more than one: its currency. */
  readonly leg?: string;
}

/** pacs.009: a financial institution credit transfer, here the wholesale-token leg. */
export function pacs009(transfer: InterbankTransfer): Built {
  const version = MESSAGES["pacs.009"];
  const leg = transfer.leg ? [transfer.leg] : [];
  const msgId = identifier("OUL009", transfer.uetr, ...leg);
  const bankAccount = (bank: InterbankTransfer["debtorBank"], tag: string) =>
    bank.address
      ? account(tag, { id: bank.id, owner: bank.name, servicer: bank, currency: transfer.amount.currency, address: bank.address })
      : undefined;
  const underlying = transfer.underlying;
  const body = el(
    "FICdtTrf",
    groupHeader(msgId, transfer.createdAt, transfer.settlementDate, transfer.amount),
    el(
      "CdtTrfTxInf",
      paymentId(transfer.uetr, identifier("I009", transfer.uetr, ...leg)),
      underlying ? el("PmtTpInf", el("CtgyPurp", text("Cd", "CORT"))) : undefined,
      amount("IntrBkSttlmAmt", transfer.amount),
      agent("InstgAgt", transfer.debtorBank),
      agent("InstdAgt", transfer.creditorBank),
      agent("Dbtr", transfer.debtorBank),
      bankAccount(transfer.debtorBank, "DbtrAcct"),
      agent("Cdtr", transfer.creditorBank),
      bankAccount(transfer.creditorBank, "CdtrAcct"),
      underlying
        ? el(
            "UndrlygCstmrCdtTrf",
            el("Dbtr", text("Nm", underlying.debtor.owner)),
            account("DbtrAcct", underlying.debtor),
            agent("DbtrAgt", underlying.debtor.servicer),
            agent("CdtrAgt", underlying.creditor.servicer),
            el("Cdtr", text("Nm", underlying.creditor.owner)),
            account("CdtrAcct", underlying.creditor),
            amount("InstdAmt", underlying.instructed?.amount ?? underlying.amount),
          )
        : undefined,
    ),
  );
  return { version, msgId, xml: toXml(document(version, body)) };
}

export type PaymentStatus = "ACSC" | "PDNG" | "RJCT";

export interface StatusReport {
  readonly uetr: string;
  readonly createdAt: Date;
  /** The message whose transaction this reports on. */
  readonly original: { readonly msgId: string; readonly version: string };
  readonly status: PaymentStatus;
  /** Why it was rejected: the engine's error, or that the deadline passed. */
  readonly reason?: string;
  /** The block it settled in, for an accepted one. */
  readonly settledBlock?: bigint;
  readonly from: BankRef;
  readonly to: BankRef;
}

/** pacs.002: the instruction's status, ACSC once the shared ledger committed it. */
export function pacs002(report: StatusReport): Built {
  const version = MESSAGES["pacs.002"];
  const msgId = identifier("OUL002", report.uetr, report.status);
  const body = el(
    "FIToFIPmtStsRpt",
    el("GrpHdr", text("MsgId", msgId), text("CreDtTm", dateTime(report.createdAt)), agent("InstgAgt", report.from), agent("InstdAgt", report.to)),
    el(
      "TxInfAndSts",
      el("OrgnlGrpInf", text("OrgnlMsgId", report.original.msgId), text("OrgnlMsgNmId", report.original.version)),
      text("OrgnlEndToEndId", endToEndId(report.uetr)),
      text("OrgnlTxId", endToEndId(report.uetr)),
      text("OrgnlUETR", report.uetr),
      text("TxSts", report.status),
      report.reason
        ? el("StsRsnInf", el("Rsn", text("Prtry", report.reason.slice(0, 35))), text("AddtlInf", report.reason.slice(0, 105)))
        : undefined,
      report.settledBlock !== undefined ? text("AcctSvcrRef", `block-${report.settledBlock}`) : undefined,
    ),
  );
  return { version, msgId, xml: toXml(document(version, body)) };
}
