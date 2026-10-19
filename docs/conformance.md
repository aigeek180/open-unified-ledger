# Conformance kit

The conformance kit, `packages/conformance` (SPEC.md §14), packages the
invariants of SPEC.md §6 and the faults of the simulation harness (§9) as
checks any settlement engine can run against itself. An engine implements one
adapter. The kit supplies a scenario, asks for flows, stages faults, reads
back what the ledger and the books say, and judges the run against nine
checks. It reports each check as passed, failed or skipped, and for a failed
run, the seed and the smallest sequence of steps it found that still fails.

The checks see only what the adapter exposes, so each one below states what
it proves, what the adapter must expose for it, and what it cannot see.

## The adapter

An engine under test implements `EngineAdapter`
([adapter.ts](../packages/conformance/src/adapter.ts)):

| Member | Does |
| --- | --- |
| `capabilities` | the flows it can run, the faults it can stage, whether it keeps books the kit can read |
| `reset(scenario)` | deploys afresh a scenario the kit supplies and returns its directory (the ledgers, each participant's and customer's address, every token with its ledger, issuer and currency, and the last block of setup on each ledger) |
| `submit(flow)` | starts a flow under the id the kit gives it and waits for its outcome: settled, or refused with the reason, and across currencies, the dealer's quote |
| `head(ledger)` | the latest block |
| `observe(ledger, block)` | what the ledger says at a block (below) |
| `books(participant, block)` | optional: the participant's books as of a block (below) |
| `fault(step)` | optional: stages a fault it declares and reports what it did |
| `quiesce()` | waits until every participant has caught up with every ledger |
| `close()` | releases what `reset` started |

**An observation** covers one block. It lists every transaction that moved a
token, with the instruction id it settled (or none) and the participants
whose approval it carried and the engine could verify, and each movement as
an ERC-20 transfer reports it (a mint has no sender, a burn no receiver).
After the block, it gives every token's supply and its balance at every
address the directory names or that has received it, and for each of those
holders, whether the token's issuer has admitted it and how much of its
balance is frozen. Admission is what the issuer records (a deposit token's
allowlist, a wholesale token's reserve accounts, a bond's ERC-3643 identity
registry), read apart from whatever the token enforces, so that a token
enforcing the wrong rule shows.

**Books** are one participant's, as of one block: the value its books give
each on-ledger balance it mirrors (a bank: its wholesale reserves in each
currency, each customer's tokenized deposit, its units of each bond; a
central bank: each bank's wholesale line), the liability it records for each
token it issues, a bank's total deposit liabilities in its own currency, and
the imbalance of all its posted entries in each currency. A bank party to
repos also gives the collateral its record shows for each repo open at the
block, as lender or borrower. A bank's units of a bond at its own address
are its holding plus collateral received less collateral pledged.

The kit asks for books once the run is over and every participant has
caught up, at the last block of setup and at every block where a token
moved, on the first ledger.

## The sandbox's own engine

`SandboxAdapter` ([sandbox/adapter.ts](../packages/conformance/src/sandbox/adapter.ts))
runs the kit against this repository's engine. The real contracts are
deployed afresh for every run, on a fresh Anvil or on the running network.
Every central bank and bank runs the real participant runtime, with its own
books in its own Postgres schema, inside the kit's process and calling the
others directly, as the runtime's tests run them. The services wrap the same
runtime in HTTP.

- **Flows** go to the participant that starts them, as an operator's request
  would. A payment across currencies asks the dealer for a quote first, and
  each buyer affirms an issue or trade first. One of the participant's
  operators starts each flow and, where its policy holds it, others approve
  it (SPEC.md §15) before anything is signed, at the participant and, for
  funding, at the central bank. The kit judges the engine with its policies
  on. The adapter then drives every participant until the submitter's
  instruction has settled or failed and every participant has processed its
  block.
- **Observations** come from a node alone
  ([sandbox/observer.ts](../packages/conformance/src/sandbox/observer.ts)):
  each transaction's `Transfer` events, its `InstructionSettled` id, and its
  approvers, which are the participant that sent it and each co-signer whose
  signature the adapter itself recovers over the EIP-712 digest of what was
  settled. Holder status is read from the issuers' records: a deposit
  token's allowlist (`getRestriction`), a wholesale token's reserve accounts
  for active banks, and whether the holder's identity verifies in a bond's
  identity registry.
- **Books** come from each participant's ledger as of the block
  (`trialBalanceAtBlock`): its mirrored accounts, the totals under its
  wholesale lines or tokenized deposits, and its customer and tokenized
  deposits together. A custodian (SPEC.md §15) also reports what its books
  say its omnibus wallet holds of each bond, which the books-equal-ledger
  check compares with the chain like any other holding.
- **Faults**: a participant's runtime closed while flows run among the
  others, then reopened from its schema; the same payment requested three
  times at once, then the settled instruction sent again with its
  approvals; an instruction sent with the payee's bank's signature over
  other legs, and one past its deadline; one sent with no co-signature; the
  payer's bank freezing its customer's whole balance with `setFrozenTokens`;
  the payee's bank resetting its customer on the allowlist. The engine
  refuses each with its own reason (`AlreadySettled`, `InvalidApproval`,
  `InstructionExpired`, `MissingApproval`, `ERC20InsufficientUnfrozenBalance`,
  `ERC20UserRestricted`), and the sandbox's test checks that it does.

It passes every check, scripted with every fault and on seeded runs, in one
currency (`ca-interbank`), across two at the rounding edges (`ca-us-pvp`),
and through a bond's whole life to redemption (`ca-bond-dvp`)
([sandbox.test.ts](../packages/conformance/test/sandbox.test.ts)).

## Interop mode under the kit

`InteropAdapter` ([interop/adapter.ts](../packages/conformance/src/interop/adapter.ts))
runs one of interop mode's coordinators (SPEC.md §7) as the engine under
test. The unified coordinator, HTLC or the notary's two-phase commit moves
the scenario's interop payment across the shared ledger and a second one,
each run on two ledgers deployed afresh. The route is the one interop mode
moves (the payer's bank to the payee's, through the dealer across
currencies), the faults are §7's, and setup funds the payer and the dealer.
The kit observes both ledgers. What a claim or a commit moved is the
instruction's part on that ledger, approved by whoever locked it and by each
valid co-signature on the lock; the unified coordinator settles through the
engine. Interop runs measure the ledgers, not the books, so the checks that
need books are skipped.

Atomicity fails exactly where §7 says the coordinator leaves the ledgers
disagreeing, and nowhere else: HTLC when the counterparty is offline past
ledger 1's timeout or its claim lands late, the notary when it crashes
between its commits or its second commit lands late, and the unified
coordinator never. Every other check passes, FX consistency included across
currencies, where each ledger delivers one currency
([interop.test.ts](../packages/conformance/test/interop.test.ts)).

## Running it

On the running network, each run on a fresh deployment:

```bash
pnpm network:generate ca-interbank
pnpm network:up
pnpm conformance ca-interbank --seeds 1..3 --steps 20 --faults 0.25
```

`--anvil` runs each on a fresh local Anvil instead, with no network needed.
`--no-script` skips the scripted run, and `--shrink <runs>` sets the
shrinking budget (0 turns it off). It prints every check of every run and,
for a failing run, the smallest sequence found and the command that
reproduces it. The report is kept in `sim/runs/conformance/`, and the
command exits 1 if any check failed.

Interop mode's coordinators, on the shared network and the second ledger
beside it (or `--anvil`):

```bash
pnpm interop:generate ca-us-pvp
pnpm interop:up
pnpm conformance ca-us-pvp --coordinator all
```

It ends with each coordinator's verdict, and exits 0 only if atomicity
failed exactly where §7 says and nothing else failed.

## Flows

The kit's own vocabulary ([flows.ts](../packages/conformance/src/flows.ts)),
in integer minor units: fund and redeem wholesale (§5.1); tokenize and
detokenize (§5.2); pay a customer of another bank in the same currency
(§5.3) or, through the dealer, in another (§13); for an engine with bonds,
issue, trade and the next scheduled payment (§5.4 to §5.6); and for an
engine with repo, open a repo, margin it at marks on a date, substitute one
bond for another, and close it (§5.7 to §5.10).

For each flow the kit states the legs it must move, and the atomicity check
holds every settlement to them. A payment burns the payer's deposit, moves
wholesale between the banks and mints the payee's. Across currencies the
target amount is whatever the dealer set, the same on both of its legs, and
FX consistency judges it. In a repo the kit states what the terms fix (an
opening's units and cash, a substitution's outgoing units, a close's
collateral) and leaves to the engine what follows from marks and interest (a
margin's units, a substitution's incoming units, a close's repayment), which
repo collateral judges.

## Faults

An adapter declares the faults it can stage. A run skips the rest and notes
that it did.

| Fault | What the adapter stages |
| --- | --- |
| `participant-down` | a participant down while flows among the others settle; it comes back and catches up |
| `duplicate-submission` | the same payment asked for three times at once, then sent to the engine again once it settled |
| `stale-approval` | a payment sent to the engine with a co-signature over other legs, and one past its deadline |
| `missing-approval` | a payment sent to the engine without the payee's bank's co-signature |
| `frozen-payer` | the payer's bank freezes its customer's tokens on the ledger, behind its own books, before the payment |
| `ineligible-payee` | the payee's bank takes its customer off the deposit token's allowlist, behind its own books, before the payment |
| `coordinator-crash`, `message-loss`, `participant-offline`, `late-commit` | interop mode's faults (SPEC.md §7), while a coordinator moves a payment across two ledgers |

A fault reports the flows it ran, with their outcomes, like any flow, and
the attempts it sent straight to the engine, around the participants. The
kit judges whatever the engine did with each. A real engine refuses every
attempt; a broken one may settle it, and the checks then see that.

## Runs

- **Scripted** ([script.ts](../packages/conformance/src/script.ts)): every
  flow the engine supports, at least once, in every currency of the scenario
  and between every pair of banks that can pay each other (or along the
  routes an engine declares, when it can make only some payments). Then,
  where the kit funded the payers itself, a payment for more than the payer
  holds, which must be refused. Then each declared fault once. Each fault's
  payment takes at most an eighth of what can be spent and is counted as
  spent, so every fault has funds whatever became of the one before.
  Payments across currencies use amounts whose exact conversion lands within
  a twentieth of a minor unit of the half (just below, exactly on and just
  above it, with the whole part odd and even), so that rounding by any rule
  but once, half-even, shows.
- **Seeded** ([generator.ts](../packages/conformance/src/generator.ts)): a
  sequence drawn from a seed, one step at a time, from the kit's own model of
  every balance, so that every flow can settle except about one payment in
  twenty, which asks for more than the payer holds. The faults the adapter
  declares are mixed in at a set rate. With a dealer, half the payments
  cross currencies, and half of those are moved to the nearest amount that
  lands near half a minor unit. When no payment can settle yet, the step
  proposed is the one it waits for (the payer's bank funding, the payer
  tokenizing, the dealer funding the currency it delivers). An engine that
  funds its payers in its own setup says what it gave them (`funded` in the
  directory), and the model starts from that. The model reads nothing from
  the engine, so the same seed proposes the same steps to any engine that
  settles the same flows, ids included.
- **Shrinking**: a failing run is shrunk on fresh deployments. First comes
  the shortest failing prefix, by bisection, then delta debugging over what
  is left, removing ever smaller chunks of steps while the same check still
  fails, within a budget of fresh runs. The report gives the smallest
  sequence found and whether the budget ran out first.

## The checks

[checks.ts](../packages/conformance/src/checks.ts).

### Atomicity (invariant 5)

- **Proves.** Every instruction moved all of its flow's legs or none. On one
  ledger, every transaction under an id carries the same legs, so legs
  settled in separate transactions fail. Across ledgers, each ledger's part
  settles whole and the parts together are every leg; a run that ends with
  one ledger's part settled and another's not fails, and the report gives
  the widest time between parts. No transaction moves a token outside an
  instruction or moves anything its flow does not, no id settles that the
  kit never asked for, and what the engine reported (settled, refused) is
  what the ledgers show.
- **Needs.** Observations, with the id each transaction settled.
- **Cannot see.** An instruction the engine holds and has not settled, such
  as a pending lock or a queued leg. It sees settlement only once a token
  moves.

### Exactly once (invariant 6)

- **Proves.** No movement under an instruction id happens twice, however
  often the id was submitted, by the kit or by a fault.
- **Needs.** Observations; for the strong case, the `duplicate-submission`
  fault, which sends a settled instruction to the engine again.
- **Cannot see.** An engine that settles a retry under a new id. The kit
  sees a second id, which atomicity reports as one it never asked for.

### Authority (invariant 9)

- **Proves.** No movement settled without the approval of the participant
  whose liability it creates (a mint: the token's issuer) or whose account it
  debits (a burn or transfer out: the holder, or for a customer, its bank).
- **Needs.** Observations, with the approvers of each transaction; for the
  strong case, the `missing-approval` and `stale-approval` faults, which send
  an instruction whose approvals do not cover it.
- **Cannot see.** Whether an approval was genuinely given. It relies on the
  adapter's list of approvers, which the kit cannot verify without the
  engine's own encoding. The sandbox's adapter checks every signature itself
  before it reports a signer.

### Eligibility (invariant 7)

- **Proves.** No movement landed on an address the token's issuer has not
  admitted, and no instruction took frozen tokens.
- **Needs.** Observations with holder status; for the strong case, the
  `ineligible-payee` and `frozen-payer` faults.
- **Cannot see.** Admission the issuer's own records get wrong. A freeze and
  a movement in the same block are judged by the smaller of the frozen
  amounts before and after it. Forced transfers, outside any instruction,
  are atomicity's to report.

### Supply equals liability (invariants 2, 3)

- **Proves.** Each cash token's total supply equals the liability its
  issuer's books record for it, at every block where tokens moved: wholesale
  at its central bank, each deposit token at its bank.
- **Needs.** Books.
- **Cannot see.** Bonds. In this model an issuer keeps no books, and its
  agent books the issuer's deposit, not the units outstanding.

### Liability conservation (invariant 4)

- **Proves.** A bank's deposit liabilities, ordinary and tokenized together,
  change between any two blocks by exactly the payments to and from its
  customers and, at a bond's agent, the movements on the issuer's account
  there (credited with an issue's proceeds, debited for each coupon and the
  redemption, as the kit computes them from the bond's terms). Tokenizing
  and detokenizing never change them.
- **Needs.** Books with a deposit total.
- **Cannot see.** Spans where the bank's books disagree with the ledger.
  The books-equal-ledger check has failed there, and judging conservation
  on books already wrong would only repeat it.

### Books equal the ledger (invariants 1, 2, 3, 10)

- **Proves.** Each participant's books balance in each currency and mirror
  every on-ledger balance it holds or owes, equal to the ledger at every
  block where tokens moved: a bank's reserves and its customers' tokenized
  deposits, a central bank's line for each bank, a bank's bond units. Every
  mirror the kit expects must be reported.
- **Needs.** Books.
- **Cannot see.** An unbalanced entry offset by another, since it sees each
  currency's total over all posted entries. That every entry balances is the
  books' own rule, which the sandbox's ledger enforces with a constraint.

### FX consistency (invariant 11)

- **Proves.** Every payment across currencies moved the source amount from
  the payer to the dealer, and the target amount from the dealer to the
  payee, where the target is the source at the dealer's rate for that
  direction in the scenario, rounded once, half-even, to the target's minor
  unit. When the adapter reports the quote, the target is also what the
  dealer quoted.
- **Needs.** Observations, and a scenario with a dealer.
- **Cannot see.** How a real dealer prices: the kit holds the rate to the
  scenario's. Payments that settled only in part are atomicity's.

### Repo collateral (invariant 14)

- **Proves.** The kit replays each repo it opened from what the ledger moved
  between its two banks under the repo's flow ids. The units the lender
  holds as collateral are that record, never below zero. After each margin
  they cover, at the flow's marks less the haircut, the cash lent plus
  interest accrued to its date. Each substitution brought in at least the
  value it took out, at its marks. Each close returned every unit and moved
  exactly the purchase price plus interest, ACT/365F, rounded once,
  half-even. Where the engine keeps books, each bank's record of each repo
  open at a block is what the ledger moved by then.
- **Needs.** Observations; the repos' records in books for the last part; a
  scenario with repo.
- **Cannot see.** Whether the marks are fair: the kit gives them, and a real
  repo takes them from a market. Margin calls not yet met, and when one is
  overdue, since the adapter reports settlements, not calls.

## Proof that it catches failures

A kit that catches nothing proves nothing, so the sandbox ships seven
deliberately broken engines
([sandbox/broken.ts](../packages/conformance/src/sandbox/broken.ts)). Each is
a small change to the real one: a contract deployed in place of the real
contract ([contracts/src/broken](../contracts/src/broken)), a named defect
in the participant runtime
([defects.ts](../packages/participant/src/defects.ts)), or both. The real
engine never deploys those contracts or sets those defects. The settlement
engine's once-only check and per-leg authority are internal hooks
(`_requireUnsettled`, `_authorize`), so a broken engine overrides one of them
and nothing else.

| Broken engine | The change | Fails | Also fails, because |
| --- | --- | --- | --- |
| `split-legs` | `SplitLegsEngine.settleLeg`, one leg per transaction, and a submitter that sends each leg alone | atomicity | supply equals liability and books equal the ledger: each leg alone matches nothing booked, so no participant posts the payment, while the chain moved it |
| `no-once` | `NoOnceEngine` drops the once-only check | exactly once | supply and books: the second settlement is a break at every participant that sees it, booked by none |
| `lax-mint` | `LaxMintEngine` never looks for a mint's authority | authority | supply and books: the payment sent without the payee's bank settles, and neither bank booked it |
| `open-deposit` | `OpenDepositToken` admits anyone not blocked, the ERC-7943 default | eligibility | nothing: both banks booked the payment, which settled |
| `book-refused` | the submitter posts a refused instruction's entry instead of voiding it | books equal the ledger | supply equals liability: the payer's bank's tokenized deposits moved in its books alone |
| `round-fx-twice` | every party prices a quote's target rounding to a tenth of the minor unit, then to the unit | FX consistency | nothing: every party, and its own reconciler, agrees on the wrong amount |
| `repo-interest-360` | every party computes a repo's interest over a 360-day year | repo collateral | nothing: both banks book the repayment they agreed on |

In each case liability conservation is not judged where books already
disagree with the ledger, and passes elsewhere. The broken contracts'
Foundry tests ([Broken.t.sol](../contracts/test/Broken.t.sol)) show that
each lets through exactly what it is named for and still refuses the rest.
The kit's scripted run fails each broken engine on its check and on exactly
the checks listed with it
([broken.test.ts](../packages/conformance/test/broken.test.ts)), on
`ca-interbank`, on `ca-us-pvp` for rounding, or on `ca-repo` for repo
interest. `pnpm conformance <scenario> --engine all` runs the real engine and
every broken one the scenario can show, and says whether each was caught.

Running the kit against `no-once` found a fault in the real runtime. A
participant's listener that met an instruction settled a second time either
ignored it, where it had booked the instruction, or, at a central bank
observing it, stopped at that block for good, because booking it again
under the same key was refused. The listener now records the second
settlement as a break, books nothing twice and moves on
([repeated.test.ts](../packages/participant/test/repeated.test.ts)).

### On the Besu network

On 18 October 2026, on a second sandbox's networks (`OUL_SLOT=1`): five
QBFT validators for `ca-us-pvp`, and the USD central bank's second ledger.

```bash
pnpm conformance ca-us-pvp --engine all --seed 31 --steps 12 --shrink 0
```

The real engine passed every check on the scripted run (38 steps, every
flow and every fault) and on seed 31. Each broken engine failed the check
named for it, the checks the table lists with it, and no other, in 1,299
seconds for all seven. The scripted run makes the same payments for every
engine, so the ineligible payee's payment that `open-deposit` lets land is
the one the real token refuses (`ERC20UserRestricted`).

An earlier run of that command showed the kit could miss a break. The
scripted run counted each fault's payment as settled, crediting its payee,
so a later fault picked a payer whose money had never arrived, and the
payer's bank refused its payment before it reached the chain. The fault then
staged nothing, and `open-deposit` passed. The script now counts only a
fault payment's payer side as spent, and the tests check that every fault's
payment reaches the engine.

```bash
pnpm conformance ca-us-pvp --coordinator all
```

On the same networks, each coordinator moved the payment across the two
Besu ledgers, CAD on the shared one and USD on the second, under each of
§7's faults. Unified committed or aborted whole every time. HTLC was left
inconsistent with the dealer offline past ledger 1's timeout and with its
claim late, and the notary when it crashed between its commits and when its
second commit was late. Every other case committed or aborted whole. The kit
failed atomicity on exactly those four payments and passed every other check
it can run without books, FX consistency included, in 1,034 seconds.

On 19 October 2026, on the shared network of slot 0: four QBFT validators
for `ca-repo`.

```bash
pnpm conformance ca-repo --engine all --seed 41 --steps 12 --shrink 0
```

The real engine passed every check on the scripted run (51 steps: every
flow, a repo opened, margined, substituted and closed, both bonds paid and
redeemed after it, and every fault) and on seed 41. Repo collateral found
each bank's record of the repo equal to the ledger at six blocks. Five
broken engines failed the check named for them and the checks the table
lists with it (`repo-interest-360` on repo collateral alone), in 1,902
seconds. `no-once` passed. The duplicate submission's three concurrent
requests, held for approval above Bank A's threshold, each approved the same
proposal, and the one that lost the race reported the payment refused, so
nothing was resubmitted on chain. The scripted operators now treat a
proposal that another approval settled as approved. Run again, `no-once`
failed the exactly-once check (with supply equals liability and books equal
the ledger), and the real engine and `repo-interest-360` ended as before.

The kit's own tests also run it against an engine in memory
([memory-engine.ts](../packages/conformance/test/memory-engine.ts)) that
keeps SPEC.md §4.2's rules, and against six copies of it, each with one rule
broken the way the sandbox's broken engines break it
([kit.test.ts](../packages/conformance/test/kit.test.ts)). The clean engine
passes every check, scripted and on seeded runs with every fault. Each
broken one fails the check named for it, shrinking finds a sequence under a
quarter of the scripted run's length that still fails it, and on seeded runs
with faults each is caught by its check in at least one of six seeds.
