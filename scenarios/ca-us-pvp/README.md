# ca-us-pvp

Cross-border payments between Canadian and US dollars on one shared ledger,
settled payment versus payment (SPEC.md §13).

Two fictional central banks share the ledger, each issuing tokenized
reserves in its own currency:

- **CAD Central Bank** issues `wCAD` and operates the participant registry,
  through which it admitted the USD Central Bank and every bank.
- **USD Central Bank** issues and lists `wUSD`, and alone decides which banks
  hold reserves in it.

Three fictional banks:

- **Bank A** holds CAD reserves and issues `dCAD-A`.
- **Bank B** holds USD reserves and issues `dUSD-B`.
- **Bank C**, the dealer, holds reserves in both and issues `dCAD-C`. Its
  books are in CAD, with an FX position in each currency.

The payment it is built for: a Bank A customer pays a Bank B customer in USD
from a CAD deposit, in one instruction of four legs. The payer's `dCAD-A` is
burned, `wCAD` moves from Bank A to Bank C, `wUSD` moves from Bank C to
Bank B, and the payee's `dUSD-B` is minted. Neither currency moves without
the other. The payment settles at a quote Bank C signed for Bank A, priced
from the fixed rates in `scenario.yaml` (`fx`) and good for two minutes of
ledger time.

It follows the cross-border scope of the BIS Project Agorá report (May
2026): several central banks on one platform, and payments between
currencies settled atomically. All participants are fictional.
