# ca-interbank

Interbank payments in tokenized Canadian dollars between three fictional
banks, settled in tokenized wholesale CAD issued by a fictional central bank.

- **Shows**: funding wholesale tokens from reserves (SPEC.md §5.1), tokenizing
  a customer deposit (§5.2), and the atomic three-leg interbank payment
  (§5.3).
- **Follows**: the settlement model in the BIS Project Agorá report (May
  2026), on one ledger and in one currency. It also follows the first phase
  of the tokenized-deposit solution that Canada's six largest banks
  announced on 22 September 2026 they are exploring, which aims to move
  tokenized deposits across financial institutions. Sources:
  [docs/sources.md](../../docs/sources.md).
- **Participants**: Central Bank, Bank A, Bank B, Bank C, each running a
  validator.
