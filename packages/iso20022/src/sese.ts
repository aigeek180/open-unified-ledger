import { formatMoney, type Money } from "@oul/domain";
import { type BankRef, type Built, date, dateTime, document, endToEndId, identifier, SETTLEMENT_SYSTEM } from "./common.ts";
import { MESSAGES } from "./schemas.ts";
import { el, text, toXml } from "./xml.ts";

/**
 * Securities settlement messages for bonds and repo (SPEC.md §5.4–§5.10, §8):
 *   sese.023  each side's settlement instruction: the deliverer's DELI and the
 *             receiver's RECE, both against payment (APMT), matched by the
 *             common reference CmonId, which is the instruction's UETR. A
 *             buyer's affirmation is, in substance, its RECE instruction;
 *   sese.025  the confirmation to each side once the shared ledger settled it.
 * Version 13 carries what a tokenized settlement needs: the holders' on-chain
 * addresses (BlckChainAdrOrWllt) and the cash leg as a quantity of a digital
 * payment token (DgtlPmtSttlm), here the wholesale token.
 *
 * A repo's legs (§5.7–§5.10) are securities movements too: its opening and
 * its close against payment, typed repo (REPU) from the borrower's side and
 * reverse repo (RVPO) from the lender's, the close marked as the return leg;
 * a margin or a substitution free of payment, typed collateral out (COLO)
 * from the borrower's side and collateral in (COLI) from the lender's, a
 * margin's repurchase type top-up (TOPU) or withdrawal (WTHD). Every leg
 * names its repo by the opening's UETR as its collateral transaction id
 * (CollTxId). The repo's terms (rate, haircut, end date) belong to a
 * securities financing message (sese.033), which this adapter does not
 * write: its schema is not among those vendored.
 */

export type SecuritiesTransactionType = "ISSU" | "TRAD" | "REDM" | "REPU" | "RVPO" | "COLI" | "COLO";
export type MovementSide = "DELI" | "RECE";

/** How a movement belongs to a repo: which one, and what kind of repo leg it is. */
export interface RepoLeg {
  /** The UETR of the instruction that opened the repo. */
  readonly repo: string;
  /** Each side's transaction type: the borrower's and the lender's differ. */
  readonly types: Readonly<Record<MovementSide, SecuritiesTransactionType>>;
  /** A margin's repurchase type: top-up or withdrawal. */
  readonly repurchase?: "TOPU" | "WTHD";
  /** The repo's closing leg. */
  readonly returnLeg?: boolean;
}

export interface SecuritiesParty {
  readonly bank: BankRef;
  /** Its safekeeping account in its own books, at most 35 characters. */
  readonly account: string;
  /** The address that holds the units on the shared ledger. */
  readonly address: string;
}

export interface SecuritiesSettlement {
  readonly uetr: string;
  readonly createdAt: Date;
  readonly tradeDate: Date;
  readonly settlementDate: Date;
  readonly type: SecuritiesTransactionType;
  readonly security: { readonly symbol: string; readonly name: string };
  readonly units: bigint;
  /** Price per unit, if traded at a price (not for a redemption at face). */
  readonly price?: Money;
  /** The cash that moves against the units; none for a movement free of payment. */
  readonly amount?: Money;
  readonly deliverer: SecuritiesParty;
  readonly receiver: SecuritiesParty;
  /** The digital payment token the cash leg settles in. */
  readonly cashToken: { readonly symbol: string; readonly name: string };
  /** A repo leg (§5.7–§5.10): the repo it belongs to and its type from each side. */
  readonly repo?: RepoLeg;
  /** Which of an instruction's movements this is, when it has more than one of the same side and party. */
  readonly leg?: string;
}

const proprietary = (id: string, name?: string) =>
  [el("OthrId", text("Id", id), el("Tp", text("Prtry", SETTLEMENT_SYSTEM))), text("Desc", name)] as const;

function party(tag: string, p: SecuritiesParty) {
  return el(
    tag,
    el(
      "Pty1",
      el("Id", el("PrtryId", text("Id", p.bank.id), text("Issr", SETTLEMENT_SYSTEM))),
      el("SfkpgAcct", text("Id", p.account)),
      el("BlckChainAdrOrWllt", text("Id", p.address)),
    ),
  );
}

function price(value: Money | undefined) {
  return value
    ? el("DealPric", el("Tp", text("Yldd", "false")), el("Val", text("Amt", formatMoney(value), { Ccy: value.currency })))
    : undefined;
}

function cashLeg(s: SecuritiesSettlement) {
  if (!s.amount) return undefined;
  return el(
    "DgtlPmtSttlm",
    el("FinInstrmId", ...proprietary(s.cashToken.symbol, s.cashToken.name)),
    el("Qty", text("ElctrncMnyTknSttlmQty", formatMoney(s.amount))),
  );
}

function amountAndDirection(tag: string, s: SecuritiesSettlement, side: MovementSide) {
  if (!s.amount) return undefined;
  // The deliverer receives the cash; the receiver pays it.
  return el(tag, text("Amt", formatMoney(s.amount), { Ccy: s.amount.currency }), text("CdtDbtInd", side === "DELI" ? "CRDT" : "DBIT"));
}

/** Against payment, or free of payment where no cash moves. */
const payment = (s: SecuritiesSettlement) => (s.amount ? "APMT" : "FREE");

/** This side's transaction type: a repo leg's differs between the borrower's and the lender's side. */
const typeOf = (s: SecuritiesSettlement, side: MovementSide) => s.repo?.types[side] ?? s.type;

/** The collateral transaction a repo leg belongs to: its repo, by the opening's UETR. */
const collateralTx = (s: SecuritiesSettlement) => (s.repo ? text("CollTxId", endToEndId(s.repo.repo)) : undefined);

/** The settlement parameters: the type, and for a repo leg its repurchase type and whether it is the return leg. */
function settlementParams(s: SecuritiesSettlement, side: MovementSide, returnLeg: boolean) {
  return el(
    "SttlmParams",
    el("SctiesTxTp", text("Cd", typeOf(s, side))),
    s.repo?.repurchase ? el("RpTp", text("Cd", s.repo.repurchase)) : undefined,
    returnLeg && s.repo?.returnLeg ? text("RtrLeg", "true") : undefined,
  );
}

/** The transaction id each side gives its own instruction. */
export const instructionTxId = (s: SecuritiesSettlement, side: MovementSide) =>
  identifier(side === "DELI" ? "D023" : "R023", s.uetr, side === "DELI" ? s.deliverer.bank.id : s.receiver.bank.id, ...(s.leg ? [s.leg] : []));

/** sese.023: one side's settlement instruction, delivering or receiving against payment. */
export function sese023(s: SecuritiesSettlement, side: MovementSide): Built {
  const version = MESSAGES["sese.023"];
  const own = side === "DELI" ? s.deliverer : s.receiver;
  const txId = instructionTxId(s, side);
  const body = el(
    "SctiesSttlmTxInstr",
    text("TxId", txId),
    el("SttlmTpAndAddtlParams", text("SctiesMvmntTp", side), text("Pmt", payment(s)), text("CmonId", endToEndId(s.uetr))),
    el(
      "TradDtls",
      collateralTx(s),
      el("TradDt", el("Dt", text("Dt", date(s.tradeDate)))),
      el("SttlmDt", el("Dt", text("DtTm", dateTime(s.settlementDate)))),
      price(s.price),
    ),
    el("FinInstrmId", ...proprietary(s.security.symbol, s.security.name)),
    el(
      "QtyAndAcctDtls",
      el("SttlmQty", el("Qty", text("Unit", s.units.toString()))),
      el("SfkpgAcct", text("Id", own.account)),
      el("BlckChainAdrOrWllt", text("Id", own.address)),
    ),
    settlementParams(s, side, true),
    party("DlvrgSttlmPties", s.deliverer),
    party("RcvgSttlmPties", s.receiver),
    amountAndDirection("SttlmAmt", s, side),
    cashLeg(s),
  );
  return { version, msgId: txId, xml: toXml(document(version, body)) };
}

/** sese.025: the confirmation to one side that the shared ledger settled the instruction. */
export function sese025(s: SecuritiesSettlement, side: MovementSide, settled: { at: Date; block: bigint }): Built {
  const version = MESSAGES["sese.025"];
  const own = side === "DELI" ? s.deliverer : s.receiver;
  const confirmationId = identifier(side === "DELI" ? "D025" : "R025", s.uetr, own.bank.id, ...(s.leg ? [s.leg] : []));
  const body = el(
    "SctiesSttlmTxConf",
    el(
      "TxIdDtls",
      text("AcctOwnrTxId", instructionTxId(s, side)),
      text("AcctSvcrTxId", confirmationId),
      text("MktInfrstrctrTxId", `block-${settled.block}`),
      text("SctiesMvmntTp", side),
      text("Pmt", payment(s)),
      text("CmonId", endToEndId(s.uetr)),
    ),
    el(
      "TradDtls",
      collateralTx(s),
      el("TradDt", el("Dt", text("Dt", date(s.tradeDate)))),
      el("SttlmDt", el("Dt", text("DtTm", dateTime(s.settlementDate)))),
      el("FctvSttlmDt", el("Dt", text("DtTm", dateTime(settled.at)))),
      price(s.price),
    ),
    el("FinInstrmId", ...proprietary(s.security.symbol, s.security.name)),
    el(
      "QtyAndAcctDtls",
      el("SttldQty", el("Qty", text("Unit", s.units.toString()))),
      el("SfkpgAcct", text("Id", own.account)),
      el("BlckChainAdrOrWllt", text("Id", own.address)),
    ),
    // sese.025 has no return-leg indicator; its CollTxId and type say the same.
    settlementParams(s, side, false),
    party("DlvrgSttlmPties", s.deliverer),
    party("RcvgSttlmPties", s.receiver),
    amountAndDirection("SttldAmt", s, side),
    cashLeg(s),
  );
  return { version, msgId: confirmationId, xml: toXml(document(version, body)) };
}
