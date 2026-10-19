import { bankAccounts, centralBankAccounts, type CurrencyCode, formatMoney, type Line, type Money, money } from "@oul/domain";
import {
  type AccountEntry,
  type AccountRef,
  type BankRef,
  type Built,
  camt053,
  camt054,
  type MessageType,
  type PaymentStatus,
  pacs002,
  pacs008,
  pacs009,
  type SecuritiesSettlement,
  sese023,
  sese025,
} from "@oul/iso20022";
import { centralBankFor, depositOf, wholesaleFor } from "@oul/scenario";
import type { RuntimeContext } from "./context.ts";
import { type BondFlow, bondInfo, type Custody, type Flow, flowCurrency, flowValue, type RepoFlow } from "./flows.ts";
import { getInstruction, type InstructionRow } from "./store.ts";

/**
 * The ISO 20022 messages a participant serves (SPEC.md §8), built from its
 * own instruction rows and journal: for an instruction, the messages that
 * concern this participant; for an account, a camt.053 statement.
 *
 * Account ids in messages fit ISO 20022's 34 characters: a customer's deposit
 * is `dda/<customer>`, its tokenized deposit `tok/<customer>`; a bank's
 * accounts at the central bank keep their ledger codes.
 */

export interface Message {
  /** What the message is in this instruction, e.g. "pacs.008" or "camt.054-payer-debit". */
  readonly name: string;
  readonly type: MessageType;
  readonly version: string;
  readonly msgId: string;
  readonly xml: string;
}

const CODES: Record<Flow["kind"], string> = {
  fund: "FUND",
  redeem: "REDEEM",
  tokenize: "TOKENIZE",
  detokenize: "DETOKENIZE",
  interbank: "INTERBANK",
  pvp: "PVP",
  "bond-issue": "ISSUE",
  "bond-trade": "TRADE",
  "bond-coupon": "COUPON",
  "bond-redeem": "REDEMPTION",
  "repo-open": "REPO",
  "repo-margin": "REPO-MARGIN",
  "repo-substitute": "REPO-SUBSTITUTION",
  "repo-close": "REPO-CLOSE",
  "repo-manufactured": "MANUFACTURED",
};

/**
 * How parties and accounts appear in messages about `currency`: a bank's
 * accounts at that currency's central bank, and each customer's accounts in
 * its bank's deposit currency.
 */
function parties(rt: RuntimeContext, currency: CurrencyCode) {
  const { scenario, deployment } = rt;
  const cb = centralBankFor(scenario, currency).id;
  const depositCurrency = (b: string) => depositOf(scenario, b).currency;
  const name = (id: string) => scenario.participants.find((p) => p.id === id)?.name ?? id;
  const customerName = (bank: string, customer: string) =>
    scenario.ledgers.find((l) => l.participant === bank)?.customers.find((c) => c.id === customer)?.name ?? customer;
  const bank = (id: string): BankRef => ({ id, name: name(id) });
  return {
    currency,
    bank,
    address: (id: string) => deployment.participants[id]!.address,
    deposit: (b: string, customer: string): AccountRef => ({
      id: `dda/${customer}`,
      owner: customerName(b, customer),
      servicer: bank(b),
      currency: depositCurrency(b),
    }),
    tokenized: (b: string, customer: string): AccountRef => ({
      id: `tok/${customer}`,
      owner: customerName(b, customer),
      servicer: bank(b),
      currency: depositCurrency(b),
      address: deployment.customers[`${b}/${customer}`]!.address,
    }),
    settlement: (b: string): AccountRef => ({
      id: centralBankAccounts.settlementAccount(b),
      owner: name(b),
      servicer: bank(cb),
      currency,
    }),
    wholesale: (b: string): AccountRef => ({
      id: centralBankAccounts.wholesaleLine(b),
      owner: name(b),
      servicer: bank(cb),
      currency,
      address: deployment.participants[b]!.address,
    }),
  };
}

const named = (name: string, type: MessageType, built: Built): Message => ({ name, type, ...built });

/** The messages that concern this participant for one of its instructions. */
export async function instructionMessages(rt: RuntimeContext, uetr: string): Promise<Message[] | undefined> {
  const row = await getInstruction(rt.books.database, uetr);
  if (!row) return undefined;
  const entry = await rt.books.entryByKey(row.entryKey);
  const flow = row.flow;
  const p = parties(rt, flowCurrency(flow, rt.scenario));
  const self = rt.participant;
  const settled = row.status === "settled";
  const dead = row.status === "failed" || row.status === "expired";
  const settledAt = entry?.postedAt ?? row.createdAt;
  const cash = (minor: bigint | string) => money(p.currency, BigInt(minor));
  const block = row.settledBlock ?? undefined;
  const notification = (account: AccountRef, amount: Money, side: "credit" | "debit", info?: string) =>
    camt054({
      createdAt: settledAt,
      account,
      entries: [
        {
          ref: row.entryKey,
          amount,
          side,
          status: settled ? "BOOK" : "PDNG",
          bookedAt: settledAt,
          code: CODES[flow.kind],
          uetr,
          ...(block !== undefined ? { block } : {}),
          ...(info ? { info } : {}),
        },
      ],
    });
  const messages: Message[] = [];
  // A voided entry was never booked: there is nothing to notify, only the refusal to report.
  const notify = !dead;

  switch (flow.kind) {
    case "fund":
    case "redeem": {
      const amount = cash(flow.amount);
      const fund = flow.kind === "fund";
      if (notify) {
        messages.push(named(`camt.054-settlement-${fund ? "debit" : "credit"}`, "camt.054", notification(p.settlement(flow.bank), amount, fund ? "debit" : "credit")));
        messages.push(named(`camt.054-wholesale-${fund ? "credit" : "debit"}`, "camt.054", notification(p.wholesale(flow.bank), amount, fund ? "credit" : "debit")));
      }
      break;
    }
    case "tokenize":
    case "detokenize": {
      const amount = cash(flow.amount);
      const tokenize = flow.kind === "tokenize";
      if (notify) {
        messages.push(named(`camt.054-deposit-${tokenize ? "debit" : "credit"}`, "camt.054", notification(p.deposit(flow.bank, flow.customer), amount, tokenize ? "debit" : "credit")));
        messages.push(named(`camt.054-tokenized-${tokenize ? "credit" : "debit"}`, "camt.054", notification(p.tokenized(flow.bank, flow.customer), amount, tokenize ? "credit" : "debit")));
      }
      break;
    }
    case "interbank": {
      const payment = {
        uetr,
        createdAt: row.createdAt,
        settlementDate: settledAt,
        amount: cash(flow.amount),
        debtor: p.tokenized(flow.payerBank, flow.payer),
        creditor: p.tokenized(flow.payeeBank, flow.payee),
      };
      const customerPayment = pacs008(payment);
      messages.push(named("pacs.008", "pacs.008", customerPayment));
      messages.push(
        named(
          "pacs.009-cover",
          "pacs.009",
          pacs009({
            uetr,
            createdAt: row.createdAt,
            settlementDate: settledAt,
            amount: payment.amount,
            debtorBank: { ...p.bank(flow.payerBank), address: p.address(flow.payerBank) },
            creditorBank: { ...p.bank(flow.payeeBank), address: p.address(flow.payeeBank) },
            underlying: payment,
          }),
        ),
      );
      const status: PaymentStatus = settled ? "ACSC" : dead ? "RJCT" : "PDNG";
      messages.push(
        named(
          "pacs.002",
          "pacs.002",
          pacs002({
            uetr,
            createdAt: settledAt,
            original: { msgId: customerPayment.msgId, version: customerPayment.version },
            status,
            ...(dead && row.lastError ? { reason: row.lastError.replace(/^refused by the engine: /, "") } : {}),
            ...(settled && block !== undefined ? { settledBlock: block } : {}),
            from: p.bank(flow.payeeBank),
            to: p.bank(flow.payerBank),
          }),
        ),
      );
      if (notify && self === flow.payerBank) {
        messages.push(named("camt.054-payer-debit", "camt.054", notification(payment.debtor, payment.amount, "debit")));
      }
      if (notify && self === flow.payeeBank) {
        messages.push(named("camt.054-payee-credit", "camt.054", notification(payment.creditor, payment.amount, "credit")));
      }
      break;
    }
    case "pvp": {
      // §13: the customer payment instructed in the payer's currency and settled in the payee's
      // at the dealer's rate, a cover for each currency's wholesale leg, and the outcome.
      const { quote } = flow;
      const source = cash(quote.sourceAmount);
      const target = money(quote.to, BigInt(quote.targetAmount));
      const payment = {
        uetr,
        createdAt: row.createdAt,
        settlementDate: settledAt,
        amount: target,
        instructed: { amount: source, rate: quote.rate },
        debtor: p.tokenized(flow.payerBank, flow.payer),
        creditor: p.tokenized(flow.payeeBank, flow.payee),
      };
      const customerPayment = pacs008(payment);
      const customerBanks = self === flow.payerBank || self === flow.payeeBank;
      if (customerBanks) messages.push(named("pacs.008", "pacs.008", customerPayment));
      const legs = [
        { amount: source, from: flow.payerBank, to: quote.dealer },
        { amount: target, from: quote.dealer, to: flow.payeeBank },
      ];
      for (const leg of legs) {
        if (self !== leg.from && self !== leg.to) continue;
        const currency = leg.amount.currency;
        messages.push(
          named(
            `pacs.009-cover-${currency}`,
            "pacs.009",
            pacs009({
              uetr,
              createdAt: row.createdAt,
              settlementDate: settledAt,
              amount: leg.amount,
              debtorBank: { ...p.bank(leg.from), address: p.address(leg.from) },
              creditorBank: { ...p.bank(leg.to), address: p.address(leg.to) },
              underlying: payment,
              leg: currency,
            }),
          ),
        );
      }
      if (customerBanks) {
        const status: PaymentStatus = settled ? "ACSC" : dead ? "RJCT" : "PDNG";
        messages.push(
          named(
            "pacs.002",
            "pacs.002",
            pacs002({
              uetr,
              createdAt: settledAt,
              original: { msgId: customerPayment.msgId, version: customerPayment.version },
              status,
              ...(dead && row.lastError ? { reason: row.lastError.replace(/^refused by the engine: /, "") } : {}),
              ...(settled && block !== undefined ? { settledBlock: block } : {}),
              from: p.bank(flow.payeeBank),
              to: p.bank(flow.payerBank),
            }),
          ),
        );
      }
      const at = `${quote.rate} ${quote.to} per ${quote.from}`;
      if (notify && self === flow.payerBank) {
        messages.push(named("camt.054-payer-debit", "camt.054", notification(payment.debtor, source, "debit", `${quote.to} ${formatMoney(target)} at ${at}`)));
      }
      if (notify && self === flow.payeeBank) {
        messages.push(named("camt.054-payee-credit", "camt.054", notification(payment.creditor, target, "credit", `${quote.from} ${formatMoney(source)} at ${at}`)));
      }
      break;
    }
    case "repo-open":
    case "repo-margin":
    case "repo-substitute":
    case "repo-close":
    case "repo-manufactured":
      messages.push(...repoMessages(rt, row, flow, { settled, dead, settledAt, block, notification }));
      break;
    default:
      messages.push(...bondMessages(rt, row, flow, { settled, dead, settledAt, block, notification, lines: entry?.lines ?? [] }));
  }
  return messages;
}

function bondMessages(
  rt: RuntimeContext,
  row: InstructionRow,
  flow: BondFlow,
  ctx: {
    settled: boolean;
    dead: boolean;
    settledAt: Date;
    block: bigint | undefined;
    notification: (account: AccountRef, amount: Money, side: "credit" | "debit", info?: string) => Built;
    /** The lines this participant booked: a custodian's clients' shares of a coupon or redemption (§15). */
    lines: readonly Line[];
  },
): Message[] {
  const info = bondInfo(rt.scenario, flow.bond);
  const p = parties(rt, info.terms.face.currency);
  const spec = rt.scenario.instruments.bonds.find((b) => b.symbol === flow.bond)!;
  const self = rt.participant;
  const cash = (minor: bigint | string) => money(p.currency, BigInt(minor));
  const holder = (bank: string) => ({ bank: p.bank(bank), account: `bond-holdings/${flow.bond}`, address: p.address(bank) });
  // A custody client's units are safekept at its custodian's omnibus wallet (§15): its own account there.
  const holderOf = (bank: string, custody?: Custody) =>
    custody ? { bank: p.bank(bank), account: `custody/${flow.bond}`, address: custody.wallet } : holder(bank);
  const clientSuffix = (custody?: Custody) => (custody ? `-${custody.client}` : "");
  const agent = { bank: p.bank(info.agent), account: `issuance/${flow.bond}`, address: p.address(info.agent) };
  const issuerDeposit = p.deposit(info.agent, info.issuer);
  const base = {
    uetr: row.uetr,
    createdAt: row.createdAt,
    tradeDate: row.createdAt,
    settlementDate: ctx.settledAt,
    security: { symbol: flow.bond, name: spec.name },
    cashToken: { symbol: wholesaleFor(rt.scenario, p.currency).symbol, name: `Wholesale ${p.currency}` },
  };
  const confirmed = ctx.settled && ctx.block !== undefined ? { at: ctx.settledAt, block: ctx.block } : undefined;
  const messages: Message[] = [];
  const both = (s: SecuritiesSettlement, suffix: string, delivererIsSelf: boolean, receiverIsSelf: boolean) => {
    if (delivererIsSelf) {
      messages.push(named(`sese.023-deliver${suffix}`, "sese.023", sese023(s, "DELI")));
      if (confirmed) messages.push(named(`sese.025-deliver${suffix}`, "sese.025", sese025(s, "DELI", confirmed)));
    }
    if (receiverIsSelf) {
      messages.push(named(`sese.023-receive${suffix}`, "sese.023", sese023(s, "RECE")));
      if (confirmed) messages.push(named(`sese.025-receive${suffix}`, "sese.025", sese025(s, "RECE", confirmed)));
    }
  };

  switch (flow.kind) {
    case "bond-issue": {
      const price = cash(flow.price);
      for (const allocation of flow.allocations) {
        const units = BigInt(allocation.units);
        both(
          { ...base, type: "ISSU", units, price, amount: cash(units * price.minor), deliverer: agent, receiver: holderOf(allocation.bank, allocation.custody) },
          `-${allocation.bank}${clientSuffix(allocation.custody)}`,
          self === info.agent,
          self === allocation.bank,
        );
      }
      if (!ctx.dead && self === info.agent) {
        messages.push(named("camt.054-issuer-credit", "camt.054", ctx.notification(issuerDeposit, cash(flowValue(flow)), "credit", `Proceeds of ${flow.bond}`)));
      }
      break;
    }
    case "bond-trade": {
      const units = BigInt(flow.units);
      const price = cash(flow.price);
      both(
        {
          ...base,
          type: "TRAD",
          units,
          price,
          amount: cash(units * price.minor),
          deliverer: holderOf(flow.seller, flow.sellerCustody),
          receiver: holderOf(flow.buyer, flow.buyerCustody),
        },
        "",
        self === flow.seller,
        self === flow.buyer,
      );
      break;
    }
    case "bond-coupon":
    case "bond-redeem": {
      const redemption = flow.kind === "bond-redeem";
      const label = redemption ? `redemption with coupon ${flow.period}` : `coupon ${flow.period}`;
      for (const payment of flow.payments) {
        const paid = "amount" in payment ? cash(payment.amount) : cash(BigInt(payment.principal) + BigInt(payment.coupon));
        const custody = payment.wallet ? "-custody" : "";
        const from = payment.wallet ? { bank: p.bank(payment.bank), account: `custody/${flow.bond}`, address: payment.wallet } : holder(payment.bank);
        if (redemption) {
          both(
            { ...base, type: "REDM", units: BigInt(payment.units), amount: paid, deliverer: from, receiver: agent },
            `-${payment.bank}${custody}`,
            self === payment.bank,
            self === info.agent,
          );
        }
        if (!ctx.dead && (self === payment.bank || self === info.agent)) {
          messages.push(
            named(`camt.054-holder-credit-${payment.bank}${custody}`, "camt.054", ctx.notification(p.wholesale(payment.bank), paid, "credit", `${flow.bond} ${label} on ${payment.units} units${payment.wallet ? " held for clients" : ""}`)),
          );
        }
      }
      // A custodian credits each client its share, by its position at the record block (§15).
      if (!ctx.dead && flow.payments.some((x) => x.bank === self && x.wallet)) {
        for (const client of rt.scenario.custody.find((c) => c.bank === self)?.clients ?? []) {
          const line = ctx.lines.find((l) => l.account === `customer-deposits/${client}` && l.side === "credit");
          if (!line) continue;
          messages.push(named(`camt.054-client-credit-${client}`, "camt.054", ctx.notification(p.deposit(self, client), line.amount, "credit", `${flow.bond} ${label}, its share of the units held for it`)));
        }
      }
      if (!ctx.dead && self === info.agent) {
        messages.push(named("camt.054-issuer-debit", "camt.054", ctx.notification(issuerDeposit, cash(flow.issuerDebit), "debit", `${flow.bond} ${label}`)));
      }
      break;
    }
  }
  return messages;
}

/**
 * A repo's messages (SPEC.md §8): each collateral movement a sese.023 from
 * each side, and its sese.025 once settled, naming the repo by its opening's
 * UETR; the open and the close against the cash, a margin or substitution
 * free of payment. The borrower's units stay in its holdings, pledged; the
 * lender safekeeps what it receives in its own collateral account. A
 * manufactured payment is a wholesale credit transfer between the two banks
 * (pacs.009), its outcome (pacs.002) and each bank's wholesale notification.
 */
function repoMessages(
  rt: RuntimeContext,
  row: InstructionRow,
  flow: RepoFlow,
  ctx: { settled: boolean; dead: boolean; settledAt: Date; block: bigint | undefined; notification: (account: AccountRef, amount: Money, side: "credit" | "debit", info?: string) => Built },
): Message[] {
  const p = parties(rt, flowCurrency(flow, rt.scenario));
  const self = rt.participant;
  const cash = (minor: bigint | string) => money(p.currency, BigInt(minor));
  const messages: Message[] = [];
  if (flow.kind === "repo-manufactured") {
    const transfer = {
      uetr: row.uetr,
      createdAt: row.createdAt,
      settlementDate: ctx.settledAt,
      amount: cash(flow.amount),
      debtorBank: { ...p.bank(flow.lender), address: p.address(flow.lender) },
      creditorBank: { ...p.bank(flow.borrower), address: p.address(flow.borrower) },
    };
    const built = pacs009(transfer);
    messages.push(named("pacs.009", "pacs.009", built));
    const status: PaymentStatus = ctx.settled ? "ACSC" : ctx.dead ? "RJCT" : "PDNG";
    messages.push(
      named(
        "pacs.002",
        "pacs.002",
        pacs002({
          uetr: row.uetr,
          createdAt: ctx.settledAt,
          original: { msgId: built.msgId, version: built.version },
          status,
          ...(ctx.dead && row.lastError ? { reason: row.lastError.replace(/^refused by the engine: /, "") } : {}),
          ...(ctx.settled && ctx.block !== undefined ? { settledBlock: ctx.block } : {}),
          from: p.bank(flow.borrower),
          to: p.bank(flow.lender),
        }),
      ),
    );
    if (!ctx.dead) {
      const info = `${flow.bond} coupon ${flow.period} on ${flow.units} units held as repo collateral`;
      const [account, side] = self === flow.lender ? ([p.wholesale(flow.lender), "debit"] as const) : ([p.wholesale(flow.borrower), "credit"] as const);
      messages.push(named(`camt.054-${self === flow.lender ? "lender-debit" : "borrower-credit"}`, "camt.054", ctx.notification(account, cash(flow.amount), side, info)));
    }
    return messages;
  }

  const name = (bond: string) => rt.scenario.instruments.bonds.find((b) => b.symbol === bond)?.name ?? bond;
  // The borrower's units stay in its holdings, pledged; the lender keeps what it holds apart from what it owns.
  const pledged = (bond: string) => ({ bank: p.bank(flow.borrower), account: `bond-holdings/${bond}`, address: p.address(flow.borrower) });
  const held = (bond: string) => ({ bank: p.bank(flow.lender), account: `collateral/${bond}`, address: p.address(flow.lender) });
  const repo = flow.kind === "repo-open" ? flow.uetr : flow.repo;
  const base = {
    uetr: row.uetr,
    createdAt: row.createdAt,
    tradeDate: row.createdAt,
    settlementDate: ctx.settledAt,
    cashToken: { symbol: wholesaleFor(rt.scenario, p.currency).symbol, name: `Wholesale ${p.currency}` },
  };
  const confirmed = ctx.settled && ctx.block !== undefined ? { at: ctx.settledAt, block: ctx.block } : undefined;
  const toLender = { DELI: "COLO", RECE: "COLI" } as const;
  const toBorrower = { DELI: "COLI", RECE: "COLO" } as const;
  const both = (s: SecuritiesSettlement, suffix = "") => {
    if (s.deliverer.bank.id === self) {
      messages.push(named(`sese.023-deliver${suffix}`, "sese.023", sese023(s, "DELI")));
      if (confirmed) messages.push(named(`sese.025-deliver${suffix}`, "sese.025", sese025(s, "DELI", confirmed)));
    }
    if (s.receiver.bank.id === self) {
      messages.push(named(`sese.023-receive${suffix}`, "sese.023", sese023(s, "RECE")));
      if (confirmed) messages.push(named(`sese.025-receive${suffix}`, "sese.025", sese025(s, "RECE", confirmed)));
    }
  };
  const mark = (marks: readonly { bond: string; price: string }[], bond: string) => {
    const m = marks.find((x) => x.bond === bond);
    return m ? { price: cash(m.price) } : {};
  };

  switch (flow.kind) {
    case "repo-open":
      both({
        ...base,
        type: "REPU",
        security: { symbol: flow.bond, name: name(flow.bond) },
        units: BigInt(flow.units),
        price: cash(flow.mark),
        amount: cash(flow.cash),
        deliverer: pledged(flow.bond),
        receiver: held(flow.bond),
        repo: { repo, types: { DELI: "REPU", RECE: "RVPO" } },
      });
      break;
    case "repo-margin": {
      const deliver = flow.direction === "deliver";
      both({
        ...base,
        type: deliver ? "COLO" : "COLI",
        security: { symbol: flow.bond, name: name(flow.bond) },
        units: BigInt(flow.units),
        ...mark(flow.marks, flow.bond),
        deliverer: deliver ? pledged(flow.bond) : held(flow.bond),
        receiver: deliver ? held(flow.bond) : pledged(flow.bond),
        repo: { repo, types: deliver ? toLender : toBorrower, repurchase: deliver ? "TOPU" : "WTHD" },
      });
      break;
    }
    case "repo-substitute":
      both(
        {
          ...base,
          type: "COLI",
          security: { symbol: flow.outgoing.bond, name: name(flow.outgoing.bond) },
          units: BigInt(flow.outgoing.units),
          ...mark(flow.marks, flow.outgoing.bond),
          deliverer: held(flow.outgoing.bond),
          receiver: pledged(flow.outgoing.bond),
          repo: { repo, types: toBorrower },
          leg: "out",
        },
        "-out",
      );
      both(
        {
          ...base,
          type: "COLO",
          security: { symbol: flow.incoming.bond, name: name(flow.incoming.bond) },
          units: BigInt(flow.incoming.units),
          ...mark(flow.marks, flow.incoming.bond),
          deliverer: pledged(flow.incoming.bond),
          receiver: held(flow.incoming.bond),
          repo: { repo, types: toLender },
          leg: "in",
        },
        "-in",
      );
      break;
    case "repo-close":
      // Every collateral line back; the repurchase price against the first, the rest free of payment.
      flow.collateral.forEach((c, index) =>
        both(
          {
            ...base,
            type: "RVPO",
            security: { symbol: c.bond, name: name(c.bond) },
            units: BigInt(c.units),
            ...(index === 0 ? { amount: cash(BigInt(flow.cash) + BigInt(flow.interest)) } : {}),
            deliverer: held(c.bond),
            receiver: pledged(c.bond),
            repo: { repo, types: { DELI: "RVPO", RECE: "REPU" }, returnLeg: true },
            ...(flow.collateral.length > 1 ? { leg: c.bond } : {}),
          },
          flow.collateral.length > 1 ? `-${c.bond}` : "",
        ),
      );
      break;
  }
  return messages;
}

/** Which accounts this participant can state, and how they appear in messages. */
export function statementAccount(rt: RuntimeContext, request: { kind: string; owner: string }): { code: string; ref: AccountRef } | undefined {
  const p = parties(rt, rt.currency);
  if (rt.kind === "bank") {
    if (!rt.deployment.customers[`${rt.participant}/${request.owner}`]) return undefined;
    if (request.kind === "deposit") return { code: bankAccounts.customerDeposit(request.owner), ref: p.deposit(rt.participant, request.owner) };
    if (request.kind === "tokenized") return { code: bankAccounts.tokenizedDeposit(request.owner), ref: p.tokenized(rt.participant, request.owner) };
    return undefined;
  }
  if (!rt.scenario.participants.find((b) => b.id === request.owner)?.reserves.includes(rt.currency)) return undefined;
  if (request.kind === "settlement") return { code: centralBankAccounts.settlementAccount(request.owner), ref: p.settlement(request.owner) };
  if (request.kind === "wholesale") return { code: centralBankAccounts.wholesaleLine(request.owner), ref: p.wholesale(request.owner) };
  return undefined;
}

/** camt.053 for one of this participant's liabilities to an account holder, over a period. */
export async function accountStatement(
  rt: RuntimeContext,
  account: { code: string; ref: AccountRef },
  period: { from: Date; to: Date },
): Promise<Built> {
  const { books } = rt;
  const opening = (await books.balance(account.code, { asOf: period.from })).posted;
  const closing = (await books.balance(account.code, { asOf: period.to })).posted;
  const entries: AccountEntry[] = [];
  for (const movement of await books.movements(account.code, period)) {
    const uetr = movement.idempotencyKey.startsWith("instruction:") ? movement.idempotencyKey.slice("instruction:".length) : undefined;
    const row = uetr ? await getInstruction(books.database, uetr) : undefined;
    entries.push({
      ref: movement.idempotencyKey,
      amount: movement.amount,
      // The holder's view of a liability: what the bank owes it grows with a credit.
      side: movement.side,
      status: "BOOK",
      bookedAt: movement.postedAt,
      code: row ? CODES[row.flow.kind] : movement.idempotencyKey === "opening" ? "OPENING" : "OBSERVED",
      ...(uetr ? { uetr } : {}),
      ...(movement.ledgerBlock !== null ? { block: movement.ledgerBlock } : {}),
      info: movement.description,
    });
  }
  return camt053({ createdAt: new Date(), account: account.ref, from: period.from, to: period.to, opening, closing, entries });
}
