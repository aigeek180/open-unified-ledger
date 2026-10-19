import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertBalanced,
  assertValidInstruction,
  bondPostings,
  credit,
  debit,
  detokenizeDeposit,
  fundWholesale,
  interbankTransfer,
  money,
  redeemWholesale,
  tokenizeDeposit,
  UnbalancedEntryError,
} from "../src/index.ts";

const positive = fc.bigInt({ min: 1n, max: 10n ** 18n }).map((m) => money("CAD", m));

describe("posting templates", () => {
  it("every template produces a balanced entry", () => {
    fc.assert(
      fc.property(positive, (amount) => {
        for (const lines of [
          fundWholesale.bank(amount),
          fundWholesale.centralBank("bank-a", amount),
          redeemWholesale.bank(amount),
          redeemWholesale.centralBank("bank-a", amount),
          tokenizeDeposit("c1", amount),
          detokenizeDeposit("c1", amount),
          interbankTransfer.payerBank("c1", amount),
          interbankTransfer.payeeBank("c2", amount),
          interbankTransfer.centralBank("bank-a", "bank-b", amount),
        ]) {
          expect(() => assertBalanced(lines)).not.toThrow();
        }
      }),
    );
  });

  it("every bond template balances, whatever the price relative to face", () => {
    fc.assert(
      fc.property(positive, positive, positive, fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }), (face, consideration, coupon, residual) => {
        const issuerDebit = money("CAD", coupon.minor + residual);
        const entries = [
          bondPostings.buy("BOND", face, consideration),
          bondPostings.sell("BOND", face, consideration),
          bondPostings.agentIssue("issuer", consideration),
          bondPostings.receiveCoupon(coupon),
          bondPostings.redeem("BOND", face, coupon),
          bondPostings.redeem("BOND", face, money("CAD", 0n)),
        ];
        if (issuerDebit.minor > 0n) entries.push(bondPostings.agentPay("issuer", issuerDebit, coupon));
        for (const lines of entries) expect(() => assertBalanced(lines)).not.toThrow();
      }),
    );
  });

  it("rejects one-sided, non-positive and unbalanced entries", () => {
    const cad = (m: bigint) => money("CAD", m);
    expect(() => assertBalanced([debit("a", cad(1n))])).toThrow(UnbalancedEntryError);
    expect(() => assertBalanced([debit("a", cad(0n)), credit("b", cad(0n))])).toThrow(UnbalancedEntryError);
    expect(() => assertBalanced([debit("a", cad(2n)), credit("b", cad(1n))])).toThrow(UnbalancedEntryError);
    // Balanced in total minor units but not within each currency.
    expect(() =>
      assertBalanced([debit("a", cad(1n)), credit("b", money("USD", 1n))]),
    ).toThrow(UnbalancedEntryError);
  });
});

describe("instructions", () => {
  const id = "3f2b8c1e-9d4a-4b6f-8a2c-1e5d7f9b0c3a";

  it("accepts a valid three-leg interbank instruction", () => {
    expect(() =>
      assertValidInstruction({
        id,
        legs: [
          { kind: "burn", token: "dCAD-A", from: "c1", amount: 250000n },
          { kind: "transfer", token: "wCAD", from: "bank-a", to: "bank-b", amount: 250000n },
          { kind: "mint", token: "dCAD-B", to: "c2", amount: 250000n },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a non-UETR id, empty legs, zero amounts and self-transfers", () => {
    const leg = { kind: "mint", token: "wCAD", to: "bank-a", amount: 1n } as const;
    expect(() => assertValidInstruction({ id: "not-a-uetr", legs: [leg] })).toThrow();
    expect(() => assertValidInstruction({ id, legs: [] })).toThrow();
    expect(() => assertValidInstruction({ id, legs: [{ ...leg, amount: 0n }] })).toThrow();
    expect(() =>
      assertValidInstruction({
        id,
        legs: [{ kind: "transfer", token: "wCAD", from: "bank-a", to: "bank-a", amount: 1n }],
      }),
    ).toThrow();
  });
});
