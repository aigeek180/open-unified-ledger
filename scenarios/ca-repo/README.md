# ca-repo

Bank A lends tokenized wholesale CAD to Bank B against tokenized bonds, as a
repurchase agreement: opened, margined, its collateral substituted, and
closed, each step one atomic instruction on the shared ledger.

- **Shows**: repo open (SPEC.md §5.7), margin (§5.8), substitution (§5.9)
  and close (§5.10), with the manufactured payment of a coupon paid on
  collateral; invariant 14 (repo collateral).
- **The bonds**: two fictional bonds issued through Bank C as issuing and
  paying agent, both accepted as collateral: a 3.25% semiannual bond due
  2 November 2031, as in `ca-bond-dvp`, and a 2.80% semiannual bond due
  1 June 2029. Bank B buys both at issue; Bank A some of the first.
- **The repo**: each side affirms the same terms under one UETR, as for a
  trade: collateral bond and units, purchase price, repo rate, start and end
  dates, and haircut. Interest is the purchase price times the rate times the
  days held over 365 (Actual/365 Fixed, the money-market convention in
  Canada), rounded once, half-even. Collateral counts at its agreed mark less
  the haircut, and must cover the cash lent plus interest accrued.
- **Follows**: the pattern of a classic repo, a sale and repurchase under
  which title to the collateral passes to the lender while the economics,
  coupons included, stay with the borrower. Here title moves on chain and
  each side's books keep the economics. Where this implementation sets a
  rule of its own (which side submits each flow, how a margin call is
  computed and when it is overdue, when a manufactured payment is due),
  `docs/design.md` §3.25 says so. The repo's terms are fictional.
