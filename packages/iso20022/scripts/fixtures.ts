/**
 * Example messages for every flow of the ca-interbank, ca-bond-dvp,
 * ca-us-pvp and ca-repo scenarios (SPEC.md §8, §13),
 * written to fixtures/ by `pnpm --filter @oul/iso20022 fixtures` and checked
 * by the tests: each must equal what the builders produce now and validate
 * against its official XSD. Every value is fixed (UETRs, times, blocks), and
 * addresses are the sandbox's deterministic ones, so the files are stable.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { customerAddress, participantAddress } from "@oul/chain";
import { money } from "@oul/domain";
import {
  type AccountRef,
  type BankRef,
  type Built,
  camt053,
  camt054,
  pacs002,
  pacs008,
  pacs009,
  type SecuritiesParty,
  type SecuritiesSettlement,
  sese023,
  sese025,
} from "../src/index.ts";

const cad = (major: string) => money("CAD", BigInt(major.replace(".", "")));
const usd = (major: string) => money("USD", BigInt(major.replace(".", "")));
const centralBank: BankRef = { id: "central-bank", name: "Central Bank" };
const bankA: BankRef = { id: "bank-a", name: "Bank A" };
const bankB: BankRef = { id: "bank-b", name: "Bank B" };
const bankC: BankRef = { id: "bank-c", name: "Bank C" };

const customer = (bank: BankRef, id: string, owner: string, kind: "deposit" | "tokenized"): AccountRef => ({
  id: kind === "deposit" ? `dda/${id}` : `tok/${id}`,
  owner,
  servicer: bank,
  currency: "CAD",
  ...(kind === "tokenized" ? { address: customerAddress(bank.id, id) } : {}),
});

const FUND = "3f2b8c1e-9d4a-4b6f-8a2c-1e5d7f9b0c3a";
const TOKENIZE = "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f";
const PAYMENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const REJECTED = "0f1e2d3c-4b5a-4968-a7b6-c5d4e3f2a1b0";
const at = (time: string) => new Date(`2026-11-02T${time}Z`);

const northwindDeposit = customer(bankA, "northwind-freight", "Northwind Freight", "deposit");
const northwindTokens = customer(bankA, "northwind-freight", "Northwind Freight", "tokenized");
const lakesideTokens = customer(bankB, "lakeside-steel", "Lakeside Steel", "tokenized");

const payment = {
  uetr: PAYMENT,
  createdAt: at("15:00:00"),
  settlementDate: at("15:00:04"),
  amount: cad("2500.00"),
  debtor: northwindTokens,
  creditor: lakesideTokens,
};

// ca-bond-dvp: the Issuer's 3.25% 2031 bond, Bank C its issuing and paying agent.
const BOND = { symbol: "BOND-ISSUER-2031", name: "Issuer 3.25% bond due 2 November 2031" };
const WCAD = { symbol: "wCAD", name: "Wholesale CAD" };
const ISSUE = "6d7e8f90-a1b2-4c3d-8e4f-5a6b7c8d9e0f";
const TRADE = "7e8f90a1-b2c3-4d4e-9f5a-6b7c8d9e0f1a";
const COUPON = "8f90a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";
const REDEMPTION = "90a1b2c3-d4e5-4f6a-9b7c-8d9e0f1a2b3c";
const holder = (bank: BankRef): SecuritiesParty => ({
  bank,
  account: `bond-holdings/${BOND.symbol}`,
  address: participantAddress(bank.id),
});
const agent: SecuritiesParty = { bank: bankC, account: `issuance/${BOND.symbol}`, address: participantAddress("bank-c") };

// §5.4 Bank C issues 60,000 units to Bank A at par; the issue to Bank B is the same shape.
const issue: SecuritiesSettlement = {
  uetr: ISSUE,
  createdAt: at("16:00:00"),
  tradeDate: at("16:00:00"),
  settlementDate: at("16:00:04"),
  type: "ISSU",
  security: BOND,
  units: 60000n,
  price: cad("1000.00"),
  amount: cad("60000000.00"),
  deliverer: agent,
  receiver: holder(bankA),
  cashToken: WCAD,
};

// §5.5 Bank A sells 7,000 units to Bank B at 1,001.50.
const trade: SecuritiesSettlement = {
  uetr: TRADE,
  createdAt: at("16:10:00"),
  tradeDate: at("16:10:00"),
  settlementDate: at("16:10:04"),
  type: "TRAD",
  security: BOND,
  units: 7000n,
  price: cad("1001.50"),
  amount: cad("7010500.00"),
  deliverer: holder(bankA),
  receiver: holder(bankB),
  cashToken: WCAD,
};

// §5.6 At maturity Bank A's 53,000 units are cancelled: face plus the final
// coupon (184 days at 3.25%: 868,328.77 on 53,000 units).
const redemption: SecuritiesSettlement = {
  uetr: REDEMPTION,
  createdAt: at("17:00:00"),
  tradeDate: at("17:00:00"),
  settlementDate: at("17:00:04"),
  type: "REDM",
  security: BOND,
  units: 53000n,
  amount: cad("53868328.77"),
  deliverer: holder(bankA),
  receiver: agent,
  cashToken: WCAD,
};

const wholesaleOf = (bank: BankRef): AccountRef => ({
  id: `wholesale-outstanding/${bank.id}`,
  owner: bank.name,
  servicer: centralBank,
  currency: "CAD",
  address: participantAddress(bank.id),
});
const issuerDeposit: AccountRef = { id: "dda/issuer", owner: "Issuer", servicer: bankC, currency: "CAD" };

// ca-us-pvp, §13: Northwind Freight at Bank A pays Mesa Solar at Bank B in USD from its CAD
// deposit, through Bank C, the dealer, at its quote of 0.7315 USD per CAD.
const CROSS_BORDER = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const mesaTokens: AccountRef = {
  id: "tok/mesa-solar",
  owner: "Mesa Solar",
  servicer: bankB,
  currency: "USD",
  address: customerAddress("bank-b", "mesa-solar"),
};
const crossBorder = {
  uetr: CROSS_BORDER,
  createdAt: at("18:00:00"),
  settlementDate: at("18:00:04"),
  amount: usd("1828.75"),
  instructed: { amount: cad("2500.00"), rate: "0.7315" },
  debtor: northwindTokens,
  creditor: mesaTokens,
};
const withAddress = (bank: BankRef) => ({ ...bank, address: participantAddress(bank.id) });

// ca-repo, §5.7–§5.10: Bank A lends $10,000,000 to Bank B for 14 days at 2.75%, 2% haircut, against the 2031 bond;
// collateral is safekept at the lender apart from the bonds it owns, and pledged out of the borrower's holdings.
const BOND_2029 = { symbol: "BOND-ISSUER-2029", name: "Issuer 2.80% bond due 1 June 2029" };
const REPO = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const MARGIN = "c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f";
const SUBSTITUTION = "d4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f80";
const CLOSE = "e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8091";
const MANUFACTURED = "f6a7b8c9-d0e1-4f2a-9b3c-5d6e7f8091a2";
const pledgedBy = (bond: { symbol: string }): SecuritiesParty => ({ bank: bankB, account: `bond-holdings/${bond.symbol}`, address: participantAddress("bank-b") });
const heldBy = (bond: { symbol: string }): SecuritiesParty => ({ bank: bankA, account: `collateral/${bond.symbol}`, address: participantAddress("bank-a") });
const repoLeg = (types: "repo" | "collateral", extra: { repurchase?: "TOPU" | "WTHD"; returnLeg?: boolean } = {}) => ({
  repo: REPO,
  // The borrower's side is the repo, the lender's the reverse repo; for collateral alone, out and in.
  types: types === "repo" ? ({ DELI: "REPU", RECE: "RVPO" } as const) : ({ DELI: "COLO", RECE: "COLI" } as const),
  ...extra,
});
const repoOpen: SecuritiesSettlement = {
  uetr: REPO,
  createdAt: at("19:00:00"),
  tradeDate: at("19:00:00"),
  settlementDate: at("19:00:04"),
  type: "REPU",
  security: BOND,
  units: 10300n,
  price: cad("1000.00"),
  amount: cad("10000000.00"),
  deliverer: pledgedBy(BOND),
  receiver: heldBy(BOND),
  cashToken: WCAD,
  repo: repoLeg("repo"),
};
const repoMargin: SecuritiesSettlement = {
  uetr: MARGIN,
  createdAt: at("19:10:00"),
  tradeDate: at("19:10:00"),
  settlementDate: at("19:10:04"),
  type: "COLO",
  security: BOND,
  units: 13n,
  deliverer: pledgedBy(BOND),
  receiver: heldBy(BOND),
  cashToken: WCAD,
  repo: repoLeg("collateral", { repurchase: "TOPU" }),
};
const substitutionBase = { uetr: SUBSTITUTION, createdAt: at("19:20:00"), tradeDate: at("19:20:00"), settlementDate: at("19:20:04"), cashToken: WCAD };
// The lender gives back the 2031 bond: the lender is the deliverer of that movement, the borrower receives.
const substitutionOut: SecuritiesSettlement = {
  ...substitutionBase,
  type: "COLI",
  security: BOND,
  units: 10313n,
  deliverer: heldBy(BOND),
  receiver: pledgedBy(BOND),
  repo: { repo: REPO, types: { DELI: "COLI", RECE: "COLO" } },
  leg: "out",
};
const substitutionIn: SecuritiesSettlement = {
  ...substitutionBase,
  type: "COLO",
  security: BOND_2029,
  units: 10462n,
  deliverer: pledgedBy(BOND_2029),
  receiver: heldBy(BOND_2029),
  repo: repoLeg("collateral"),
  leg: "in",
};
const repoClose: SecuritiesSettlement = {
  uetr: CLOSE,
  createdAt: at("19:30:00"),
  tradeDate: at("19:30:00"),
  settlementDate: at("19:30:04"),
  type: "RVPO",
  security: BOND_2029,
  units: 10462n,
  amount: cad("10010547.95"),
  deliverer: heldBy(BOND_2029),
  receiver: pledgedBy(BOND_2029),
  cashToken: WCAD,
  repo: { repo: REPO, types: { DELI: "RVPO", RECE: "REPU" }, returnLeg: true },
};

/** Every fixture, keyed by its path under fixtures/. */
export function buildFixtures(): Record<string, Built> {
  return {
    // §5.4 Issue: the agent instructs delivery, the buyer's affirmation is its receive instruction.
    "5.4-bond-issue/sese.023-agent-deliver.xml": sese023(issue, "DELI"),
    "5.4-bond-issue/sese.023-buyer-receive.xml": sese023(issue, "RECE"),
    "5.4-bond-issue/sese.025-agent.xml": sese025(issue, "DELI", { at: at("16:00:04"), block: 48n }),
    "5.4-bond-issue/sese.025-buyer.xml": sese025(issue, "RECE", { at: at("16:00:04"), block: 48n }),

    // §5.5 Trade: matched by the common reference, settled delivery versus payment.
    "5.5-bond-trade/sese.023-seller-deliver.xml": sese023(trade, "DELI"),
    "5.5-bond-trade/sese.023-buyer-receive.xml": sese023(trade, "RECE"),
    "5.5-bond-trade/sese.025-seller.xml": sese025(trade, "DELI", { at: at("16:10:04"), block: 49n }),
    "5.5-bond-trade/sese.025-buyer.xml": sese025(trade, "RECE", { at: at("16:10:04"), block: 49n }),

    // §5.6 The first coupon: Bank A's 53,000 units at 181 days, and the issuer's debit on all 100,000.
    "5.6-bond-coupon/camt.054-holder-credit.xml": camt054({
      createdAt: at("16:20:06"),
      account: wholesaleOf(bankA),
      entries: [{ ref: `instruction:${COUPON}`, amount: cad("854171.23"), side: "credit", status: "BOOK", bookedAt: at("16:20:04"), code: "COUPON", uetr: COUPON, block: 50n, info: `${BOND.symbol} coupon 1 on 53000 units` }],
    }),
    "5.6-bond-coupon/camt.054-issuer-debit.xml": camt054({
      createdAt: at("16:20:06"),
      account: issuerDeposit,
      entries: [{ ref: `instruction:${COUPON}`, amount: cad("1611643.84"), side: "debit", status: "BOOK", bookedAt: at("16:20:04"), code: "COUPON", uetr: COUPON, block: 50n, info: `${BOND.symbol} coupon 1 on 100000 units` }],
    }),

    // §5.6 Redemption: the holder's units cancelled against face and the final coupon.
    "5.6-bond-redemption/sese.025-holder.xml": sese025(redemption, "DELI", { at: at("17:00:04"), block: 61n }),
    "5.6-bond-redemption/camt.054-holder-credit.xml": camt054({
      createdAt: at("17:00:06"),
      account: wholesaleOf(bankA),
      entries: [{ ref: `instruction:${REDEMPTION}`, amount: cad("53868328.77"), side: "credit", status: "BOOK", bookedAt: at("17:00:04"), code: "REDEMPTION", uetr: REDEMPTION, block: 61n, info: `${BOND.symbol} redemption of 53000 units with coupon 10` }],
    }),
    "5.6-bond-redemption/camt.054-issuer-debit.xml": camt054({
      createdAt: at("17:00:06"),
      account: issuerDeposit,
      entries: [{ ref: `instruction:${REDEMPTION}`, amount: cad("101638356.16"), side: "debit", status: "BOOK", bookedAt: at("17:00:04"), code: "REDEMPTION", uetr: REDEMPTION, block: 61n, info: `${BOND.symbol} principal and coupon 10 on 100000 units` }],
    }),

    // §5.7 Repo open: the borrower delivers collateral against the purchase price, the lender receives it.
    "5.7-repo-open/sese.023-borrower-deliver.xml": sese023(repoOpen, "DELI"),
    "5.7-repo-open/sese.023-lender-receive.xml": sese023(repoOpen, "RECE"),
    "5.7-repo-open/sese.025-borrower.xml": sese025(repoOpen, "DELI", { at: at("19:00:04"), block: 80n }),
    "5.7-repo-open/sese.025-lender.xml": sese025(repoOpen, "RECE", { at: at("19:00:04"), block: 80n }),

    // §5.8 Margin: 13 more units of collateral, free of payment, on the lender's call.
    "5.8-repo-margin/sese.023-borrower-deliver.xml": sese023(repoMargin, "DELI"),
    "5.8-repo-margin/sese.023-lender-receive.xml": sese023(repoMargin, "RECE"),
    "5.8-repo-margin/sese.025-lender.xml": sese025(repoMargin, "RECE", { at: at("19:10:04"), block: 81n }),

    // §5.9 Substitution: the 2031 bond back to the borrower and the 2029 bond to the lender, in one instruction.
    "5.9-repo-substitution/sese.023-lender-deliver-out.xml": sese023(substitutionOut, "DELI"),
    "5.9-repo-substitution/sese.023-borrower-deliver-in.xml": sese023(substitutionIn, "DELI"),
    "5.9-repo-substitution/sese.025-borrower-receive-out.xml": sese025(substitutionOut, "RECE", { at: at("19:20:04"), block: 82n }),
    "5.9-repo-substitution/sese.025-lender-receive-in.xml": sese025(substitutionIn, "RECE", { at: at("19:20:04"), block: 82n }),

    // §5.10 Close: every collateral unit back against the purchase price plus 14 days' interest, the return leg.
    "5.10-repo-close/sese.023-lender-deliver.xml": sese023(repoClose, "DELI"),
    "5.10-repo-close/sese.023-borrower-receive.xml": sese023(repoClose, "RECE"),
    "5.10-repo-close/sese.025-borrower.xml": sese025(repoClose, "RECE", { at: at("19:30:04"), block: 84n }),

    // §5.10 Manufactured payment: the coupon the lender received on collateral, passed to the borrower.
    "5.10-repo-manufactured/pacs.009.xml": pacs009({
      uetr: MANUFACTURED,
      createdAt: at("19:25:00"),
      settlementDate: at("19:25:04"),
      amount: cad("167901.05"),
      debtorBank: withAddress(bankA),
      creditorBank: withAddress(bankB),
    }),
    "5.10-repo-manufactured/camt.054-borrower-credit.xml": camt054({
      createdAt: at("19:25:06"),
      account: wholesaleOf(bankB),
      entries: [{ ref: `instruction:${MANUFACTURED}`, amount: cad("167901.05"), side: "credit", status: "BOOK", bookedAt: at("19:25:04"), code: "MANUFACTURED", uetr: MANUFACTURED, block: 83n, info: `${BOND.symbol} coupon 1 on 10313 units held as repo collateral` }],
    }),

    // §5.1 Bank A moves reserves into wholesale tokens: the central bank notifies both of Bank A's accounts.
    "5.1-fund/camt.054-rtgs-debit.xml": camt054({
      createdAt: at("14:00:06"),
      account: { id: "settlement-accounts/bank-a", owner: "Bank A", servicer: centralBank, currency: "CAD" },
      entries: [{ ref: `instruction:${FUND}`, amount: cad("10000000.00"), side: "debit", status: "BOOK", bookedAt: at("14:00:04"), code: "FUND", uetr: FUND, block: 28n }],
    }),
    "5.1-fund/camt.054-wholesale-credit.xml": camt054({
      createdAt: at("14:00:06"),
      account: {
        id: "wholesale-outstanding/bank-a",
        owner: "Bank A",
        servicer: centralBank,
        currency: "CAD",
        address: participantAddress("bank-a"),
      },
      entries: [{ ref: `instruction:${FUND}`, amount: cad("10000000.00"), side: "credit", status: "BOOK", bookedAt: at("14:00:04"), code: "FUND", uetr: FUND, block: 28n }],
    }),

    // §5.2 Northwind Freight tokenizes part of its deposit at Bank A.
    "5.2-tokenize/camt.054-deposit-debit.xml": camt054({
      createdAt: at("14:30:04"),
      account: northwindDeposit,
      entries: [{ ref: `instruction:${TOKENIZE}`, amount: cad("5000.00"), side: "debit", status: "BOOK", bookedAt: at("14:30:02"), code: "TOKENIZE", uetr: TOKENIZE, block: 30n }],
    }),
    "5.2-tokenize/camt.054-tokenized-credit.xml": camt054({
      createdAt: at("14:30:04"),
      account: northwindTokens,
      entries: [{ ref: `instruction:${TOKENIZE}`, amount: cad("5000.00"), side: "credit", status: "BOOK", bookedAt: at("14:30:02"), code: "TOKENIZE", uetr: TOKENIZE, block: 30n }],
    }),

    // §5.3 Northwind Freight at Bank A pays Lakeside Steel at Bank B.
    "5.3-interbank/pacs.008.xml": pacs008(payment),
    "5.3-interbank/pacs.009-cover.xml": pacs009({
      uetr: PAYMENT,
      createdAt: payment.createdAt,
      settlementDate: payment.settlementDate,
      amount: payment.amount,
      debtorBank: { ...bankA, address: participantAddress("bank-a") },
      creditorBank: { ...bankB, address: participantAddress("bank-b") },
      underlying: payment,
    }),
    "5.3-interbank/pacs.002-accepted.xml": pacs002({
      uetr: PAYMENT,
      createdAt: at("15:00:06"),
      original: { msgId: pacs008(payment).msgId, version: "pacs.008.001.08" },
      status: "ACSC",
      settledBlock: 31n,
      from: bankB,
      to: bankA,
    }),
    "5.3-interbank/camt.054-payer-debit.xml": camt054({
      createdAt: at("15:00:06"),
      account: northwindTokens,
      entries: [{ ref: `instruction:${PAYMENT}`, amount: cad("2500.00"), side: "debit", status: "BOOK", bookedAt: at("15:00:04"), code: "INTERBANK", uetr: PAYMENT, block: 31n, info: "To Lakeside Steel at Bank B" }],
    }),
    "5.3-interbank/camt.054-payee-credit.xml": camt054({
      createdAt: at("15:00:06"),
      account: lakesideTokens,
      entries: [{ ref: `instruction:${PAYMENT}`, amount: cad("2500.00"), side: "credit", status: "BOOK", bookedAt: at("15:00:04"), code: "INTERBANK", uetr: PAYMENT, block: 31n, info: "From Northwind Freight at Bank A" }],
    }),

    // An instruction the engine refused: the payer's tokens were frozen.
    "5.3-interbank-rejected/pacs.002-rejected.xml": pacs002({
      uetr: REJECTED,
      createdAt: at("15:30:02"),
      original: { msgId: pacs008({ ...payment, uetr: REJECTED }).msgId, version: "pacs.008.001.08" },
      status: "RJCT",
      reason: "ERC20InsufficientUnfrozenBalance",
      from: bankA,
      to: bankA,
    }),

    // §13 A payment across currencies: one customer payment, a cover for each wholesale leg, one outcome.
    "15-pvp/pacs.008.xml": pacs008(crossBorder),
    "15-pvp/pacs.009-cover-CAD.xml": pacs009({
      uetr: CROSS_BORDER,
      createdAt: crossBorder.createdAt,
      settlementDate: crossBorder.settlementDate,
      amount: cad("2500.00"),
      debtorBank: withAddress(bankA),
      creditorBank: withAddress(bankC),
      underlying: crossBorder,
      leg: "CAD",
    }),
    "15-pvp/pacs.009-cover-USD.xml": pacs009({
      uetr: CROSS_BORDER,
      createdAt: crossBorder.createdAt,
      settlementDate: crossBorder.settlementDate,
      amount: usd("1828.75"),
      debtorBank: withAddress(bankC),
      creditorBank: withAddress(bankB),
      underlying: crossBorder,
      leg: "USD",
    }),
    "15-pvp/pacs.002-accepted.xml": pacs002({
      uetr: CROSS_BORDER,
      createdAt: at("18:00:06"),
      original: { msgId: pacs008(crossBorder).msgId, version: "pacs.008.001.08" },
      status: "ACSC",
      settledBlock: 72n,
      from: bankB,
      to: bankA,
    }),
    "15-pvp/camt.054-payer-debit.xml": camt054({
      createdAt: at("18:00:06"),
      account: northwindTokens,
      entries: [{ ref: `instruction:${CROSS_BORDER}`, amount: cad("2500.00"), side: "debit", status: "BOOK", bookedAt: at("18:00:04"), code: "PVP", uetr: CROSS_BORDER, block: 72n, info: "To Mesa Solar at Bank B, USD 1828.75 at 0.7315" }],
    }),
    "15-pvp/camt.054-payee-credit.xml": camt054({
      createdAt: at("18:00:06"),
      account: mesaTokens,
      entries: [{ ref: `instruction:${CROSS_BORDER}`, amount: usd("1828.75"), side: "credit", status: "BOOK", bookedAt: at("18:00:04"), code: "PVP", uetr: CROSS_BORDER, block: 72n, info: "From Northwind Freight at Bank A, CAD 2500.00 at 0.7315" }],
    }),

    // Northwind Freight's tokenized account over the day.
    "statement/camt.053-tokenized.xml": camt053({
      createdAt: at("23:59:59"),
      account: northwindTokens,
      from: at("00:00:00"),
      to: at("23:59:59"),
      opening: cad("0.00"),
      closing: cad("2500.00"),
      entries: [
        { ref: `instruction:${TOKENIZE}`, amount: cad("5000.00"), side: "credit", status: "BOOK", bookedAt: at("14:30:02"), code: "TOKENIZE", uetr: TOKENIZE, block: 30n },
        { ref: `instruction:${PAYMENT}`, amount: cad("2500.00"), side: "debit", status: "BOOK", bookedAt: at("15:00:04"), code: "INTERBANK", uetr: PAYMENT, block: 31n },
      ],
    }),
  };
}

export const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");

if (import.meta.main) {
  for (const [file, built] of Object.entries(buildFixtures())) {
    const target = path.join(FIXTURES_DIR, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, built.xml);
    console.log(`${built.version.padEnd(16)} ${path.relative(path.resolve(FIXTURES_DIR, ".."), target)}`);
  }
}
