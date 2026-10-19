# Design note

How Open Unified Ledger is built, and for each design choice: the public
source it follows, where it departs from that source, and the test that
proves it. Where a choice is this project's own, it says so.

Sources are numbered as in [sources.md](sources.md) and written **[S#]**,
with the location inside the source where it matters. Agorá page numbers
are the report's printed page numbers. The sandbox's rules are in
[rulebook.md](rulebook.md); the full specification is [SPEC.md](../SPEC.md).

## 1. What this is, and what it does not claim

Open Unified Ledger is an open, runnable sandbox in which tokenized central
bank money and tokenized commercial bank deposits sit on one shared ledger
and settle interbank payments and bonds atomically. It follows the model the
BIS proposed as a "unified ledger" [S7, S9], and implements, on one ledger,
what Project Agorá prototyped for tokenized reserves and
deposits [S1] and what the Bank of Canada's Project Samara did for a bond
settled in wholesale central bank money [S11, S12].

Its scenarios are Canadian. One moves tokenized deposits between fictional
banks, the kind of movement Canada's six largest banks said in September
2026 they are exploring [S14]. Another is a Samara-style bond.

**Canadian context.** The Bank of Canada joined Agorá in May 2026 [S2, S3].
CIBC, BMO and Scotiabank announced on 29 September 2026 that they had
joined [S4, S5, S6]. OSFI stated on 10 September 2026 that tokenized
deposits are not legally distinct from traditional deposits [S13].

It does **not** reproduce those projects. Agorá had seven central banks,
dozens of commercial banks, a multi-ledger architecture, multi-currency
settlement and legal analysis in seven jurisdictions [S1]; Samara was a real
C$100 million bond issued by EDC [S11]. This sandbox implements settlement
mechanics, with fictional participants, from public documents only. It is
not affiliated with or endorsed by the BIS, the Bank of Canada or any bank.

## 2. The model in one page

```
                         Shared ledger (Besu, QBFT)
   wholesale CAD (central bank's liability)    deposit tokens (each bank's liability)
   bonds (issuer's obligation, via its agent)  settlement engine: atomic, once only
            ▲ instructions, approved by whoever's liability or account they touch
            │                                      ▼ events
   ┌────────┴────────┐  ┌──────────────────────────────────────────────┐
   │ Central bank    │  │ Each bank: double-entry books, outbox,       │
   │ RTGS, wCAD books│  │ listener, reconciler, ISO 20022 messages     │
   └─────────────────┘  └──────────────────────────────────────────────┘
```

An interbank payment of $2,500 from a Bank A customer to a Bank B customer is
one instruction with three legs, settled in one transaction or not at all:
burn the payer's Bank A deposit token (`dCAD-A`), move $2,500 of wholesale
CAD (`wCAD`) from Bank A to Bank B, and mint Bank B's deposit token
(`dCAD-B`) to the payee. Each bank posts its own side in its own books with
that block, and the central bank posts the movement between the two banks'
wholesale lines. Every participant then proves its books equal the chain.

The same payment runs in two more modes. In **interop mode** Bank B's
deposits live on a second ledger, and a coordinator (hashed timelocks, or a
notary running two-phase commit) settles the two parts separately. This
shows where cross-ledger settlement can leave the ledgers disagreeing
(§3.15). In **confidential mode** each bank's deposits are Paladin Noto
tokens private to the bank, settled atomically with the wholesale leg
(§3.16). A console shows each participant's books, instructions, messages
and reconciliation, runs the fault harness, and draws the interop and
confidentiality results.

## 3. Design choices and their sources

Each entry gives what is **built** (what the code does), what it
**follows** (the source), where it **differs** from the source, and how it
is **proven** (the test). The interop entries add **what it shows**.

### 3.1 One ledger for central bank money and commercial bank money

- **Built.** Wholesale CAD and every bank's deposit token are tokens on the
  same ledger, moved by one settlement engine
  ([`SettlementEngine.sol`](../contracts/src/SettlementEngine.sol),
  [`WholesaleToken.sol`](../contracts/src/WholesaleToken.sol),
  [`DepositToken.sol`](../contracts/src/DepositToken.sol)).
- **Follows.** The BIS's proposal of a programmable platform combining
  central bank money, tokenized deposits and other tokenized assets [S7], and
  its 2026 case for anchoring tokenization in central bank money through
  interoperable networks [S9]. Agorá's prototype builds on that concept
  [S1, p.1].
- **Differs.** Agorá used two layers: tokenized deposits on a unifying
  ledger, tokenized reserves on a separate ledger per jurisdiction, which the
  report calls a design choice for the prototype [S1, p.24]. This sandbox
  puts both on one ledger, which is simpler and suits a domestic system;
  §3.17 adds a second currency to the same ledger. The BIS itself does not
  mean a single system for the whole economy: several ledgers could coexist
  [S7].
- **Proven.** Foundry invariant tests
  ([`Settlement.invariant.t.sol`](../contracts/test/invariant/Settlement.invariant.t.sol));
  every `pnpm sim` run.

### 3.2 Atomic settlement of all legs

- **Built.** All legs of an instruction execute in one ledger transaction;
  if any leg fails, the transaction reverts and nothing moves.
- **Follows.** Agorá's atomic settlement, in which all balances update or
  none do [S1, p.2; ch.3 pp.22–23].
- **Differs.** In Agorá, atomicity is a workflow-level outcome across ledgers
  (lock, delegate, settle), and the report is explicit that it is not
  synchronous multi-ledger execution [S1, p.22; p.65]. On one ledger it is
  one transaction. Interop mode splits the same transfer across two ledgers
  to show what that difference costs (§3.15).
- **Proven.** Invariant 5: Foundry invariants, the runtime's tests, and
  every `pnpm sim` run, which checks that every settled instruction is
  posted at its block and every refused one left nothing on chain.

### 3.3 A tokenized deposit is still a deposit

- **Built.** A deposit token is the issuing bank's liability. Tokenizing
  moves value from the customer's deposit account to its tokenized-deposit
  account, both liabilities of the same bank; the bank's total deposits do
  not change ([`postings.ts`](../packages/domain/src/postings.ts)).
- **Follows.** OSFI: tokenized deposits are "not legally distinct from
  traditional deposits" [S13]. Agorá's legal analysis: tokenization does not
  alter the legal nature of the underlying account relationship [S1, ch.5
  pp.59–60; p.73]. The BIS on the singleness of money: tokenized deposits
  that settle in central bank money keep it, where bearer stablecoins can
  trade away from par [S10; S8].
- **Differs.** OSFI also expects prudential guidelines to be met and
  supervisors consulted before a launch [S13]; a sandbox does neither.
- **Proven.** Invariant 4 (liability conservation): the ledger's property
  tests ([`scenario-flows.test.ts`](../packages/ledger/test/scenario-flows.test.ts))
  and every `pnpm sim` run.

### 3.4 Each issuer controls its own token

- **Built.** Only a currency's central bank mints its wholesale tokens, only
  a bank mints or burns its own deposit token, and only a bond's agent mints
  the bond. The engine holds no authority of its own: each leg needs the
  approval of the participant whose liability or account it touches.
- **Follows.** Agorá: central banks retain exclusive control over issuing
  and redeeming tokenized reserves in their currency [S1, p.60], and each
  jurisdiction keeps control through the layered design [S1, p.2; pp.24–25].
- **Differs.** Agorá achieves this with separate jurisdictional ledgers.
  Here it rests on each token contract's roles and the engine's authority
  rule, a mechanism of this project's own.
- **Proven.** Invariant 9 (authority): Foundry invariants, and every
  `pnpm sim` run, which checks each settlement was sent by the participant
  that recorded itself as its submitter.

### 3.5 The receiving bank consents to its own liability

- **Built.** In an interbank payment the payee's bank co-signs before the
  instruction can settle, because the mint creates its deposit liability. It
  rebuilds the legs itself and signs what it computed, never what it was sent
  ([`participant.ts`](../packages/participant/src/participant.ts) `approve`).
- **Follows.** The closest public precedent is Agorá: the creditor's bank
  answers confirmation of payee and validation, and settlement cannot
  proceed until all required participants have endorsed it [S1, p.44; p.50].
  The UK Regulated Liability Network experiment likewise required the
  account-owning institution's approval for actions on its accounts [S30].
- **Differs.** Neither states the rule as this sandbox does. "The payee's
  bank signs the mint of its liability" is **this project's rule**, drawn
  from those precedents and from the principle that no bank's liability
  should be created without it.
- **Proven.** `test_payeeBankMustApproveTheMintOfItsLiability` in
  [`SettlementEngine.t.sol`](../contracts/test/SettlementEngine.t.sol).

### 3.6 Across institutions, not retail

- **Built.** No retail wallets: customers hold deposit tokens at addresses
  their bank allowlisted, and their bank instructs for them.
- **Follows.** The six banks' first phase, which aims to move tokenized
  deposits efficiently across Canadian financial institutions [S14]. Agorá
  also left retail and natural persons out of scope [S1, pp.56–57].
- **Differs.** The banks' statement does not say "interbank", and names no
  platform, vendor or timeline [S14]; this sandbox is not their design.

### 3.7 Bonds settle delivery versus payment in wholesale money

- **Built.** A `Bond` token held only by banks; issue, trade, coupons and
  redemption each one atomic instruction against wholesale CAD
  ([`Bond.sol`](../contracts/src/Bond.sol),
  [`flows.ts`](../packages/participant/src/flows.ts)).
- **Follows.** Project Samara: EDC issued a C$100 million tokenized bond on
  a distributed ledger, settled in wholesale central bank deposits issued by
  the Bank of Canada [S11, S12].
- **Differs.** Samara ran on Hyperledger Fabric with separate bond and cash
  ledgers and a short-term bond to a closed investor group [S11, S12]; its
  staff paper calls its findings preliminary [S32]. Less is public about its
  design than about Agorá's. The agent model, record-date
  checkpoints, holder verification and matching in §3.12 follow securities
  practice and this project's choices, not Samara.

### 3.8 Final at commit; legal finality from law

- **Built.** QBFT consensus: a committed block is never reorganized, so the
  code treats settlement as final at commit and never waits for
  confirmations ([`genesis.ts`](../packages/chain/src/genesis.ts)).
- **Follows.** Besu: QBFT has immediate finality and no forks, needs at least
  four validators to be Byzantine fault tolerant, and produces blocks while
  at least two-thirds of validators operate [S26]. For legal finality, the
  Payment Clearing and Settlement Act: the Governor of the Bank of Canada
  designates a system (s.4), and a designated system's settlement rules are
  valid and binding, and payments under them are not to be reversed, despite
  other law (s.8) [S15]; Lynx is designated under s.4(1) [S16].
- **Differs.** Agorá distinguishes technical irreversibility on a ledger from
  settlement finality of the underlying funds [S1, p.26], and found
  finality achievable in all seven jurisdictions only with rules that say,
  per jurisdiction, which event is final [S1, pp.65–66]. The sandbox has no
  designation; its finality rule is a sandbox rule
  ([rulebook](rulebook.md) §5).
- **Proven.** The "validator down" fault: with one validator in four
  stopped, settlement continues and nothing is lost.

### 3.9 One identifier, end to end: the UETR

- **Built.** An instruction's on-chain id is the UETR of the payment it
  settles; the engine settles an id at most once; the ISO 20022 messages
  carry the same UETR, including the wholesale leg's `pacs.009` cover
  ([`instruction.ts`](../packages/chain/src/instruction.ts)).
- **Follows.** SWIFT CBPR+: in a `pacs.009` COV, the UETR should carry the
  UETR of the underlying `pacs.008` [S19, element 5.86.4].
- **Proven.** Invariant 6 (exactly once): Foundry invariants, and the
  "duplicate submission" fault (three concurrent requests become one
  instruction; an on-chain resubmission reverts with `AlreadySettled`).

### 3.10 The books are the bank's, and they must equal the chain

- **Built.** Each participant keeps append-only double-entry books in
  Postgres whose rules the database enforces (balanced entries, no edits,
  instants and blocks never going backwards). A listener posts each
  instruction with its block only if the chain moved exactly what was
  booked; a reconciler proves, after the blocks it processes, that every
  mirrored account equals its token balance
  ([`0001_ledger.sql`](../packages/ledger/migrations/0001_ledger.sql),
  [`listener.ts`](../packages/participant/src/listener.ts),
  [`reconciler.ts`](../packages/participant/src/reconciler.ts)).
- **Follows.** **This project's design.** It makes §3.3 checkable: if a
  deposit token is the bank's liability, the bank's books must say so, block
  by block. Agorá kept compliance checks and sensitive logic off-ledger in
  each bank's own systems [S1, p.2; ch.5], which is where these books sit.
- **Proven.** Invariants 1, 2 and 3: the ledger's model-based property tests,
  the runtime's tests on a local chain, the end-to-end run (a deliberately
  corrupted entry is caught as a break), and every `pnpm sim` run.

### 3.11 Compliance controls on every token

- **Built.** Every token implements ERC-7943: holders must be eligible,
  balances can be frozen, an issuer can force a transfer to an eligible
  receiver. Deposit-token holders are allowlisted by the issuing bank after
  its own KYC; wholesale tokens are held by active banks with a reserve
  account at their central bank, and bonds by active banks.
- **Follows.** ERC-7943 (uRWA), status Final: `canSend`, `canReceive`,
  `canTransfer`, freezing and forced transfer [S23], through OpenZeppelin's
  community implementation.
- **Proven.** Invariant 7 (eligibility): Foundry invariants and every
  `pnpm sim` run; the "frozen counterparty" fault (the engine refuses, the
  payer's entry is voided with a `pacs.002` `RJCT`, the payee's side
  expires).

### 3.12 Bonds: agent, record dates, verification, matching

- **Built.** The issuer acts through a bank as issuing and paying agent.
  Balances are checkpointed per block, so a holder verifies its coupon from
  its holding at the record block. Each holder co-signs a coupon only after
  recomputing it from the terms. Each buyer co-signs an issue or trade only
  if its operator affirmed it under the same UETR, and both sides'
  `sese.023` instructions carry that UETR as their common reference
  (`CmonId`).
- **Follows.** Settlement instruction matching, in which both
  counterparties' instructions must agree before settlement, as securities
  settlement systems do. The schema elements used exist in
  `sese.023.001.13` [S21].
- **Differs.** The use of `CmonId` for the UETR is this project's. The
  coupon conventions are **not** Government of Canada practice: those bonds
  pay half the annual coupon every six months, and the actual/365 basis is
  the market convention for accrued interest [S29]. The scenario's bond
  computes each coupon from the period's actual days over 365, so coupons
  vary slightly by period, which exercises the day-count and rounding
  arithmetic. The ACT/ACT-ICMA basis, also implemented, gives the
  half-coupon behaviour. The record date of one business day before payment
  is this project's choice; no authoritative Canadian convention was found.
  Holdings are carried at face, and a difference between price and face is
  a gain or loss at once, where real books would amortize it.
- **Proven.** Invariant 8 (coupon completeness), checked by the agent's
  reconciler on every coupon and redemption; invariant 10 (securities
  backing); the bond's whole life in the runtime test and over HTTP on Besu.

### 3.13 ISO 20022 at the versions in use

- **Built.** `pacs.008.001.08`, `pacs.009.001.08`, `pacs.002.001.10`,
  `camt.054.001.08`, `camt.053.001.08`, `sese.023.001.13` and
  `sese.025.001.13`, built from the instructions and journal and validated
  against the official XSDs ([`packages/iso20022`](../packages/iso20022)).
  A payment across currencies (§3.18) is one `pacs.008` carrying the amount
  instructed in the payer's currency (`InstdAmt`), the amount settled in the
  payee's (`IntrBkSttlmAmt`) and the dealer's rate (`XchgRate`), and a
  `pacs.009` cover for each currency's wholesale leg, all under the one UETR
  of the atomic instruction. Each repo leg (§3.25) is a `sese.023` from
  each side and a `sese.025`, typed and linked to its repo as SPEC.md §8
  sets out; a manufactured payment is a `pacs.009`.
- **Follows.**
  - Lynx: `pacs.008.001.08`, `pacs.009.001.08` (core and cover) and
    `camt.053.001.08` are in its message portfolio; `pacs.002.001.10` is
    listed as being considered for future implementation [S17]. CBPR+ uses
    `pacs.008.001.08`, `pacs.009.001.08` and `camt.053.001.08` [S20].
  - `camt.054.001.08` is the version in Payments Canada's corporate-to-bank
    guidelines; it is not part of the Lynx interbank portfolio [S18].
  - `sese.023.001.13` and `sese.025.001.13` are the versions T2S is moving
    to for ISO's 2026 maintenance release [S31]. Their schemas define a
    blockchain address or wallet (`BlckChainAdrOrWllt`), digital payment
    settlement (`DgtlPmtSttlm`) and a digital token unit (`DgtlTknUnit`)
    [S21], which a tokenized settlement can use.
  - The schemas are from iso20022.org, used under its terms of use [S22].
- **Differs.** The sandbox's banks have no BICs, so they appear as members of
  a proprietary clearing system, and on-chain addresses travel as account
  proxies. That mapping is this project's.
- **Proven.** All 46 fixtures validate against the official XSDs; the
  end-to-end run validates every message the services serve,
  `pvp-http.test.ts` every message of a payment across currencies at each of
  its three banks, and `repo-http.test.ts` every message of each repo flow at
  both banks.

### 3.14 Keys stay where the participant puts them

- **Built.** A signer interface with a local key and AWS KMS, where a
  secp256k1 key signs digests and never leaves KMS
  ([`kms.ts`](../packages/signer/src/kms.ts)).
- **Follows.** AWS KMS supports ECC_SECG_P256K1 keys signing with
  ECDSA_SHA_256 [S27] and returns DER-encoded signatures [S28]. Ethereum
  rejects signatures whose s is above half the curve order [S25], so the
  signer normalizes s and recovers the parity bit itself.
- **Differs.** Tested against a stand-in for KMS that returns high-s
  signatures half the time, not against a live KMS.

### 3.15 What a second ledger costs (interop mode)

- **Built.** The same interbank transfer with Bank B's deposit token on a
  second, separate Besu network: the payer's burn and the wholesale transfer
  on ledger 1, the payee's mint on ledger 2. Each ledger runs a
  `ConditionalSettlement`, which locks its part under the engine's own
  authority rule, freezing what the legs take. The part settles on a
  hashlock's preimage or a notary's commit before its timeout, and is
  released by the notary's abort or, after the timeout, by anyone
  ([`ConditionalSettlement.sol`](../contracts/src/ConditionalSettlement.sol)).
  Three coordinators move the transfer behind one interface: unified (one
  transaction on the shared ledger), HTLC (run by the two banks) and notary
  two-phase commit, which logs each decision before acting on it
  ([`coordinators.ts`](../services/coordinator/src/coordinators.ts)).
  `pnpm interop` runs each under four faults on the two real ledgers and
  records every part's state over time.
- **Follows.** Agorá's own account of cross-ledger atomicity: it is a
  workflow-level outcome across payment legs, not synchronous multi-ledger
  execution, and the ledger updates do not all happen at the same moment
  [S1, p.22; p.65]. Its payment coordinator locks before it commits or
  cancels [S1, pp.50–51], and its reserves sat on separate ledgers per
  jurisdiction by design choice for the prototype [S1, p.24].
- **What it shows.** The unified mode never leaves the two sides
  disagreeing: one transaction settles every leg or none, whatever fails.
  Each cross-ledger mode has a window between settling one ledger and the
  other, about a second when nothing goes wrong. A fault that holds the
  window open past a timeout leaves the ledgers disagreeing for good. Under
  HTLC, when Bank B is offline past ledger 1's timeout or its claim lands
  after it, the payee has been credited and Bank B is never paid. Under the
  notary, when it crashes between its two commits and is back only after
  ledger 2's timeout, or its second commit lands late, Bank B has been paid
  and the payee is never credited. Other faults only delay or abort, with
  both ledgers agreeing (SPEC.md §7 tabulates all fifteen cases).
- **Differs.** These are textbook HTLC and two-phase commit with short
  timeouts, built to make the windows visible, not Agorá's coordinator.
  Agorá manages these risks with its own workflow and rules, and left the
  operating model and its legal characterization out of scope [S1, p.66].
  Faults are injected into the parties' steps on real ledgers; the parties
  run in one process, so a crash is a party stopping and resuming (the
  notary from its durable log), not a killed process.
- **Proven.** `ConditionalSettlement.t.sol` (21 tests) reproduces each
  window at contract level. `pnpm interop` checks every case against the
  outcome SPEC.md §7 states and fails otherwise; the console's Interop page
  draws each run. The conformance kit, reading only the two ledgers, finds
  the same: atomicity fails for exactly those cases (§3.20).

### 3.16 Deposits private to their bank (confidential mode)

- **Built.** Each bank runs a Paladin node beside its validator and notarizes
  its deposit token as a Noto token; customers hold unspent states under
  keys their bank's node derives. An interbank payment locks a burn of the
  payer's deposit and a mint of the payee's, each on its own bank's node,
  delegates both locks to `ConfidentialSettlement`, and spends them with the
  wholesale leg in one shared-ledger transaction
  ([`paladin.ts`](../packages/chain/src/paladin.ts),
  [`ConfidentialSettlement.sol`](../contracts/src/ConfidentialSettlement.sol)).
- **Follows.** Agorá protected data at token level and at transaction level,
  and kept proofs, not account identifiers or amounts, on the ledger
  [S1, p.2; pp.43–47; pp.68–71]. Noto tokens are managed by a single party,
  the notary, and their states appear on the base ledger only as hashes,
  with the private data exchanged over private channels [S35]. Paladin, at
  v1.0.0 [S33], is an LF Decentralized Trust project that its maintainers
  describe as deployed with central and commercial banks for tokenized cash,
  payment versus payment and delivery versus payment [S34].
- **Differs.** Agorá used privacy groups and bilateral messaging, not
  notarized tokens. The notary here is the bank whose liability the deposit
  is, so the party that already knows its customers is the only one that
  sees them. Paladin's own atomic swap contract executes a fixed list of
  calls and reverts all if one fails [S36]; it was not usable here because it
  calls ERC-20 `transferFrom`, which the wholesale token forbids, and cannot
  cancel a Noto lock it holds, so the payment settles through the sandbox's
  own contract, which can. The wholesale leg stays public among validators,
  and so does its amount, which equals the deposit legs'. Paladin supports
  only Kubernetes; here the nodes run its release image under Docker
  Compose, and their signing keys reach every validator's allowlist through
  Besu's permissioning API at runtime [S37].
- **Proven.** `pnpm confidential:smoke` (another bank's node holds none of
  a payment's states; the shared ledger carries no customer key and no
  amount), `pnpm confidential:pay` (one payment settles whole; a cancelled
  one moves nothing), `ConfidentialSettlement.t.sol` (8 tests against a
  stand-in for Noto's lock interface), and `pnpm confidential:compare`,
  which measures the same payment in both modes: validators go from seeing
  the payer, the payee, the amount and both balances to seeing only the
  wholesale leg and its amount, and each bank sees only its own customer.

### 3.17 Several central banks on one ledger

- **Built.** A ledger may carry two currencies, each with its own central
  bank, wholesale token and books. The first central bank operates the
  registry and admits the other; each central bank issues and lists its own
  wholesale token, alone approves a mint of it, and opens a reserve account
  on it for each bank that may hold its currency. The operator cannot
  suspend another central bank. Every account is in one currency and every
  entry balances in each; a bank holding reserves in two currencies keeps
  its reserves, and an FX position, in each
  ([`ParticipantRegistry.sol`](../contracts/src/ParticipantRegistry.sol),
  [`WholesaleToken.sol`](../contracts/src/WholesaleToken.sol),
  [`chart.ts`](../packages/domain/src/chart.ts)).
- **Follows.** Agorá: one platform for several central banks' tokenized
  reserves, each central bank keeping control of its own [S1, p.60], for
  cross-border payments [S1, pp.56–57].
- **Differs.** Which central bank operates the registry is a sandbox choice
  (the first listed); how central banks would govern a shared platform
  together is for agreements, not code (rulebook §16).
- **Proven.** `CrossCurrency.t.sol`: each central bank alone mints, lists
  and opens accounts in its currency, and a four-leg payment across two
  currencies settles whole or not at all. On a local chain,
  `two-currencies.test.ts`: each currency funded at its own central bank,
  the dealer in both, and every participant's books balanced and reconciled
  in each currency apart.

### 3.18 Payment versus payment at the dealer's signed quote

- **Built.** A customer pays a customer of another bank in another currency
  through the dealer, in one instruction of four legs: the payer's deposit
  burned, the source currency's wholesale from the payer's bank to the
  dealer, the target currency's from the dealer to the payee's bank, the
  payee's deposit minted. The payer's bank first asks the dealer for a
  quote, which the dealer signs (EIP-712) and keeps; the target amount is
  the source amount at the rate, rounded once, half-even. The dealer
  co-signs the instruction first, only for its own unchanged quote and only
  once, and the instruction cannot outlive the quote. The dealer books the
  exchange against an FX position in each currency
  ([`fx.ts`](../packages/participant/src/fx.ts),
  [`postings.ts`](../packages/domain/src/postings.ts)).
- **Follows.** Agorá: payment versus payment between currencies on the
  shared platform, so that neither side of an exchange settles without the
  other [S1, pp.51–52].
- **Differs.** The dealer's rates are fixed in the scenario, one per
  direction; a real dealer prices each quote from the market and manages
  its position, which the sandbox leaves at the FX position accounts.
- **Proven.** Invariant 11: the domain's property test (conversion equals
  integer arithmetic, half-even, for any amount and rate);
  `two-currencies.test.ts` on a local chain (a payment settles at the
  quote, a quote settles once, an altered, unsigned, expired or borrowed
  quote is refused with nothing booked, a dealer short of the target
  currency refuses before the payee's bank books); `pvp-http.test.ts`, the
  same over the services' HTTP APIs; every party's reconciler, which
  checks after each block that what it booked in each currency is what the
  dealer signed; and the harness's checker, which reads each payment's legs
  from the chain and prices its quote again. On Besu: `pnpm e2e ca-us-pvp`
  and `pnpm sim ca-us-pvp`, with every fault.

### 3.19 Across currencies on two ledgers (interop mode)

- **Built.** The payment of §3.18 split by currency: CAD on ledger 1, USD on
  a second network the USD central bank runs, with its own registry,
  wholesale USD and the payee's bank's USD deposits. Ledger 1's part, the
  payer's burn and its bank's CAD to the dealer, is locked by the payer's
  bank; ledger 2's, the dealer's USD to the payee's bank and the payee's
  mint, by the dealer with the payee's bank's co-signature. The same three
  coordinators move it under the same faults
  ([`ledgers.ts`](../services/coordinator/src/ledgers.ts)).
- **Follows.** Agorá: payment versus payment between currencies [S1,
  pp.51–52], and reserves on separate ledgers per jurisdiction as a
  prototype design choice [S1, p.24]: the arrangement whose cost this case
  shows.
- **What it shows.** Where a coordinator leaves the ledgers disagreeing,
  one currency has been delivered and the other not. In an HTLC with the
  dealer offline past ledger 1's timeout, the dealer delivered USD and
  never received CAD; with the notary crashed between its commits, the
  dealer received CAD and the payee was never paid. The unified mode, four
  legs in one transaction, has no such window.
- **Proven.** `CrossCurrencyInterop.t.sol` (5 tests): ledger 2's lock needs
  the payee's bank, and each window, at contract level.
  [`coordinators.test.ts`](../services/coordinator/test/coordinators.test.ts)
  runs all fifteen cases, in one currency and across two, on two local
  chains producing a block a second, each ending as SPEC.md §7 says, and
  `pnpm interop ca-us-pvp` runs them on two Besu networks.

### 3.20 Any engine checked against the same invariants (conformance kit)

- **Built.** `packages/conformance` states SPEC.md §6's invariants as nine
  checks that read only what an engine's adapter reports: each
  transaction's movements (as ERC-20 `Transfer` events give them), its
  instruction id and approvers; balances, supplies, and each holder's
  admission and frozen balance as the issuer records it; and each
  participant's books as of a block. The checks run on a scripted sequence
  of every flow and fault and on seeded random sequences, and a failing run
  is shrunk to the smallest sequence found that still fails. The kit ships
  seven deliberately broken engines, each a small change to this sandbox's,
  made with contracts in place of the real ones or with named defects in
  the runtime ([`docs/conformance.md`](conformance.md)).
- **Follows.** **This project's design**: the invariants it already proves
  of itself, stated so they can judge another engine. Movements are read
  from `Transfer` events because ERC-20 requires one on every transfer and
  on creation [S38]; shrinking follows delta debugging, which narrows a
  failing input by testing ever smaller parts of it [S39].
- **Differs.** The kit sees only what the adapter reports: an engine's
  private state is out of its reach, it cannot verify an approval without the
  engine's own encoding (the sandbox's adapter recovers every signature
  itself), and it holds FX rates to the scenario's.
- **Proven.** The sandbox's engine passes every check, with every fault, in
  one currency, across two, through a bond's whole life and through a repo's
  ([`sandbox.test.ts`](../packages/conformance/test/sandbox.test.ts)); each
  broken engine fails the check named for it
  ([`broken.test.ts`](../packages/conformance/test/broken.test.ts),
  [`Broken.t.sol`](../contracts/test/Broken.t.sol)); interop mode's
  coordinators fail atomicity exactly where §3.15 says they leave the
  ledgers disagreeing, and nowhere else
  ([`interop.test.ts`](../packages/conformance/test/interop.test.ts));
  `pnpm conformance --engine all` and `--coordinator all` do the same on
  the Besu networks ([`docs/conformance.md`](conformance.md)). Running the
  kit found two faults in the runtime, both fixed. A listener that met an
  instruction settled twice stopped or ignored it; it now records a break
  and moves on. On `ca-repo`, a flow held for approval and requested three
  times at once had each request approve it, and the one that lost the race
  reported the flow refused; the scripted operators now treat a proposal
  that another approval settled as approved.

### 3.21 Four eyes before a signature: policies, operators and the audit log

- **Built.** Each participant's operators and their roles (`operator`,
  `approver`, `administrator`) and its approval policy are part of the
  scenario (`operators.yaml`). An operator starts every flow, identified to
  the service by a token; above its policy's threshold the flow is booked,
  so its funds are held, but neither signed nor sent until operators other
  than its initiator holding a role the policy names approve it; a rejection
  or an expiry voids its entry. A central bank's policy holds a bank's
  request to mint the same way, and a buyer's affirmation counts only once
  approved. Every initiation, approval, rejection, signature, submission and
  outcome is appended, in the same transaction as the change, to a log whose
  entries each carry the hash of the one before
  ([`policy.ts`](../packages/participant/src/policy.ts),
  [`audit.ts`](../packages/participant/src/audit.ts),
  [`0005_policy_and_audit.sql`](../packages/participant/migrations/0005_policy_and_audit.sql)).
- **Follows.** **This project's design** for the policy and the operators,
  as SPEC.md §15 describes them; the roles are the sandbox's. The log
  follows the idea of chaining each entry to the one before it with a hash,
  so that altering or deleting an earlier entry can be detected afterwards
  [S40].
- **Differs.** Operators are tokens derived from public labels, not people
  signed in through an identity provider, and the log is kept in the
  participant's own database with no copy anchored anywhere else: someone
  who could rewrite the whole log from an edited entry onwards would leave a
  chain that verifies. Anchoring the head elsewhere, on the ledger or with a
  third party, would close that; the sandbox does not.
- **Proven.** Invariant 12: [`policy.test.ts`](../packages/participant/test/policy.test.ts)
  (a flow above its threshold waits unsigned and unsent, its initiator and an
  operator without the role cannot approve it, a rejection and an expiry void
  it, a central bank's policy holds a large mint, and an edited or deleted
  entry breaks the chain where it happened); `http.test.ts` over HTTP; every
  participant's reconciler, from its own log after each block; the
  harness's checker from outside, reading each schema; and `pnpm e2e`, which
  holds a payment for approval, rejects another, and shows an edited entry
  caught.

### 3.22 One change to move to a new key

- **Built.** The registry distinguishes a participant's signing keys from
  its holding addresses, and every role, on the registry and on every token, is
  the participant's, held through its active signing keys rather than
  granted to an address. A rotation is one registry transaction, sent by the
  registry's operator with the participant's consent by its old key and
  proof of the new one: the new key is admitted, the old one retired to a
  holding address that keeps what it holds, and every role moves with it.
  Both sides run it as an administrative change under their own policies,
  and the registry's operator allowlists the new key on every validator
  ([`ParticipantRegistry.sol`](../contracts/src/ParticipantRegistry.sol),
  [`SettlementToken.sol`](../contracts/src/SettlementToken.sol),
  [`changes.ts`](../packages/participant/src/changes.ts)).
- **Follows.** Approval by EIP-712 signatures over typed data [S24], here
  over the rotation itself, and Besu's local account permissioning, whose
  allowlist a running node updates through its API [S37]. Signing keys may
  live in AWS KMS [S27], which is why a participant's identity on the ledger
  is not one key.
- **Differs.** **This project's design**: the registry, not the key, is the
  participant's identity on the ledger. Keeping balances at the old address
  rather than moving them avoids a settlement leg with no instruction booked
  behind it in any core ledger; it relies on tokens moving only through
  the engine, so a retired key, even if lost, can move nothing. The sandbox
  derives each next key from public labels; a production signer would name
  a new key in its key store.
- **Proven.** [`KeyRotation.t.sol`](../contracts/test/KeyRotation.t.sol)
  (the old key can neither submit nor approve, the new key moves the old
  address's balance, every role moves in one change, the registrar's own
  rotation moves its role, and a rotation without both signatures, from
  anyone but the registrar, or replayed is refused);
  [`rotation.test.ts`](../packages/participant/test/rotation.test.ts) (both
  policies, payments settled with the new key, a restart keeping it); and
  `pnpm e2e`, on the Besu network, with the new key allowlisted on every
  validator.

### 3.23 Securities need a verified identity (ERC-3643)

- **Built.** The bond is an ERC-3643 token as well as an ERC-7943 one. Each
  bank has an identity (ERC-734 keys, ERC-735 claims) carrying the central
  bank's KYC claim; the bond's identity registry binds holder addresses to
  identities and admits one only if, for each topic its claim topics
  registry lists, a trusted issuer's claim on it is still valid; its modular
  compliance decides every movement. Its one module allows a movement only
  while the settlement engine settles it, so the engine-only rule is the
  compliance's, and a holder's direct `transfer` is refused as not
  compliant. A trusted issuer revokes a claim, and the holder stops
  receiving the bond while keeping, selling and being paid on what it holds.
  An agent recovers a lost wallet to a new one the holder's identity names
  ([`Bond.sol`](../contracts/src/Bond.sol),
  [`erc3643`](../contracts/src/erc3643),
  [`identity.ts`](../packages/participant/src/identity.ts)).
- **Follows.** ERC-3643 [S41] for the token and its registries, compliance,
  agents, freezing, forced transfer and recovery; ERC-734 [S42] and ERC-735
  [S43] for identities and claims. Written from those texts: the reference
  implementations are GPL-3.0 and are not used.
- **Differs.** The standard's agent `mint` and `burn` skip compliance; here
  they consult it, so they are refused outside a settlement instruction and
  every supply change carries an instruction id. Owners, agents and an
  identity's keys are participants acting through their active signing keys
  in the participant registry rather than addresses, so a rotation (§3.22)
  moves them; `owner()` names one of the owner's keys. A claim signed with a
  key since retired stays valid; ONCHAINID would drop it with the key. The
  one claim topic (KYC, 1) and the module's interface are this project's.
- **Proven.** [`ERC3643.t.sol`](../contracts/test/ERC3643.t.sol) (the
  standard's interfaces, a holder without a verified identity, a direct
  transfer and an agent's mint outside an instruction refused, a revoked
  claim stopping receipt but not sale or redemption, only trusted issuers
  vouching, freezing, forced transfer to verified receivers, recovery, and
  claims across a rotation); [`Bond.t.sol`](../contracts/test/Bond.t.sol)
  (the bond's whole life through the engine under its compliance);
  [`bonds.test.ts`](../packages/participant/test/bonds.test.ts) (a revoked
  bank's trade refused on chain and voided); `pnpm e2e ca-bond-dvp` on Besu.

### 3.24 Client custody at an omnibus wallet

- **Built.** A custodian bank holds bonds for its clients at an omnibus
  wallet, a holding address bound to it in the registry (§3.22) and
  registered with its identity for every bond. Each client's position is a
  memorandum account in its books, off its balance sheet, at face, against
  the omnibus's units, which mirror the chain; its reconciler checks they sum
  per bond to what the omnibus holds (invariant 13). The paying agent finds
  the omnibus in the bond's register and pays it as a holding of its own;
  the custodian credits its clients by their positions at the record block,
  each share rounded once, and shows the residual. A client buys only while
  its own identity verifies. A lost omnibus wallet is recovered by the bond's
  agent to a new one, the registry's operator binding it to the custodian
  ([`custody.ts`](../packages/participant/src/custody.ts),
  [`postings.ts`](../packages/domain/src/postings.ts)).
- **Follows.** ERC-3643's recovery of a lost wallet to a new one its
  identity names [S41]; the record-date checkpoints of §3.12 for who held
  what when.
- **Differs.** **This project's design**: SPEC.md §15 asks for an omnibus
  with a sub-ledger; how its books, allocation and recovery work is the
  sandbox's. The clients' positions are kept in the custodian's own books,
  not on chain, as an omnibus account keeps them; segregated client wallets
  are not built. The custodian keeps its omnibus balance off its balance
  sheet as a memorandum pair rather than in separate custody books.
- **Proven.** [`custody.test.ts`](../packages/participant/test/custody.test.ts)
  (clients buying at issue and in trades each way, a client whose claim was
  revoked refused a new position, a coupon allocated with a one-cent
  residual, a lost wallet recovered with nothing booked and nothing broken,
  coupons and redemption at the new wallet);
  [`Custody.t.sol`](../contracts/test/Custody.t.sol) (only the custodian
  moves the omnibus, recovery to a bound wallet); and `pnpm e2e ca-bond-dvp`
  on Besu, with every message validated.

### 3.25 Repo against tokenized bonds

- **Built.** One bank lends wholesale CAD to another against bonds, as a
  repurchase agreement, each flow one instruction through the unchanged
  engine: the opening (the borrower's units against the purchase price), a
  margin (units delivered on the lender's call, or returned on the
  borrower's), a substitution (one bond's units back, another's in), the
  close (every unit back against principal plus interest) and a
  manufactured payment (a coupon paid on collateral, passed on). The lender
  co-signs an opening or a substitution only on terms or marks its operator
  affirmed under the same UETR, as a buyer affirms a trade (§3.12). A
  margin is called by the side that receives units, at marks it affirms,
  and delivered by the other on that call; once past its due time it is
  overdue on both sides. Each side computes a close and a manufactured
  payment from its own record. Neither side books a sale. Memorandum pairs
  at face keep the collateral received apart from the bonds the lender
  owns, and mark the units pledged within the borrower's holdings, so each
  bank's units on chain are its holdings plus collateral received less
  collateral pledged, and the listener matches a settlement against that
  one balance. Each bank's record of each repo moves in the same listener
  transaction as the settlement
  ([`repo.ts`](../packages/participant/src/repo.ts),
  [`domain/repo.ts`](../packages/domain/src/repo.ts),
  [`postings.ts`](../packages/domain/src/postings.ts)).
- **Follows.** ICMA's account of repo: legally a sale and repurchase,
  economically a secured loan of cash, the repo rate the lender's return
  [S44]; collateral revalued and variation margin called when it falls,
  returned when it rises [S45]; a haircut as a percentage deducted from the
  collateral's market value [S46]; the buyer holding legal title and
  receiving the issuer's income, which it pays the seller as a manufactured
  payment under the GMRA [S47]. Interest on actual days over 365, the basis
  of the Bank of Canada's CORRA, the overnight Canadian dollar repo rate
  [S48]. The messages use `sese.023`'s own codes for repo, reverse repo,
  collateral in and out, top-up and withdrawal, and the return leg [S21].
- **Differs.** **This project's rules**, where the sources leave choices:
  which side submits each flow; a margin computed in whole units of one
  bond, the fewest that cover a shortfall and the most that leave an excess
  covered; a substitution's incoming units the fewest worth at least the
  outgoing ones at the marks, the haircut being the repo's for every bond;
  interest booked at the close rather than accrued daily; a manufactured
  payment computed from the lender's record at the coupon's record block,
  rather than on the income payment date of the GMRA's wording; and no
  re-use of collateral, which ICMA notes a buyer may do [S44]. The sandbox
  is not a GMRA: no master agreement, no close-out netting, no default
  management, no tri-party agent. The repo's terms are not sent in a
  securities financing message (`sese.033`), whose schema is not vendored;
  each bank keeps them in its record.
- **Proven.** Invariant 14. [`Repo.t.sol`](../contracts/test/Repo.t.sol)
  (each flow settles whole or not at all, collateral reaches the lender
  only while its identity verifies, only the lender moves it back, a direct
  transfer is not compliant) and
  [`Repo.invariant.t.sol`](../contracts/test/invariant/Repo.invariant.t.sol)
  (over random opens, margins, substitutions, closes and refused attempts,
  the lender's units are what it owns plus the record); the domain's
  property tests (interest equals integer arithmetic, half-even; a margin
  call covers exactly and a return leaves it covered);
  [`repo.test.ts`](../packages/participant/test/repo.test.ts) (a repo's
  whole life on a local chain, an unaffirmed or uncovered opening refused,
  pledged units unsellable, a call shown overdue at both banks, a
  manufactured payment once, redemption refused while collateral is out,
  every message valid); `repo-http.test.ts` over HTTP; every bank's
  reconciler after each block; the harness's checker, which replays every
  repo from the chain; the conformance kit's repo-collateral check, which
  fails a broken engine computing interest over 360 days (§3.20); and on
  Besu, `pnpm e2e ca-repo`, `pnpm sim ca-repo` with every fault (one with a
  repo open throughout, seeded runs drawing repo flows among the rest) and
  `pnpm conformance ca-repo --engine all`.

## 4. What the sandbox leaves open

- **Privacy of the wholesale leg.** Confidential mode hides customers and
  balances, not the interbank amount (§3.16).
- **The dealer's FX risk.** Its rates are fixed per direction, and its open
  position is booked, not revalued or hedged (§3.18).
- **Repo beyond its mechanics.** No master agreement, close-out or default
  management, and marks agreed by both sides rather than taken from a
  market (§3.25).
- **Legal designation, participant agreements, default management**
  ([rulebook](rulebook.md) §16).
- **Liquidity-saving mechanisms.** Every instruction settles gross, on its
  own funds; there is no queue, offsetting or netting.
- **Authenticated links between participants.**

## 5. How each property is proven

| Invariant (SPEC.md §6) | Unit and property tests | Local chain | Besu end to end | `pnpm sim` |
| --- | --- | --- | --- | --- |
| 1 Balanced entries | ledger property tests | runtime test | ✓ | every block |
| 2 Wholesale backing | — | runtime tests, in one currency and in two | ✓ | every block, across participants |
| 3 Deposit-token backing | — | runtime tests, in one currency and in two | ✓ | every block |
| 4 Liability conservation | ledger property tests | — | — | whole run |
| 5 Atomicity | Foundry invariants | runtime test | ✓ | whole run |
| 6 Exactly once | Foundry invariants | runtime test | ✓ | whole run |
| 7 Eligibility | Foundry invariants, ERC-3643 tests | runtime test, bond test | ✓ | whole run |
| 8 Coupon completeness | domain property tests | bond test | ✓ | bond scenario |
| 9 Authority | Foundry invariants | — | — | whole run |
| 10 Securities backing | — | bond test | ✓ | bond scenario |
| 11 FX consistency | domain property tests | two-currency test, PvP over HTTP | ✓ | whole run, from the chain |
| 12 Policy before signature | — | policy test, over HTTP | ✓ | every block, from each audit log |
| 13 Custody positions | — | custody test | ✓ | every block, at the custodian |
| 14 Repo collateral | Foundry invariants, domain property tests | repo test, over HTTP | ✓ | every block, at each party; whole run, from the chain |

Interop mode's claim, that only the unified mode never leaves the two
ledgers disagreeing, is proven by `ConditionalSettlement.t.sol` and by every
`pnpm interop` run (§3.15). Confidential mode's, that validators and banks
not party to a payment see no customer and no balance, by
`pnpm confidential:compare` (§3.16).

Every check of the conformance kit (§3.20) restates one or more of these
invariants against an engine's adapter alone, so the same table holds for
any engine that passes it: `pnpm conformance` runs it against this one, and
fails each of its seven broken engines on the check named for it.

Every property in the table can be run in one command. `pnpm demo` runs
every flow of a scenario with the invariants checked at every participant,
every message validated and a deliberate corruption caught. `pnpm sim:seeds`
runs seeded random sequences with faults, and keeps each result with the
code it ran against and the command that reproduces it
(`pnpm sim:seeds --summary` shows how many have run and held). Running the
yen fixture, with four banks, through the same runtime proves that the
engine hard-codes no currency or number of banks
(`packages/participant/test/currency.test.ts`).
