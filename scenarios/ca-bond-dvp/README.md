# ca-bond-dvp

A fictional issuer's 100,000,000 CAD bond, issued through Bank C as issuing
and paying agent, bought by Bank A and Bank B, traded between them, and paid
and redeemed, all settled against tokenized wholesale CAD.

- **Shows**: bond issuance (SPEC.md §5.4), secondary delivery versus payment
  (§5.5), coupons and redemption (§5.6).
- **Follows**: the Bank of Canada's Project Samara (March 2026), in which EDC
  issued a 100 million CAD bond on a distributed ledger, settled in wholesale
  central bank deposits issued by the Bank of Canada. Less is public about
  Samara than about Agorá; where its design is not described, this scenario
  uses standard DvP practice and says so in `docs/design.md`.
- **The bond**: 3.25% semiannual, Actual/365 Fixed, 1,000 CAD face per unit,
  issued 2 November 2026, maturing 2 November 2031. That day is a Sunday, so
  the final payment is made on the following business day, 3 November; every
  payment date rolls forward the same way. Because the coupons follow from
  Actual/365 Fixed, they vary slightly by period, unlike Government of Canada
  bonds, which pay half the annual coupon each time (`docs/design.md` §3.12).
- **Custody** (SPEC.md §15): Bank A holds part of the bond for two clients,
  Alder Pension Plan and Birchline Insurance, at an omnibus wallet, and
  records their positions in its own books. Each client's identity carries
  Bank A's KYC claim. The bond itself is an ERC-3643 token, and every bank's
  identity carries the Central Bank's KYC claim.
