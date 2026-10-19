# Open Unified Ledger: specification

An open, working implementation of the unified-ledger model: tokenized
central bank money and tokenized commercial bank deposits on one shared
ledger, settling interbank payments and securities atomically.

It implements the settlement model the Bank for International Settlements
(BIS) prototyped in Project Agorá (report, May 2026), on one ledger and in
one currency, and the delivery-versus-payment settlement the Bank of Canada
tested in Project Samara (March 2026). It is a sandbox drawn from their
public reports, not a reproduction of those projects, which involved central
banks, commercial banks and legal analysis that no software repository can
stand in for. Nothing equivalent is open source: the central bank projects
publish reports, and the bank networks are closed.

The engine is currency-agnostic. What it settles is defined by **scenarios**
(§5): currencies, participants, instruments and flows. The repository's
scenarios are Canadian, among them tokenized CAD deposits moving between
banks, the kind of movement the six largest Canadian banks said on
22 September 2026 they are exploring, and a Samara-style bond. Examples in
this document use them.

## 1. What this is, and what it is not

**It is** a sandbox that a reviewer can start with one command. It shows, in
code that can be read and tested:

- how a tokenized deposit stays the issuing bank's liability and reconciles
  to the bank's own books at every block;
- how an interbank transfer moves deposits and settles in central bank money
  in one atomic step;
- how a bond settles delivery-versus-payment against tokenized central bank
  money;
- why atomic settlement is simple on one ledger and fragile across two, and
  what FX settlement risk looks like when two currencies settle apart;
- how two currencies settle payment versus payment in one step on one ledger;
- what each participant can see, and how deposits stay private to their bank
  while still settling atomically;
- how any settlement engine can be checked against the same invariants;
- how a bank operates it: approvals, audit, client custody, repo;
- how each on-ledger movement maps to the ISO 20022 messages banks use today.

**Product boundaries**, each stated once:

- **Currencies are data.** The engine hard-codes none: a USD or JPY
  scenario is a new folder, not a change to the engine. A scenario has one
  currency, or two for cross-border payment versus payment (§13), each with
  its own central bank and wholesale token on the same ledger. A yen fixture
  with four banks, one without a validator, runs flows 5.1 to 5.3 on the
  same engine (`packages/participant/test/currency.test.ts`).
- **Securities settle in one currency.** A scenario with bonds has one
  currency: delivery versus payment across currencies would add an FX leg
  that payment versus payment (§13) already shows on its own.
- **Wholesale and interbank only.** No retail wallets: the six banks' first
  phase aims to move tokenized deposits across financial institutions, and
  retail would add custody and consumer law without showing anything new
  about settlement.
- **Confidential mode covers single-currency payments.** Cross-border
  payments run in the baseline and interop modes; Noto deposits would carry
  them the same way, and adding them would show nothing new about privacy.
- **Fictional participants.** The central bank, banks and issuer are generic
  (`Central Bank`, `Bank A`, `Bank B`, `Bank C`, `Issuer`). No real
  institution is named, impersonated or implied to endorse the project.
- **Not production.** No real money, no real customer data, no real KYC.
  Correctness is real; legal effect is modelled in a sandbox rulebook.
- **No affiliation** with the BIS, the Bank of Canada or any bank. The design
  draws only on public documents, cited in `docs/design.md`.

## 2. Participants

Participants are defined per scenario. The Canadian scenarios use these:

| Participant | Runs | Holds | Controls |
| --- | --- | --- | --- |
| Central Bank | a validator, the central bank service | nothing | wCAD issuance and redemption, the participant registry, pausing wCAD |
| Bank A, Bank B, Bank C | a validator each, a bank service each | wCAD, bonds, its own customers' deposit tokens (as issuer) | its own deposit token: mint, burn, allowlist, freeze, forced transfer |
| Issuer | no node; acts through Bank C as issuing and paying agent | a deposit account at Bank C | its bond's terms |
| Customers | nothing; simulated by each bank | deposit tokens of their own bank | nothing on-ledger directly; their bank signs for them |

Four validators (the Central Bank and three banks) give QBFT tolerance of one
faulty node.

## 3. Instruments

Every scenario has one wholesale token `w<CCY>` per currency, issued by that
currency's central bank, one deposit token `d<CCY>-<bank>` per bank, in a
currency the bank holds reserves in, and any number of bonds. The Canadian
scenarios:

| Token | Issuer and liability | Holders | Standard |
| --- | --- | --- | --- |
| `wCAD` | Central Bank; tokenized reserves | active banks the Central Bank has opened a reserve account for | ERC-20 with ERC-7943 checks |
| `dCAD-A`, `dCAD-B`, `dCAD-C` | Bank A, B or C; a tokenized deposit, still that bank's deposit | that bank's allowlisted customers | ERC-20 with ERC-7943 checks |
| `BOND-<isin-like id>` | Issuer | addresses whose identity verifies in the bond's identity registry: banks, and custody addresses (§15) | ERC-3643 and ERC-7943, plus bond terms |

A cash token's decimals equal its currency's ISO 4217 minor unit (2 for CAD,
0 for JPY), so one token unit is one minor unit and on-ledger amounts equal
core-ledger amounts with no conversion or rounding between them. Bonds use 0
decimals; one unit is one face amount set in the bond's terms ($1,000 in the
Canadian scenario).

## 4. Architecture

Token and participant names below are the Canadian scenarios' (`wCAD`,
`dCAD-A`, Bank A); the engine takes them from the loaded scenario.

```
                       Shared ledger: Besu, QBFT, 4 validators
  ┌──────────────────────────────────────────────────────────────────────┐
  │  ParticipantRegistry   wCAD   dCAD-A  dCAD-B  dCAD-C   BOND-*        │
  │  SettlementEngine (atomic multi-leg instructions, idempotent by id)  │
  └──────────────────────────────────────────────────────────────────────┘
        ▲ signed instructions, events ▼
  ┌──────────────┐  ┌────────────────────────────────────────────────┐
  │ Central Bank │  │ Bank service (one per bank)                    │
  │ service      │  │  core ledger (Postgres, double entry)          │
  │  RTGS sim    │  │  outbox + submitter, chain listener            │
  │  wCAD ledger │  │  reconciler, ISO 20022 adapter, signer         │
  └──────────────┘  └────────────────────────────────────────────────┘
        ▲                         ▲
  ┌─────┴─────────────────────────┴─────┐   ┌─────────────────────────┐
  │ Console (Next.js): per-participant  │   │ Interop mode: second    │
  │ views, timeline, reconciliation,    │   │ ledger + coordinators   │
  │ ISO messages, fault controls        │   │ (HTLC, notary 2PC)      │
  └─────────────────────────────────────┘   └─────────────────────────┘
```

### 4.1 Shared ledger

- Hyperledger Besu, QBFT consensus, one validator per scenario validator
  (four in most scenarios, five in `ca-us-pvp`), local permissioning: only listed nodes
  peer and only participant accounts send transactions. Zero base fee and
  zero minimum gas price: gas is metered, never paid. Cancun at genesis.
- `pnpm network:generate <scenario>` derives everything from the scenario:
  genesis with the validators in its QBFT extra data, node keys, static
  peers, the allowlists and a Compose file with one Besu service per
  validator. Keys are derived deterministically from public labels, so every
  tool agrees on every address without key files; they are public and for
  the sandbox only.
- `pnpm run deploy <scenario>` deploys and wires the contracts, each participant
  with its own key, and writes `deployments/<scenario>.json` with every
  contract, token, participant and customer address for the services. A
  deployment is identified by the hash of its start block, not by its
  addresses, which deterministic keys repeat on every fresh chain; each
  participant's books live in a schema named after that identity.
- `pnpm interop:generate <scenario>` does the same for interop mode's second
  ledger (§7), from the scenario's `interop` block: its own chain id, subnet,
  ports and Compose project, under `infra/besu/interop`, so the two networks
  share nothing; `pnpm interop:deploy` deploys interop mode's contracts on
  both and writes `deployments/<scenario>.interop.json`.
- QBFT gives immediate finality: a block once committed is never reorganized.
  Settlement is final at block commit, and the code relies on that instead of
  confirmation counts. The interop ledger (§7) exists partly to show what
  changes when that guarantee does not span both legs.

### 4.2 Contracts (Foundry)

- **`ParticipantRegistry`**: which addresses belong to which participant,
  each participant's kind (central bank or bank) and whether it is active,
  and which tokens the engine may move. The first central bank operates it:
  it admits the other central banks and every bank, and lists every token
  except another central bank's wholesale token, which that central bank
  lists itself. A central bank is never suspended: its currency is its own.
  An address that belongs to no participant is a customer. A participant's
  address is a signing key, which submits and approves instructions and
  holds the participant's roles, or a holding address, which holds balances
  for it and signs nothing (a retired key, or a custody address, §15). Every
  role on the registry and on every token is held by a participant through its
  active signing keys rather than granted to an address, so one registry
  change, `rotateKey`, moves a participant to a new key with all its roles.
- **`SettlementToken`** (base of the cash tokens): ERC-20 with ERC-7943
  freezing and forced transfer, decimals equal to the currency's minor unit.
  Tokens move **only** through the settlement contracts holding
  `SETTLEMENT_ROLE` (the `SettlementEngine`, and in interop and confidential
  modes `ConditionalSettlement` and `ConfidentialSettlement`): plain `transfer`,
  `transferFrom` and `approve` revert, so every movement carries an
  instruction id the core ledgers can match. The issuer can freeze, force a
  transfer (the receiver must still be eligible) and pause.
- **`WholesaleToken`** (`wCAD` in the Canadian scenarios): a central bank's
  liability in its currency. Its issuer is a constructor argument, so a
  ledger can carry one per currency. It is held only by active banks to
  which its central bank has opened a reserve account, so each central bank
  alone decides who holds its currency, as it alone approves a mint.
- **`DepositToken`** (one deployment per bank): the issuing bank's liability,
  held only by addresses the bank has explicitly allowlisted after its own
  KYC.
- **`Bond`**: a settlement token with 0 decimals (one unit is one face
  amount), held only by active banks. Its on-chain issuer, whose approval
  mints it, is the issuing and paying agent: the real issuer runs no node and
  acts through its agent, named in `issuerName`. Terms are fixed at
  deployment (face, rate scaled by 10^18, coupons per year, day count, issue
  and maturity dates, record days) with `termsHash`, the keccak256 of the
  canonical terms, so anyone can check the chain against the scenario.
  Balances are checkpointed per block (`balanceOfAt`, `totalSupplyAt`), so a
  holder can verify a coupon from its holding at the record block.
  Issuance, trades, coupons and redemption all run through the
  `SettlementEngine`, which has no bond- or repo-specific logic: each repo
  flow (§5.7 to §5.10) is one instruction of bond and wholesale legs, and a
  repo's terms and collateral record live in each bank's books.
- **ERC-3643 for securities** (§15): the bond is a T-REX token (ERC-3643,
  Token for Regulated EXchanges), the standard for tokenized securities, as
  well as an ERC-7943 token. Each holder has an on-chain identity (ERC-734
  keys and ERC-735 claims). An `IdentityRegistry` binds holder addresses to
  identities. A `TrustedIssuersRegistry` and a `ClaimTopicsRegistry` say
  which claims count and who may issue them (the banks, each attesting its
  own customers' KYC). A `ModularCompliance` contract decides every
  movement. The engine-only rule holds here too: the bond's compliance
  allows a movement only when it settles through the settlement engine, so
  a holder's direct `transfer` is refused as not compliant rather than
  disabled, and every movement carries an instruction id. Agents freeze,
  force transfers, pause and recover a lost wallet, as the standard defines.
  The implementation is this repository's own, written from the standard's
  text (public domain); the reference implementations (T-REX, ONCHAINID) are
  GPL-3.0 and are not used. Cash tokens use ERC-7943 alone: a bank already
  knows its customers, and identity claims would add nothing to deposits or
  wholesale money.
  - Contracts (`contracts/src/erc3643`): `Identity` (ERC-734 keys and
    ERC-735 claims), `ClaimIssuer` (an identity that revokes what it
    signed), `ClaimTopicsRegistry`, `TrustedIssuersRegistry`,
    `IdentityRegistryStorage`, `IdentityRegistry`, `ModularCompliance` and
    `SettlementOnlyModule`; the interfaces are the standard's.
  - Every identity is managed by a participant: a bank for itself and its
    customers, the central bank for itself. The manager's active signing
    keys hold every key purpose, and the registries' owner and agents are
    participants too, so a key rotation moves them with every other role. A
    claim signed by a key its issuer later retired stays valid; the issuer
    revokes a claim it no longer stands behind.
  - One claim topic, KYC (topic 1, the sandbox's choice). The central bank is
    trusted for it and attests each bank's identity at deployment; each bank
    is trusted for it and attests its own customers'. A claim is signed over
    `keccak256(abi.encode(identity, topic, data))` as an EIP-191 message.
  - The bond's agent deploys and owns its registries and compliance, which
    holds one module, `SettlementOnlyModule`, agreeing to a movement only
    while the engine is settling it. Agent `mint` and `burn`, which the
    standard lets skip compliance, consult it here, so they too are refused
    outside an instruction; forced transfers and recovery are the agent's
    enforcement actions outside the engine, as the standard defines them.
  - The deployment records every identity, each trusted issuer's claim
    issuer and each bond's ERC-3643 contracts (`identity` and each bond's
    `regulation` in `deployments/<scenario>.json`); a scenario with bonds
    names its country (ISO 3166-1 numeric), which each holder's identity
    records.
- **`SettlementEngine`**: executes an instruction of up to 16 legs (mint,
  burn, transfer) atomically or reverts all of them. Each instruction carries
  a unique `bytes32` id: the ISO 20022 UETR's 16 bytes followed by 16 zero
  bytes. A repeated id is rejected, so retries are safe, and an instruction
  past its deadline is rejected, so stale approvals expire. It holds no
  balances and no authority of its own. Every leg needs the approval of the
  participant that owns what the leg takes or creates: a mint needs the
  token's issuer, since it creates the issuer's liability; a burn or a
  transfer out of an account needs that account's participant, or, for a
  customer address, the token's issuer acting for its customer. Approval is
  the submitter (who must be an active participant) or an EIP-712 signature
  by an address of an active participant, bound to the chain and the engine.
  The rule lives in the `LegAuthority` library, which every settlement path
  shares.
- **`ConditionalSettlement`** (interop mode, §7): settlement in two steps,
  for an instruction whose legs live on two ledgers. `lock` authorizes this
  ledger's legs exactly as the engine would, over the instruction and its
  condition together, then freezes at each holder what a burn or transfer
  will take (ERC-7943) and records each mint. The lock then settles every
  leg, or is released with nothing moved, under its condition:
  - **hashlock**: `claim` with the sha256 preimage before `timeout`, by
    anyone; the preimage is published in the `Settled` event;
  - **notary**: `commit` by the named notary before `timeout`; the notary
    may `abort` instead.

  From `timeout` on, anyone may `refund`; before it, only settling is
  possible, so the two never race in one block. A lock whose legs can no
  longer execute (a holder blocked since) stays locked until its timeout.
  It needs `SETTLEMENT_ROLE` and `FREEZER_ROLE` on each token; an issuer
  also holds `FREEZER_ROLE`, so a lock on a deposit holds against everyone
  but the bank that issued it.

Built on OpenZeppelin Contracts v5.7.0 and the OpenZeppelin Community
Contracts ERC-7943 implementation, vendored at a pinned commit in
`contracts/src/vendor/oz-community` (unaudited upstream).

### 4.3 Bank service (one codebase, one instance per bank)

The bank and central bank services share one participant runtime
(`packages/participant`): the core ledger plus the outbox, submitter,
listener, reconciler and expiry sweeper below.

- **Core ledger** (`packages/ledger`, shared with the Central Bank service):
  Postgres, double entry, append-only journal. Every account has one
  currency, and every entry balances in each currency (enforced by a
  constraint, not application code). In its deposits' currency, a bank keeps
  an account per customer deposit (DDA), a `Tokenized deposits` liability
  sub-ledger, interest expense and a rounding residual account. For each
  currency it holds reserves in, it keeps a wholesale reserves asset
  (`wholesale-reserves/CAD`) and an RTGS reserves asset
  (`rtgs-reserves/CAD`), and an FX position when it holds more than one
  currency (§13). Entries are pending or posted. Balances are queryable as of
  a time and as of a block number; instants and blocks never go backwards,
  so an as-of answer for an instant the ledger's clock has passed is final.
- **Who books what**: whoever initiates or approves an instruction books its
  full pending entry first, because only it knows the off-chain side (which
  customer deposit or RTGS account is debited). For each flow, one module
  (`flows.ts`) states the legs, the submitter, the co-signers and each
  participant's lines; an approver rebuilds the legs itself and signs what
  it computed, never what it was sent. Deadlines come from block time,
  because that is what the engine judges them by.
- **Outbox and submitter**: the pending journal entry and its outbox row are
  written in one database transaction. The submitter simulates, then sends;
  the instruction id makes resubmission harmless (a duplicate is refused with
  `AlreadySettled`). An engine refusal fails the instruction and voids its
  entry; a network error leaves it for the next attempt.
- **Chain listener**: follows committed blocks from a cursor that advances in
  the same transaction as its postings, so a restart resumes exactly. For each
  settled instruction that moved a mirrored balance: if this participant
  booked it, the chain's movements must equal the pending entry's mirrored
  lines exactly, and the entry is posted with its block; if it did not, the
  central bank posts what the chain fully determines (wholesale moving
  between banks, a bank redeeming) and anything else is recorded as an
  unexplained movement.
- **Expiry sweeper**: once block time passes an instruction's deadline and the
  engine has not settled it, it never will; the pending entry is voided. This
  is how an approver learns an instruction was abandoned: from durable state,
  not a message.
- **Reconciler**: after each block, proves the invariants in §6 that concern
  this bank and records any break with the block, the accounts and the
  difference. A break is shown in the console and never auto-corrected.
- **ISO 20022 adapter**: renders and parses the messages in §8.
- **Signer**: one interface (a viem account), two implementations: a local
  key for the sandbox's derived dev keys, and AWS KMS, where an
  ECC_SECG_P256K1 key signs digests and never leaves KMS. KMS answers in DER
  with no recovery bit and sometimes a high s; the signer normalizes s and
  finds the recovery bit by matching the key's own public key.
- **Interest**: an effective-dated rate table per deposit product. Interest
  accrues daily on deposit balances, tokenized or not, and is posted monthly;
  on-ledger it is paid by minting `dCAD` to the holder. A tokenized deposit
  is a deposit [S13], so it can bear interest as any deposit can; a payment
  stablecoin generally may not, and the design note says so.

### 4.4 Central Bank service

One service per central bank, each covering its own currency, with an
account for each bank holding reserves in it.

- **RTGS simulator**: each bank's settlement account balance, standing in for
  the real-time gross settlement system. Banks fund wCAD from it and redeem
  wCAD back into it.
- **wCAD books**: the central bank's own double-entry ledger, reconciled to
  `wCAD` total supply and per-bank balances every block.
- **Registry administration**: admitting, suspending and removing
  participants.

### 4.5 Service APIs

Each participant runs one service (Fastify) over its runtime. Starting a
flow answers `202 Accepted` with the instruction and a `Location` to poll; it
settles when the shared ledger commits it. Amounts are decimal strings in
major units with their currency (`"2500.00"`, `"CAD"`), parsed exactly. A
bank funds and redeems in any currency it holds reserves in (`currency`, its
own by default).

Refusals are RFC 9457 problem details whose `type`
(`urn:oul:problem:<reason>`) a client can branch on: `validation` (400),
`unauthenticated` (401), `not-a-party` and `not-permitted` (403),
`unknown-customer` and `not-found` (404), `conflicting-instruction` (409),
`insufficient-funds` and `invalid-flow` (422), `peer-unavailable` (503).
Outside `/peer/*`, every request that starts or decides something comes
from one of the participant's operators (§15), as `Authorization: Bearer
<operator token>`. A request without an operator's token is `unauthenticated`; one from
an operator whose roles do not allow it is `not-permitted`. A flow above its
policy's threshold is answered `202` with status `proposed`: booked, but
neither signed nor sent until approved.

| Service | Route | Does |
| --- | --- | --- |
| Bank | `POST /wholesale/fund`, `/wholesale/redeem` | §5.1 |
| Bank | `POST /customers/:customer/tokenize`, `/detokenize` | §5.2 |
| Bank | `POST /payments` | §5.3, co-signed by the payee's bank; with `quote` instead of `amount`, §13, co-signed by the dealer first |
| Bank | `POST /fx/quotes`, `GET /fx/quotes` | ask the dealer for a quote into another currency (§13); the quotes this bank asked for or, as dealer, gave |
| Bank | `POST /peer/quotes` | as dealer, a bank asks for a signed quote |
| Bank | `GET /customers/:customer` | deposit and tokenized balances |
| Bank | `POST /bonds/:bond/affirmations` | agree to buy in an issue or trade (matching), for its own book or a custody `client` (§15) |
| Bank | `POST /bonds/:bond/issue` | §5.4, as issuing agent; an allocation may name a buyer's custody `client` |
| Bank | `POST /bonds/:bond/trades` | §5.5, as seller, under the UETR the buyer affirmed; `client` sells a custody client's units, `buyerClient` buys for the buyer's |
| Bank | `POST /bonds/:bond/payments/next` | §5.6, as paying agent: the next coupon, or redemption |
| Bank | `GET /bonds/:bond` | terms, schedule with payments made, holding, units outstanding |
| Bank | `POST /peer/approvals` | another bank asks for a co-signature |
| Central bank | `POST /peer/funding` | a bank asks for wholesale tokens |
| Central bank | `GET /rtgs`, `/wholesale` | settlement accounts, wholesale lines |
| Bank | `GET /customers/:customer/statement` | `camt.053` of the customer's deposit or tokenized deposit |
| Central bank | `GET /banks/:bank/statement` | `camt.053` of the bank's settlement account or wholesale line |
| Both | `GET /instructions/:uetr/messages` | the ISO 20022 messages that concern this participant, each at `/messages/:name` as XML |
| Bank | `GET /customers` | every customer with deposit and tokenized balances |
| Both | `GET /network` | the scenario's public directory: participants, their services and customers, instruments |
| Both | `GET /instructions?limit&before&status` | this participant's instructions, newest first, paged by `next` |
| Both | `GET /instructions/:uetr` | one instruction: its legs with each party named, who sends it, whose signatures it needs and which are held here, and the journal entry booking it here |
| Both | `GET /journal?limit&before&uetr` | the journal, newest first; `uetr` picks the entry booking one instruction, including one the central bank observed without being a party |
| Both | `GET /health`, `/accounts`, `/reconciliation` | reads |
| Both | `GET /operators` | the participant's operators, their roles and its policy (§15); never their tokens |
| Both | `GET /proposals?status`, `GET /proposals/:subject` | what waits for the policy's approvals, or got its decision |
| Both | `POST /proposals/:subject/decisions` | an operator other than the initiator approves or rejects it |
| Both | `GET /audit?limit&before&subject`, `GET /audit/verify` | the audit log, newest first, and the walk of its hash chain (§15) |
| Both | `GET /keys`, `POST /keys/rotate` | the signing keys, and an administrator starting a move to a new one (§15) |
| Both | `GET /identity` | its identity for securities and the claims on it; as a trusted issuer, the claims it made (§15) |
| Both | `POST /identity/claims/revoke` | as a trusted issuer, an administrator revokes the KYC claim it made about `subject` |
| Bank | `GET /custody`, `POST /custody/recover` | as a custodian, its omnibus wallets and each client's position against the units on chain; an administrator reports the wallet lost (§15) |
| Bank | `POST /repos/affirmations`, `POST /repos` | §5.7: as lender, affirm a repo's terms under a UETR; as borrower, open it under the same one |
| Bank | `POST /repos/:repo/margin-calls`, `POST /repos/:repo/margin` | §5.8: call the margin agreed marks give on a date (the lender a shortfall, the borrower an excess); the other side delivers it on the call |
| Bank | `POST /repos/:repo/substitutions/affirmations`, `POST /repos/:repo/substitutions` | §5.9: as lender, affirm a substitution at marks; as borrower, make it |
| Bank | `POST /repos/:repo/close`, `POST /repos/:repo/manufactured` | §5.10: as borrower, close at the end date; as lender, pass on a coupon paid on collateral |
| Bank | `GET /repos`, `GET /repos/:repo` | each repo it is party to: its terms, the collateral its record holds and its history, its margin calls (open, overdue or met) and the coupons on collateral owed on |
| Bank | `POST /peer/repos/calls` | the other side of a repo tells this bank of a margin call it is to meet |
| Both | `GET /changes`, `GET /changes/:id` | administrative changes started here or asked of this participant |
| All | `POST /peer/changes` | a participant asks another to act on an administrative change: the registry's operator to admit its new key, a bond's agent to recover a wallet |

Every request may carry its own `uetr`; a retry with the same UETR returns
the same instruction. Bond prices are major units per unit (`"1001.50"`);
units are whole numbers. The `/peer/*` endpoints are unauthenticated in this
sandbox: a participant is protected by rebuilding and checking every flow
against its own books before it books or signs. A production deployment
would add mutual TLS between institutions; the sandbox leaves it out because
it would change nothing the sandbox demonstrates.

`pnpm services:up <scenario>` runs every service as its own process, ports
7100 upward in scenario order (`OUL_URL_<PARTICIPANT>` overrides). A second
sandbox beside the first, from another checkout, sets `OUL_SLOT` (1 to 9):
its networks take their own chain ids, subnets, ports and Compose projects,
and its services listen 100 ports up per slot.

### 4.6 Console (Next.js)

`pnpm console` serves it on port 7090 (7000 is macOS's AirPlay receiver). It
reads the participants' services and nothing else: the directory from one
service's `/network` (`OUL_CONSOLE_ENTRY`, the central bank by default), then
each participant's view from that participant's own service.

- One view per participant, showing only what that participant may see.
  Every amount carries its currency; books kept in more than one currency
  name each account's.
- A settlement timeline: each instruction's legs, signatures, block, and
  outcome, with the journal entry that books it. At the central bank an
  interbank payment it observed on chain, without being a party, shows as
  that observed entry.
- Reconciliation status per bank and for the Central Bank, with breaks.
- At the dealer, the quotes it gave, each with the payment that settled it,
  and its FX position in each currency; at another bank, the quotes it asked
  for.
- The ISO 20022 message beside each movement: `pacs.008`, `pacs.009` and
  `sese` beside the legs they document, `camt.054` beside the journal entry,
  `pacs.002` beside the outcome; each opens to its XML.
- Each participant's operators (§15): the console acts as one of them,
  chosen per participant and sent as its token with every request; what
  waits for that participant's approvers, to approve or reject as the acting
  operator; and its audit log, newest first, with the service's check of the
  whole hash chain, which names the first entry that was edited or whose
  predecessor was deleted.
- Operator actions, each sent to the acting participant's own service: a
  bank funds or redeems wholesale tokens, tokenizes a customer's deposit or
  returns it, and sends a customer's payment, into another currency at the
  dealer's quote where the payee banks in one (§13); as a bond's agent it issues
  and pays the next coupon or redemption; as a buyer it affirms an issue or
  a trade under a UETR, which the agent or seller then uses (§5.4, §5.5); in
  a repo, it affirms or opens one, calls or meets a margin, affirms or makes
  a substitution, closes, or passes on a coupon (§5.7 to §5.10), beside each
  repo's terms, collateral record, history and calls.
  The console decides nothing: it shows what the service accepted, with
  the instruction to follow, or why it refused.
- Who sees what (§10), on its own page, read from what
  `pnpm confidential:compare` measured: for the same payment in the baseline
  and confidential modes, what each participant could read, cell by cell,
  with where the evidence came from or why it is hidden.
- Interop runs (§7), on their own page, read from what `pnpm interop`
  saved: every coordinator under every fault with its outcome and how long
  the ledgers disagreed, and each case's timeline, a lane per part showing
  its state over time on its ledger, the window in which the ledgers
  disagreed shaded across them, and the parties' narrative beside it.
- Fault controls for the simulation harness (§9), on its own page: each
  fault with what it does and what must hold through it, seeded random
  flows with faults mixed in, the whole-run checks on demand, every step,
  and whether every invariant has held so far.

## 5. Scenarios and flows

### Scenarios

A scenario is a folder under `scenarios/` that the engine loads; the engine
reads nothing currency- or country-specific from anywhere else.

```
scenarios/<id>/
  scenario.yaml     currencies (ISO 4217), time zone, business-day calendar,
                    participants (each central bank's currency, each bank's
                    reserve currencies), validators, instruments, each in its
                    currency, and terms; with two currencies, the FX dealer
                    and its rates; with repo, its day count, the bonds it
                    accepts as collateral and how long a margin call may
                    stay unmet
  accounts.yaml     each participant's chart of accounts and opening balances
  operators.yaml    each participant's operators, their roles and its approval
                    policy (§15); without it, each participant has one operator
                    holding every role and a policy that asks for nothing more
  README.md         what the scenario shows and which public source it follows
```

The flows are §5's, driven over the services' APIs by `sim/src/e2e.ts`;
`pnpm demo <id>` runs them (§9).

The repository ships four:

- **`ca-interbank`**: flows 5.1 to 5.3 in CAD with the Central Bank and
  Banks A to C. Follows the Agorá settlement model on one ledger, in one
  currency, and the six banks' stated first phase: tokenized deposits moving
  across institutions.
- **`ca-bond-dvp`**: flows 5.4 to 5.6, a Samara-style bond issued through
  Bank C and settled in wCAD, under ERC-3643, with Bank A holding part of it
  for two clients in custody (§15).
- **`ca-us-pvp`**: cross-border payments in CAD and USD, with two central
  banks on the same ledger and a dealer bank holding reserves in both (§13).
- **`ca-repo`**: interbank repo against a tokenized bond: open, margin,
  substitution and close, each one atomic instruction (flows 5.7 to 5.10).

The yen test fixture `jp-interbank` (§1) shows that the engine hard-codes no
currency and no participant count.

A scenario is the extension point for contributors: a different currency, a
different number of banks, a different bond.

### Flows

Every flow states what happens on-ledger and what each party posts. All
on-ledger legs of a flow commit in one transaction or none do. Amounts are
from the Canadian scenarios.

### 5.1 Fund wCAD from reserves

Bank A moves $10,000,000 of reserves into tokenized form.

| Where | Effect |
| --- | --- |
| RTGS sim | Bank A settlement account −10,000,000.00 |
| Ledger | `wCAD` mint 10,000,000.00 to Bank A |
| Central Bank books | Dr Bank A settlement account / Cr wCAD outstanding (Bank A) |
| Bank A books | Dr wCAD reserves / Cr RTGS reserves |

Redemption is the reverse.

### 5.2 Tokenize a customer deposit

A Bank A customer tokenizes $5,000 of an ordinary deposit.

| Where | Effect |
| --- | --- |
| Bank A books | Dr Customer DDA / Cr Tokenized deposits (customer) |
| Ledger | `dCAD-A` mint 5,000.00 to the customer's address |

Bank A's total deposit liabilities do not change: value moves between two
liability accounts. Detokenizing is the reverse.

### 5.3 Interbank transfer (the Agorá pattern, in CAD)

A Bank A customer pays a Bank B customer $2,500 in deposit tokens. One
instruction, three legs:

1. burn 2,500.00 `dCAD-A` from the payer;
2. transfer 2,500.00 `wCAD` from Bank A to Bank B;
3. mint 2,500.00 `dCAD-B` to the payee.

Bank A submits the instruction; its approval covers the burn and the wCAD
leg. Bank B co-signs it, because the mint creates Bank B's liability and no
bank's liability is created without its consent. The mint also passes the
ERC-7943 check only if the payee is on Bank B's allowlist; if any leg fails,
the whole instruction reverts.

| Where | Posting |
| --- | --- |
| Bank A books | Dr Tokenized deposits (payer) / Cr wCAD reserves |
| Bank B books | Dr wCAD reserves / Cr Tokenized deposits (payee) |
| Central Bank books | Dr wCAD outstanding (Bank A) / Cr wCAD outstanding (Bank B) |

No state exists in which the payer was debited and the payee not credited,
or deposits moved without reserves: that is the property the unified ledger
exists to give.

### 5.4 Bond issuance (the Samara pattern)

The Issuer issues a $100,000,000 bond through Bank C as issuing and paying
agent. Bank A and Bank B buy at issue. One instruction, submitted by Bank C
and co-signed by each buyer, whose wholesale tokens it moves. A buyer
co-signs only if its own operator affirmed the purchase first, under the
same UETR, bond, price and units: settlement instruction matching, so what a
bank pays is never decided by its counterparty alone. The paying agent may
not hold the bond it pays.

1. `Bond` mint to Bank A and Bank B in their allocated units;
2. `wCAD` transfer from Bank A and Bank B to Bank C for the price.

Bank C credits the proceeds to the Issuer's deposit in its own books.

| Where | Posting |
| --- | --- |
| Bank A, Bank B books | Dr Bond holdings (at face) / Cr wCAD reserves (the price) / the difference to gains on securities |
| Bank C books | Dr wCAD reserves / Cr Issuer deposit |
| Central Bank books | Dr wCAD outstanding (A, B) / Cr wCAD outstanding (C) |

Holdings are carried at face value, so they reconcile exactly with units on
chain times face (invariant 10). What a bank pays above or below face is a
gain or loss on securities at once: the sandbox does not amortize premiums
and discounts.

### 5.5 Secondary trade, delivery versus payment

Bank A sells bond units to Bank B. One instruction, submitted by the seller
and co-signed by the buyer once its operator has affirmed the same trade
(its `sese.023` receive instruction, §8):
bond units A→B, `wCAD` B→A. If either leg fails (Bank B lacks wCAD, Bank A
lacks units, a party is frozen) neither happens.

### 5.6 Coupon and redemption

Coupon periods roll back from maturity in steps of 12 / frequency months;
payment dates move to the following business day in the scenario's
calendar, and the record date is the bond's record days earlier. For each
payment Bank C, as paying agent, closes the register at a block, debits the
Issuer's deposit for the coupon on all outstanding units (rounded once), and
pays each holder bank its own coupon (rounded once, by the rule in the
terms) in `wCAD`, all in one instruction. The difference between what the
Issuer paid and what holders received goes to the rounding residual account:
shown, never dropped (invariant 8).

Each holder co-signs the instruction only after recomputing its own amount
from the terms and its `balanceOfAt` the record block, and checking it has
not been paid that period, so a holder never books a coupon it did not
compute itself. The agent plans a payment from the same checkpoints and
refuses one whose register does not add up to the supply. It pays from its
own wholesale tokens, so it funds them from its RTGS account (§5.1) when the
issue proceeds no longer cover a payment. Redemption at maturity pays face
plus the final coupon and burns the units in the same instruction; burning a
holder's units needs that holder's approval, which its co-signature gives.

The sandbox cannot wait years for payment dates, so the agent runs each
scheduled payment on command and closes the register at the block where it
does. The schedule, day counts and rounding are exact; only the waiting is
compressed.

### 5.7 Repo: open

In `ca-repo`, Bank A lends `wCAD` to Bank B overnight or for a term against
bond collateral, as a repurchase agreement. The terms both sides agree:
collateral bond and units, purchase price, repo rate, start and end dates,
haircut, and the day count (ACT/365F, the scenario's convention). Each side
affirms the same repo under one UETR, as for a trade (§5.5): the lender's
operator affirms the terms, and the borrower's opens the repo under the same
UETR, which names the repo from then on. One instruction settles the start
leg: bond units B→A, purchase price in `wCAD` A→B. The borrower submits it
and the lender co-signs only what it affirmed, and only if the units at the
agreed mark, after the haircut, cover the purchase price.

Title moves on chain, but the economics stay with the borrower, so neither
bank's books treat the collateral as a sale:
- Bank A books the cash it lent as a reverse-repo receivable, and the units
  it received in `collateral-received/<bond>`, apart from the bonds it owns;
- Bank B books the cash as a repo liability, keeps the units in its bond
  holdings, and records them in `collateral-pledged/<bond>`.

Each pair is a memorandum pair, at face, off the balance sheet:
`collateral-received/<bond>` against `collateral-to-return/<bond>` at the
lender, `collateral-pledged/<bond>` against `collateral-to-recover/<bond>` at
the borrower. Each bank's reconciler checks its on-chain balance of the bond
against owned plus received, minus pledged, at face (invariant 10), and its
listener matches a settlement's collateral lines against that one balance.
Each bank also keeps the repo's record (its terms, the collateral the lender
holds, and its history by block), updated in the same transaction in which
the listener posts each repo settlement.

A bank delivers only units it owns and has not pledged: it may not sell or
pledge again what it pledged, nor what it holds as a lender's collateral
(the sandbox does not re-use collateral). A bond is not redeemed while units
of it are repo collateral: each holder refuses to co-sign the redemption.

### 5.8 Repo: margin

Either side may revalue the collateral at a mark both affirm. If the
collateral's value at the mark, after the haircut, falls short of the cash
lent plus interest accrued so far, Bank B delivers the extra units (one
leg, co-signed by Bank A); if it exceeds it, Bank A returns the excess. A
margin call that is not met by the agreed deadline is shown as overdue on
both sides; default management is outside the sandbox (rulebook §16).

The side that receives units calls the margin: it affirms the marks, the
date the interest is accrued to and the bond the margin moves in, and tells
the other side, which records the call with its due time (the scenario's
`marginCallSeconds` of block time). A shortfall calls the fewest units of
that bond that cover the exposure again; an excess, the most the lender can
return while the rest still covers it, and nothing if that is less than a
unit. The other side delivers only against a call it heard of, and only
what it computes itself from the same marks and its own record. A call is
open, overdue once block time passes its due time unmet, or met once its
delivery settles; a late delivery still settles and meets it.

### 5.9 Repo: substitution

Bank B may swap the collateral for another bond the repo accepts, at
current marks: one instruction returns the old units A→B and delivers the
new units B→A, so Bank A is never left uncollateralized between the two.
The lender affirms the substitution at the marks; the incoming units are
the fewest whose value at the marks is at least the outgoing units' value
(the haircut is the repo's, the same for every bond it accepts).

### 5.10 Repo: close

At the end date (run on command, as coupons are), one instruction returns
every collateral unit A→B and pays the purchase price plus repo interest
B→A in `wCAD`. Interest is the purchase price times the repo rate times the
days held over 365, rounded once, half-even. Both banks clear their repo
balances and collateral records in the same block. The borrower submits the
close; the lender checks it against its own record (every unit it holds,
the purchase price, the interest for the term) and co-signs, needing no
affirmation, as a holder co-signs a coupon (§5.6).

A coupon paid on collateral during the repo goes to the holder on chain,
Bank A, which owes it on to Bank B as a manufactured payment: one `wCAD`
leg, settled with the coupon's record block as its reference. Bank A's
operator starts it once the coupon settles: the coupon on the units the
repo's record shows at the coupon's record block, rounded once by the
bond's rule, at most once per repo, bond and period; Bank B checks the same
from its own record and co-signs. Bank A books it as manufactured payments,
an expense against the coupon it received; Bank B as interest income.

## 6. Invariants

Checked by Foundry invariant tests, by property tests on the services, and by
the reconciler on every committed block of a running system.

1. **Balanced entries**: every journal entry in every core ledger sums to
   zero.
2. **wCAD backing**: `wCAD` total supply equals the Central Bank's wCAD
   outstanding liability, and each bank's `wCAD` balance equals both its
   line at the Central Bank and its own `wCAD reserves` asset.
3. **Deposit-token backing**: for each bank, `dCAD` total supply equals the
   `Tokenized deposits` sub-ledger, and each holder's token balance equals
   that holder's sub-ledger account.
4. **Liability conservation**: tokenizing or detokenizing never changes a
   bank's total deposit liabilities.
5. **Atomicity**: no committed block contains a partial instruction.
6. **Exactly once**: an instruction id settles at most once, however often it
   is submitted.
7. **Eligibility**: no committed transfer lands on an address not allowed by
   the token's ERC-7943 check, no bond lands on an address without a verified
   identity in the bond's ERC-3643 identity registry, and no frozen balance
   moves except by forced transfer.
8. **Coupon completeness**: total coupon paid plus the residual equals the
   Issuer's debit, to the minor unit.
9. **Authority**: no leg settles without the approval of the participant
   whose account it debits or whose liability it creates.
10. **Securities backing**: each bank's units of each bond on chain, at face,
    equal its holding, plus collateral it received, minus collateral it
    pledged.
11. **FX consistency**: in each cross-currency instruction (§13), the amount
    in each currency is exactly the one the dealer signed: the source amount
    times the quoted rate, rounded once, half-even, in the target currency's
    minor unit.
12. **Policy before signature**: no flow is signed or sent unless the
    approvals its participant's policy requires were recorded first, by
    operators other than its initiator (§15).
13. **Custody positions**: the client positions recorded for each omnibus
    custody address sum, per instrument, to that address's balance on chain
    (§15).
14. **Repo collateral**: after every repo settlement, the units Bank A holds
    as collateral for each open repo are exactly the repo's record, and after
    a margin settlement their value at the agreed mark, after the haircut,
    covers the cash lent plus interest accrued; a substitution brings in at
    least the value it takes out, at its marks; a close repays exactly
    principal plus interest.

In a scenario with two currencies, invariants 1 to 4 hold in each currency
separately.

## 7. Interop mode

The same interbank transfer when Bank B's deposit token lives on a second,
separate Besu network. Ledger 1 holds the payer's burn and the wholesale
transfer from Bank A to Bank B; ledger 2 holds the mint of the payee's
deposit. Each ledger runs a `ConditionalSettlement` (§4.2), and each part is
locked and settled there under the instruction's UETR. Three coordinators
behind one interface:

- **Unified**: all three legs on the shared ledger, settled in one
  transaction, as in §5.3. The baseline.
- **HTLC**: Bank A, which knows the secret, locks ledger 1's part under its
  sha256 hash with the longer timeout; Bank B locks ledger 2's part under the
  same hash with a shorter one. Bank A claims on ledger 2 with the secret,
  crediting the payee and publishing the secret; Bank B claims on ledger 1
  with it. If Bank B is not back before ledger 1's timeout, Bank A refunds
  ledger 1: the payee was credited and Bank B never paid.
- **Notary two-phase commit**: a notary has both banks lock their parts
  naming it, then commits both, one ledger after the other, or aborts both
  if a lock fails. If it crashes between the commits and is not back before
  the second part's timeout, that part is refunded: Bank B was paid and the
  payee never credited.

Ledger 2 is the scenario's `interop` block: in `ca-interbank`, one
validator run by Bank B (QBFT still finalizes at once; the windows do not
depend on how many validators it has), Bank B's `dCAD-B` with the same
customers allowlisted, its own registry kept by the central bank, and the
notary, which may send transactions on both. Ledger 1 keeps its own `dCAD-B`
for the unified baseline. `pnpm interop:smoke` settles one transfer across
the two by hashlock and one by notary.

The contract tests reproduce each window (`ConditionalSettlement.t.sol`).
Interop runs measure the legs on both ledgers, not the banks' books: the
participant runtime follows one ledger, and what the mode shows is whether
the two ledgers end the same way, and when.

`pnpm interop` (`services/coordinator`) runs each coordinator under each
fault: coordinator crash between phases, message loss, a participant offline
past a timeout, timeouts racing a late commit. The ledgers are real; a fault
is a party doing, at one step, what a crash, a lost message, an outage or a
slow commit would make it do. Off-ledger messages between parties (the
payment message carrying the hashlock, a request for a signature, the
notary's commit) go through a mailbox that a fault can drop. The notary logs
each decision before acting on it, and a restarted notary finishes what its
log says it decided, for whatever parts are still locked. Each bank refunds
its own lock once past its timeout, unless it is the one offline.

Each run records every part's state on its ledger over time (none, locked,
settled, released), with the block and the ledger's clock, and ends
committed (every part settled), aborted (none did), inconsistent (one did and
another was released) or stuck (a part still locked). It measures how long
one part had settled while another had not: the window in which the two
ledgers disagreed. Every case must end as below, or the run fails:

| Fault | Unified | HTLC | Notary 2PC |
| --- | --- | --- | --- |
| none | committed | committed (claims ~1s apart) | committed (commits ~1s apart) |
| coordinator crash | committed (sent on restart) | aborted (secret holder crashed before revealing; both refund) | **inconsistent** (crashed between commits, back after the timeout) |
| message loss | committed (asked again) | aborted (Bank B never heard; Bank A refunds) | committed (commit resent; window ~9s) |
| participant offline | aborted (no signature by the deadline) | **inconsistent** (Bank B back after ledger 1's timeout) | aborted (Bank B never locked) |
| late commit | aborted (past the deadline, refused whole) | **inconsistent** (claim lands after the timeout) | **inconsistent** (commit lands after the timeout) |

The unified mode never leaves the ledgers disagreeing: one transaction
settles every leg or none. Each cross-ledger mode has a window, and a fault
that holds it open past a timeout leaves the two ledgers permanently
disagreeing. The console draws each run (§4.6); the design note explains the
result against the Agorá report.

## 8. ISO 20022 mapping

| Movement | Message | Version |
| --- | --- | --- |
| Customer deposit transfer (§5.3) | `pacs.008` FI-to-FI customer credit transfer | 001.08 |
| Interbank wCAD leg | `pacs.009` FI credit transfer, as a cover payment | 001.08 |
| Customer transfer across currencies (§13) | `pacs.008` with the instructed amount, the settlement amount and the exchange rate | 001.08 |
| Each currency's wholesale leg of it | `pacs.009` cover, one per currency | 001.08 |
| Instruction outcome | `pacs.002` payment status report | 001.10 |
| Credits and debits to an account | `camt.054` notification | 001.08 |
| Account statement | `camt.053` statement | 001.08 |
| Bond DvP instruction and confirmation | `sese.023` / `sese.025` | 001.13 |
| Repo legs: open, margin, substitution, close (§5.7 to §5.10) | `sese.023` / `sese.025` | 001.13 |
| Manufactured payment (§5.10) | `pacs.009` FI credit transfer, and its `pacs.002` | 001.08, 001.10 |

`pacs.008`, `pacs.009` and `camt.053` are at the versions in Payments
Canada's Lynx portfolio and SWIFT's CBPR+. Lynx lists `pacs.002.001.10` as
being considered for future implementation; `camt.054.001.08` is the version
in Payments Canada's corporate-to-bank guidelines. `sese.023` and `sese.025`
are at version 13, whose schemas define elements for blockchain addresses
and digital payment settlement. Sources: [docs/design.md](docs/design.md) §3.13.

The UETR in the message is the instruction id on-ledger, so a message and its
settlement can be matched in either direction. The wholesale leg's
`pacs.009` carries the customer payment's UETR and the payment itself in
`UndrlygCstmrCdtTrf`, as a CBPR+ cover payment does: one UETR names the
whole atomic instruction. Across currencies (§13) the `pacs.008` states the
amount instructed in the payer's currency (`InstdAmt`), the amount settled
in the payee's (`IntrBkSttlmAmt`) and the dealer's rate (`XchgRate`; a rate
the element cannot hold is refused, never rounded), and each wholesale
leg has its own `pacs.009` under the same UETR, named by its currency. The
dealer serves both covers, each customer's bank the `pacs.008`, its own
cover and the `pacs.002`.

How the sandbox appears in the messages:

- a bank has no BIC; it is a member of the proprietary clearing system
  `OUL` (`ClrSysMmbId`), identified by its participant id;
- an account is identified by its id in the servicing bank's books (at most
  34 characters), and the on-chain address it mirrors travels as the
  account's proxy (`Prxy`), of proprietary type `EVM`;
- settlement is by clearing (`SttlmMtd CLRG`) through `OUL`;
- `pacs.002` reports `ACSC` with the settling block, or `RJCT` with the
  engine's reason (`ERC20InsufficientUnfrozenBalance`, an expired deadline);
- `camt` entries carry their journal entry's reference, the block, and a
  proprietary bank transaction code naming the flow (`FUND`, `TOKENIZE`,
  `INTERBANK`, `PVP`, `COUPON`, `REDEMPTION`);
- bonds settle by `sese.023` from each side, delivering (`DELI`) or receiving
  (`RECE`) against payment (`APMT`), with transaction type `ISSU`, `TRAD`
  or `REDM`. The two instructions match on the common reference `CmonId`,
  which is the UETR: a buyer's affirmation (§5.4, §5.5) is its `RECE`
  instruction. `sese.025` confirms the settlement to each side with the
  block. Version 13 carries the holders' on-chain addresses
  (`BlckChainAdrOrWllt`) and declares the cash leg as a quantity of the
  wholesale token (`DgtlPmtSttlm`). A bond has no ISIN here; it is a
  proprietary identifier of `OUL`;
- a coupon or redemption is a `camt.054` credit to each holder's wholesale
  account and a debit to the issuer's deposit, and a redemption also a
  `sese.025` confirming each holder's units delivered back;
- units held in custody (§15) are safekept in the custodian's account
  `custody/<bond>`, at the omnibus wallet's address, in `sese.023` and
  `sese.025`; a coupon or redemption on them is also a `camt.054` credit to
  each client's deposit, for its share;
- each repo leg (§5.7 to §5.10) is a `sese.023` from each side and, once
  settled, a `sese.025`, naming its repo by the opening's UETR as the
  collateral transaction id (`CollTxId`). The open and the close settle
  against payment, typed repo (`REPU`) from the borrower's side and reverse
  repo (`RVPO`) from the lender's, and the close is also marked as the
  return leg (`RtrLeg`, which `sese.025` does not carry). A margin or a
  substitution settles free of payment (`FREE`), typed collateral out
  (`COLO`) from the borrower's side and collateral in (`COLI`) from the
  lender's; a margin's repurchase type is top-up (`TOPU`) or withdrawal
  (`WTHD`). The borrower's units stay in its `bond-holdings/<bond>` account;
  the lender safekeeps what it holds in `collateral/<bond>`. A manufactured
  payment is a `pacs.009` from the lender to the borrower, its `pacs.002`,
  and a `camt.054` to each side's wholesale account. The `camt` codes are
  `REPO`, `REPO-MARGIN`, `REPO-SUBSTITUTION`, `REPO-CLOSE` and
  `MANUFACTURED`. The repo's own terms (rate, haircut, end date) belong to a
  securities financing message (`sese.033`), whose schema is not among those
  vendored, so the sandbox writes none: each bank keeps the terms in its
  record.

Each participant serves, for each of its instructions, the messages that
concern it, built from its own instruction row and journal: a payer's bank
the `pacs.008`, the `pacs.009` cover, the `pacs.002` and its customer's
`camt.054`; a bond buyer its own `sese.023` receive instruction and, once
settled, its `sese.025`; a pending instruction a `PDNG` status and pending
entries; a refused one a `pacs.002` `RJCT` with the engine's reason and no
notifications, since nothing was booked. Statements are built from the
journal: the balances as of the period's two instants and the posted
movements between them, each with the code of the flow it came from.

`packages/iso20022` builds and reads these messages and validates them
against the official XSDs (committed in `schemas/`, with their source and
the terms they are used under). `fixtures/` holds an example of every
message for every flow; the tests check each is what the builders produce
and valid against its schema.

## 9. Simulation harness

`pnpm sim <scenario> --seed <n> --steps <n>` (in `sim/`):

- Deploys the scenario afresh on the running network, so a seed always
  starts from the same state, and starts every participant's service as its
  own process, with short deadlines so refused instructions expire within a
  run.
- Runs a seeded random sequence of flows through the services' HTTP APIs:
  funding and redemption in each currency a bank holds, tokenizing,
  detokenizing, interbank payments, payments into another currency through
  the dealer, and payments for more than the payer holds, which must be
  refused. In a scenario with repo, after a prelude in which the banks that
  may lend and borrow buy the collateral bonds at issue, it also opens repos
  between them, margins them at random marks, substitutes and closes them.
  The generator's model keeps each bank's balances per currency and prices a
  payment across currencies from the scenario's rates itself, so a quote
  that differs from its own price fails the run. Actions run one at a time
  and each waits for its outcome, so the model knows every balance and never
  reads live state: the same seed produces the same actions, and a failing
  run prints the command that reproduces it.
- Checks the invariants from outside the services, reading each
  participant's books from Postgres and the chain from a node:
  - at every block, once every participant has processed it: books balance
    (1), no reconciliation run ever failed (2, 3, 8, 10, 12, 13, 14), no
    listener break (5, 7), and each central bank's line for each bank equals
    that bank's reserves in its currency at that block (2);
  - over the whole run: deposits moved only by settled payments, and at a
    bond's agent also by its issuer's proceeds and payments (4); every
    settled instruction is posted at its block and every refused one voided
    with nothing on chain (5); each instruction settled exactly once (6);
    every holder eligible (7); every settlement sent by the participant that
    recorded itself as its submitter (9); every payment across currencies
    moved on chain exactly its quote's amounts, the target the source at the
    quoted rate, rounded once (11); every repo, replayed from the borrower's
    settled flows, moved on chain exactly its collateral and cash, every
    margin left it covered at its marks and every close repaid principal
    plus interest (14); and every participant's audit log, read from its
    schema, verifies as a chain and shows nothing released or submitted
    before its policy's approvals (12).
- Flows come from operators as the console's would (§15): each is started by
  the participant's first operator holding the `operator` role, and whatever
  its policy holds for approval is approved by the next operators allowed to,
  at the participant that started it and, for funding, at the central bank.
  A service reconciles at the end of each listener tick, which may span
  several blocks: the per-block checks cover every block, and each service's
  reconciliation covers the blocks its ticks ended on.
- Faults (`sim/src/harness/faults.ts`), each checking the outcome it
  expects while the invariant checks run underneath:
  - **validator down**: one bank's Besu node stopped (QBFT tolerates one in
    four), flows settle among the other banks, the node restarts and
    resyncs;
  - **service crash**: a payment accepted, then the payer's or payee's
    service killed with SIGKILL and restarted; it settles exactly once;
  - **listener behind**: a service stopped (often the central bank, whose
    books follow the chain) while flows settle, then restarted; it catches
    up and reconciles;
  - **duplicate submission**: the same payment requested three times at
    once (one instruction), then resubmitted on chain after it settled
    (`AlreadySettled`);
  - **stale signature**: submitted on chain with an approval for other legs
    (`InvalidApproval`) and past its deadline (`InstructionExpired`);
  - **frozen counterparty**: the payer's bank freezes its customer's tokens
    on chain behind its own books; the engine refuses the payment, the
    payer's entry is voided with a `pacs.002` `RJCT`, the payee's side
    expires.
- `pnpm sim <scenario> --serve` keeps a run open for the console: it deploys
  and starts the services as a run does, checks every block as it commits,
  and takes work over HTTP on port 7099, one job at a time (`GET /status`,
  `POST /steps`, `POST /faults/:kind`, `POST /check`). Before each job it
  re-reads every bank's balances from its service, so flows an operator
  starts from the console do not leave the model behind; a served run's
  seed fixes its choices, not the balances it starts from.
- `pnpm sim <scenario> --script faults` runs every fault once after a short
  prelude (with repo, a repo opened before the faults and closed after
  them); `--faults <rate>` mixes them into a seeded run. A fault with
  nothing to act on yet is skipped, deterministically, so seeds with faults
  reproduce too.
- `pnpm sim:seeds <scenario> --from 1 --to 1000 --steps 20 --faults 0.25`
  runs seed after seed, one at a time on the one network (about a minute
  and a half each, most of it faults), and appends each result to
  `sim/runs/seeds/<scenario>.jsonl`: the seed, the settings, the code it ran
  against (the commit, and the paths of any uncommitted changes), the
  outcome, the counts, how long it took, and the command that reproduces it.
  It skips seeds already recorded with the same settings against the same
  code, so a stopped batch resumes where it left off and new code runs its
  seeds afresh, and it stops at the first failure unless told to keep going.
  The summary groups results by code version, so seeds run against older
  code never count toward a claim about newer code. Before each seed the
  network must be producing blocks and Postgres must answer; if not, the
  batch stops without recording anything, since a seed that could not run
  proves nothing either way. `--summary` prints how many seeds have run and
  held. The repository claims only the seeds its records show.
- `pnpm demo <scenario>` (`sim/src/demo.ts`) is the one command for a
  reader: it starts Postgres and the network if they are not running
  (generating the network for the scenario's validators), deploys the
  scenario afresh, runs every one of its flows with their checks
  (`sim/src/e2e.ts`: §5's flows over the services' APIs, the invariants at
  every participant, every ISO 20022 message against the XSDs, and a
  deliberately corrupted journal entry, which must show up as a break at the
  next block), and leaves the services and the console running to explore.
  `pnpm demo all` runs every scenario in turn.
- A run never leaves services behind. Every service a run starts is stopped
  however the run ends: at its end, on a failure or a thrown error, on
  SIGINT, SIGTERM or SIGHUP; and each seed of a batch runs in a process group
  of its own, which the batch sweeps when the seed ends, recording whether
  anything was still running. A service restarted by a fault has three
  minutes to answer again, and one that does not is reported with what it
  last logged. Two processes opening the same participant's books at once
  (a service and the checker, on a fresh deployment) migrate them once:
  migrations run under an advisory lock on the schema.

## 10. Confidentiality

On a plain shared EVM ledger every validator sees every balance. That is the
baseline mode, and the design note states it plainly. A confidential mode
uses Paladin (https://github.com/LFDT-Paladin/paladin, v1.0.0) on the same
Besu network: deposit tokens as Noto tokens notarized by their issuing bank,
so only the parties to a transfer see it. The two modes run the same
scenarios and the console shows what each participant can see in each.

**Nodes.** Each bank runs a Paladin node beside its Besu validator, attached
to it over JSON-RPC and WebSocket. Paladin supports Kubernetes only; here
each node runs the release image (`ghcr.io/lfdt-paladin/paladin:v1.0.0`) in
Docker Compose with the configuration Paladin's operator would render: one
JVM, an embedded SQLite database, and gRPC transport between nodes with
mutual TLS over self-signed certificates, each node's certificate published
in the registry and checked against it. A node uses about 180 MB.

**Base contracts**, deployed by the central bank: Paladin's
`IdentityRegistry`, rooted at the central bank, which registers each bank's
node as it registers participants on the scenario's own registry; the Noto
implementation; and the `NotoFactory` behind an ERC-1967 proxy. The Paladin
artifacts are vendored unchanged from the release
(`packages/chain/vendor/paladin-v1.0.0`).

**Keys.** Paladin signs base-ledger transactions with keys it derives from
each node's seed: the node's registry key, its notary key, and a submission
key for the Noto domain, fixed because Paladin otherwise uses a new one each
time. Besu's permissioning API (`PERM`) adds them to every
validator's account allowlist once the nodes report them.

**Tokens.** Each bank's deposit token is a Noto token in basic mode,
notarized by the bank (`notary@bank-a`): the notary validates and submits
every mint, transfer and burn. A customer holds unspent states under a key
its bank's node derives for it (`northwind-freight@bank-a`).

**Who sees what.**
- The issuing bank's node holds its customers' states and so their balances.
- Another bank's node holds none of them.
- Every validator sees state hashes, the notary's signature, and the
  notary's address as the sender; no customer key and no amount.

`pnpm confidential:smoke` proves each of these on the running nodes, and that
one bank's node reaches another's over the mutual-TLS channel.

**Payments.** An interbank payment burns the payer's Noto deposit and mints
the payee's, with wholesale moving between the banks on the shared ledger.
Paladin's own swap contract (`Atom`) calls an ERC-20 `transferFrom`, which
wCAD forbids by design (§4.2), and cannot cancel a Noto lock it holds if the
other leg never succeeds. So the sandbox settles through its own contract,
`ConfidentialSettlement`:

1. The payer's bank locks a burn of its customer's Noto deposit on its own
   node (`createBurnLock`); the payee's bank, as notary, locks a mint of its
   customer's (`createMintLock`). Each lock's Paladin domain receipt gives
   the arguments that spend or cancel it, which Noto checks against
   commitments it recorded.
2. Each bank delegates its lock to `ConfidentialSettlement`.
3. The payee's bank signs the payment (EIP-712, over its id, wholesale legs,
   locks with the hashes of their spend arguments, and deadline): the mint
   creates its liability (rulebook §4.3).
4. The payer's bank settles: one transaction moves wholesale, authorized as
   the engine authorizes it (`LegAuthority`), and spends both locks, or
   reverts and does none of it.

A bank may cancel a lock on its own deposit token that it delegated, while
the payment is unsettled; that only aborts the payment, and returns what the
lock held. The central bank lists each Noto token with its bank, as it lists
the tokens the engine may move. No private state crosses between banks: each
lock lives on its own bank's node. The wholesale leg stays public among
validators, as Agorá's interbank legs were visible to the parties that
settled them.

`pnpm confidential:pay` settles one such payment and checks every leg moved
exactly the amount, and that the payee's bank still holds nothing of the
payer's balance; then a second payment whose payee bank cancels, which moves
nothing. `ConfidentialSettlement.t.sol` covers its rules against a stand-in
for Noto's lock interface.

**Who sees what, measured.** `pnpm confidential:compare` makes the same
interbank payment in each mode (in the baseline, three legs through the
engine on plain deposit tokens) and asks each participant what it can
actually read: every validator by decoding the shared-ledger transaction and
reading public balances, each bank through its own Paladin node, the central
bank through its validator alone. The console's "Who sees what" page draws
the two results side by side:

| Participant | Baseline | Confidential |
| --- | --- | --- |
| Every validator, the central bank | payer, payee, amount, wholesale, both balances | amount (from the wholesale leg), wholesale |
| The payer's bank | everything | its payer and the payer's balance, amount, wholesale |
| The payee's bank | everything | its payee and the payee's balance, amount, wholesale |
| A bank not party to it | everything | amount, wholesale |

The amount stays visible because the wholesale leg moves the same amount in
the clear; hiding it too would take the wholesale leg private as well, which
this sandbox does not do.

## 11. Money and numbers

- Cash is held as integer minor units: `uint256` on-ledger, `bigint` in
  TypeScript, `bigint` in Postgres. Never a JavaScript `number`. Every amount
  carries its currency code.
- Interest and coupons are computed with decimal.js over strings and rounded
  once, to the minor unit, by a stated rule. Every rounding difference lands
  in a residual account.
- Rates are stored as decimal strings with their basis (annual, day count).
- Times are UTC instants; payment dates are dates in the scenario's time zone
  (`America/Toronto` for the Canadian scenarios) and business-day calendar.

## 12. Repository layout

```
contracts/            Foundry: registry, tokens, bond, settlement engine, conditional and
                      confidential settlement; invariant tests
packages/
  domain/             money (bigint minor units, decimal.js), currencies, charts of accounts,
                      posting templates for §5, instruction model
  scenario/           scenario loader and validation
  ledger/             the double-entry core ledger: SQL migration holding its rules,
                      Ledger class, model-based property tests
  participant/        the runtime both services share: flows, outbox, submitter,
                      listener, reconciler, expiry sweeper
  iso20022/           message builders and parsers, the official XSDs, validation, fixtures
  chain/              dev keys, generated ABIs, EIP-712 instruction approvals, QBFT
                      network generation (both ledgers), scenario, interop and Paladin
                      deployment, smoke runs, vendored Paladin contracts
  conformance/        the conformance kit (§14): adapter interface, checks, broken engines
  signer/             signer interface; local key and AWS KMS implementations
  service/            what the services share: config, problem details, amounts,
                      HTTP peers, common routes
services/
  bank/               the bank's API over the participant runtime (one process per bank)
  central-bank/       the central bank's API: funding, RTGS settlement accounts, wholesale lines
  coordinator/        interop coordinators (unified, HTLC, notary 2PC), faults, recorder,
                      `pnpm interop`
apps/
  console/            Next.js console
scenarios/
  ca-interbank/       CAD interbank transfers (Agorá model, one currency); interop block
  ca-bond-dvp/        CAD bond issuance, DvP, coupons, redemption (Samara pattern)
  ca-us-pvp/          CAD and USD, two central banks, a dealer: payment versus payment (§13)
  ca-repo/            interbank repo against tokenized bonds (§5.7 to §5.10)
sim/                  service launcher, scenario runner, seeded fault harness, serve mode,
                      seed batches, `pnpm demo`
infra/                Docker Compose: Postgres, the generated Besu QBFT networks
                      (infra/besu/generated, infra/besu/interop), Paladin nodes
                      (infra/paladin/generated)
docs/
  design.md           each component mapped to the public source it follows
  rulebook.md         the sandbox's participation and settlement-finality rules
  sources.md          every document cited, with date and link
  conformance.md      each conformance check, what it proves and needs (§14)
  walkthrough.md      a recorded run of `pnpm demo ca-repo`, followed through the console
  walkthrough/        its screenshots of each console page, and its terminal output
  assets/diagrams/    the README's diagrams, drawn by build.py
  assets/screenshots/ the README's console screenshots, cropped from the walkthrough's
```

Stack: TypeScript in a pnpm workspace, Fastify services, Drizzle over
Postgres, viem, Foundry, Next.js, fast-check, Docker Compose.

License: Apache-2.0, the license of Besu and the LF Decentralized Trust
projects this builds on; its patent grant is what bank and vendor legal teams
look for.

## 13. Cross-border settlement (payment versus payment)

Agorá's scope was cross-border: several central banks, and payment versus
payment between currencies, so that neither side of an FX exchange can
settle without the other. The sandbox settles it on the same engine as
every other flow.

**Scenario `ca-us-pvp`.** Two currencies, CAD and USD, each with its own
fictional central bank (`CAD Central Bank`, `USD Central Bank`) issuing its
own wholesale token (`wCAD`, `wUSD`) on the same ledger. Bank A holds
reserves in CAD and issues `dCAD-A`; Bank B holds reserves in USD and issues
`dUSD-B`; Bank C, the dealer, holds reserves in both and quotes FX.

**One payment, four legs, one transaction.** A Bank A customer pays a Bank B
customer in USD from a CAD deposit:
1. burn the payer's `dCAD-A`;
2. `wCAD` Bank A → Bank C;
3. `wUSD` Bank C → Bank B;
4. mint the payee's `dUSD-B`.

The engine settles them as one instruction: the dealer never delivers
USD without receiving CAD, and no bank's deposit moves without both. Bank C
co-signs because its `wUSD` leaves it; Bank B co-signs because the mint
creates its liability.

**FX quotes.** The payer's bank asks the dealer for a quote: source and
target currency, amount, the rate as a decimal string (`numeric(19,6)`), the
target amount rounded once, half-even, in the target currency's minor unit,
and an expiry. The dealer signs the quote (EIP-712) and keeps it; the
payer's bank checks the signature and the arithmetic and keeps it too, and
pays at it by its id. The scenario's `fx` block names the dealer, the rates
it quotes in each direction and how long a quote holds; the sandbox's rates
are fixed, where a real dealer prices each quote from the market.

The dealer signs the instruction built from its quote, so the rate cannot
change between quote and settlement (invariant 11), and it signs first, so
the payee's bank books nothing for a payment the dealer refuses. It signs
only for a quote it issued, to the bank that asked, unchanged, and each
quote settles at most one instruction. The instruction's deadline is no
later than the quote's expiry, so the engine itself refuses to settle at a
rate past its time; an expired quote is refused before anything is booked.
Every party to the payment, and its reconciler afterwards, checks that what
it booked in each currency is what the dealer signed.

**Two currencies across the system.**
- **Scenarios** (§5) declare `currencies` (one or two). Each central bank,
  wholesale token and deposit token names its currency, and each bank names
  the currencies it holds reserves in.
- **Registry** (§4.2): one shared ledger carries more than one central bank.
  The first central bank listed operates the registry, admits the others
  and cannot suspend them. Each central bank lists its own wholesale token,
  issues it alone, and opens a reserve account on it for each bank that
  holds its currency; `WholesaleToken` takes its issuer as a constructor
  argument.
- **Books** (§4.3) keep accounts per currency. An FX trade at the dealer
  posts to an FX position account in each currency, so every entry balances
  in each currency. Revaluation of open positions is the dealer's own
  business and outside the sandbox.
- **Invariants** (§6): 1 to 4 hold in each currency separately, and 11
  holds for every cross-currency instruction.
- **ISO 20022** (§8): the customer payment is a cross-currency `pacs.008`
  (the instructed amount in CAD, the settlement amount in USD, the exchange
  rate), each wholesale leg its own `pacs.009` carrying the payment's UETR,
  and the status report a `pacs.002`. Statements are per currency.
- **Console** (§4.6): every amount carries its currency, and the dealer's
  view shows its quotes and its position in each currency.
- **Harness** (§9): random payments across currencies through the dealer,
  under the same faults, with the model keeping balances per currency.

**Across two ledgers.** Interop mode (§7) has a cross-currency case: CAD
on ledger 1, USD on ledger 2, the payment split by currency, coordinated by
HTLC or by the notary. Its failure windows are FX settlement risk (one
currency delivered, the other not), the risk payment versus payment exists
to remove, measured beside the unified mode's absence of one.

`ca-us-pvp`'s `interop` block puts USD on ledger 2, which the USD Central
Bank runs: its registry, `wUSD` with reserve accounts for Bank B and the
dealer, a settlement engine to fund them, and `dUSD-B`. Ledger 1's part is
the payer's burn and Bank A's `wCAD` to the dealer, locked by Bank A;
ledger 2's is the dealer's `wUSD` to Bank B and the payee's mint, locked by
the dealer and co-signed by Bank B, since the mint creates its liability.
In an HTLC the dealer is the counterparty that claims ledger 1 with the
secret; under the notary both lock naming it. The same fifteen cases end as
§7 tabulates, and where they end inconsistent the loss falls on one side:
- HTLC, the dealer offline past ledger 1's timeout or its claim late: the
  dealer delivered USD and never received CAD;
- notary crashed between its commits, or its second commit late: the
  dealer received CAD and the payee was never paid USD.

The shared ledger keeps its own `wUSD` and `dUSD-B` for the unified
baseline, four legs in one transaction. `pnpm interop:smoke` is a
one-currency check; `pnpm interop ca-us-pvp --fault none` moves a payment
across currencies by each coordinator.

## 14. Conformance kit

The invariants and the fault harness, packaged as checks any settlement
engine can run against itself: `packages/conformance`.

**The adapter.** An engine under test implements one interface, and
declares the flows and faults it supports and whether it keeps books:
- `reset(scenario)`: a fresh deployment of a scenario the kit supplies,
  returning the directory: the ledgers, every participant's, customer's and
  token's address, and where setup ended;
- `submit(flow)`: start a flow (fund, tokenize, pay, and for engines that
  support them, bond and repo flows) under the id the kit gives it, and wait
  for its outcome: settled, or refused with the reason;
- `observe(ledger, block)`: what a ledger says at a block: each transaction
  that moved a token, with the instruction id it settled, the approvals it
  carried and its movements as ERC-20 transfers report them; then token
  balances and supplies, and whether each holder's issuer admitted it and
  how much of its balance is frozen;
- optionally `books(participant, block)`: what a participant's books say
  each on-ledger balance it mirrors is, the liability it records for each
  token it issues, its deposit total and whether its entries balance, and
  for a bank party to repos, the collateral its record shows for each repo
  open at the block;
- optionally `fault(step)`: the faults the engine can stage (a participant
  down, a duplicate submission, a stale or missing approval, a frozen payer,
  an ineligible payee, or interop mode's faults, §7), each declared or not,
  reporting the flows it ran and anything it sent to the engine around the
  participants.

**The checks** are §6's invariants, stated against the adapter alone:
atomicity, exactly once, authority, eligibility, supply equals liability,
liability conservation, books equal the ledger, FX consistency, repo
collateral. For repo, the kit states exactly the legs a repo's terms fix;
what follows from marks and interest (a margin's units, a substitution's
incoming units, a close's repayment) the engine computes. Repo collateral
judges it from what the ledger moved: the units held as collateral are the
record of what moved under the repo's ids, every margin left the repo
covered, every substitution kept its value, every close repaid principal
plus interest, and, where the engine keeps books, each bank's record of
each open repo (`books(…).repos`) is the ledger's. Each check runs on
scripted flows and on seeded random sequences with the faults the adapter
declares, and reports pass or fail with the seed and the smallest sequence
that reproduces a failure. The scripted run makes payments across
currencies at amounts that land near half a minor unit, where rounding by
any rule but once, half-even, shows; shrinking takes the shortest failing
prefix, then removes steps while the same check still fails, each attempt
on a fresh deployment. `pnpm conformance <scenario>` runs the kit against
the sandbox's own engine: the real contracts and every participant's
runtime, on the network or a fresh Anvil.

**Proof that it catches failures.** A kit that catches nothing proves
nothing, so it ships deliberately broken engines, each a small change to
this sandbox's:
- legs settled in separate transactions (atomicity);
- no once-only check on the instruction id (exactly once);
- a mint accepted without the issuer's approval (authority);
- a transfer to an address the token does not allow (eligibility);
- a payment booked when the chain refused it (books equal the ledger);
- an FX leg rounded twice (FX consistency);
- a repo's interest over a 360-day year (repo collateral).

Each is a contract deployed in place of the real one (`contracts/src/broken`)
or a named defect in the participant runtime, never set outside the kit.
The kit must fail each of them on the check named for it, and pass the real
engine; a broken engine it lets through fails the kit's own tests.
`pnpm conformance <scenario> --engine all` runs the real engine and every
broken one the scenario can show, and says whether each was caught. The
interop coordinators run under it too, and fail atomicity exactly where §7
says they should: an adapter observes both ledgers, where a lock's claim or
commit is the instruction's part on that ledger, and `pnpm conformance
<scenario> --coordinator all` runs each coordinator under each of §7's
faults.

`docs/conformance.md` states each check: what it proves, what the adapter
must expose for it, and what it cannot see (an engine's private state, for
one).

## 15. Custody operations

How a bank operates the system above its keys, with the signers of §4.3 (a
local key, or AWS KMS) and no further key management.

**Approval policies.** Each participant's service holds a policy for every
outgoing flow: by flow kind and amount, how many approvals it needs and from
which roles (`operator`, `approver`, `administrator`). An operator
initiates; the flow waits, pending, until the policy is met; approvers other
than the initiator approve; only then is it signed and sent (invariant 12).
A rejection or an expiry voids its pending entry, as a refused flow does.
Holding the permission is the approval: an initiator whose role alone
satisfies the policy needs no second step.

- A policy is a list of rules in the scenario's `operators.yaml`, each naming
  flow kinds or administrative changes (`administration` names them all), an
  optional threshold `over` in the flow's own currency, how many `approvals`
  it needs, the roles `by` whom, and optionally the roles that may
  `initiate` it. The first rule naming the action whose threshold the amount
  exceeds decides; none matching asks for nothing beyond the initiator's
  role. By default an `operator` or `approver` starts flows and an
  `administrator` starts administrative changes; an approver approves flows
  and an administrator administrative changes, never what it started.
- What is held: an instruction the participant sends (booked pending, status
  `proposed`; once approved, released under a fresh deadline to its
  co-signers and the engine; status `rejected` when an approver refuses it);
  a buyer's affirmation of an issue or trade (§5.4, §5.5), which counts only
  once approved; at a central bank, a bank's request to mint, which is the
  central bank's own outgoing instruction and keeps the deadline the bank
  booked it under; and administrative changes.
- What is not: a co-signature a participant gives when another participant
  asks (§5.3 and on), which is not its outgoing flow; it checks and books what
  it signs as in §4.3, and the log records the signature.
- The loader refuses a policy no operator could satisfy: for every operator
  that may initiate under a rule, enough others must hold the roles it names.

**Operators.** The scenario names each participant's fictional operators and
their roles; in the sandbox an operator is identified by a per-operator
token, which the console sends. A real bank would put its identity provider
here; the policy checks would not change. The token is derived from public
labels (`sha256` of `open-unified-ledger/dev/operator/<participant>/<operator>`),
so it is public and for the sandbox only, as the sandbox's keys are.

**Audit log.** Every initiation, approval, rejection, signature and
submission is appended to a log in the participant's database, each entry
carrying the hash of the one before, so an edited or deleted entry breaks
the chain at that point and shows. The console shows the log and its chain
check.

- An entry is its sequence number, instant, actor (`operator:<id>`,
  `peer:<participant>` for a request another participant sent, or
  `runtime`), action (`initiated`, `approved`, `rejected`, `released`,
  `affirmed`, `changed`, `signed`, `submitted`, `settled`, `refused`,
  `expired`), subject (the UETR, or a change's id) and detail; its hash is
  `sha256` over all of that and the previous entry's hash, as canonical JSON.
- Entries are appended in the same database transaction as the change they
  record, under a lock per schema, so the log and the books never disagree
  about what happened. The table refuses updates and deletes; someone who
  switches that off is still caught by the chain.
- The reconciler proves invariant 12 from the log alone, after every block
  it processes: each subject released, affirmed or changed only after the
  approvals its `initiated` entry says its policy required, each by a
  different operator other than the initiator holding a role the policy
  named; nothing submitted before it was released; and the chain verifies
  from its first entry. The harness checks the same from outside, reading
  each schema directly.

**Client custody.** A bank may hold bonds for its customers in an omnibus
address on chain, recording each client's position in its own sub-ledger.
The reconciler checks that the positions sum to the omnibus balance per
instrument (invariant 13), as it checks deposit tokens. Coupons received on
the omnibus address are allocated to clients by their positions at the
record block, rounded once, with the residual shown.

- The scenario names each custodian and its custody clients (`custody` in
  `scenario.yaml`); in `ca-bond-dvp`, Bank A for two clients. A custodian
  may not be a bond's paying agent.
- The omnibus wallet is a holding address of the custodian in the registry
  (§4.2), so only the custodian's approval moves what it holds, whoever
  submits; it is registered in each bond's identity registry with the
  custodian's identity. Each client has an identity its bank attests (KYC),
  registered at the client's own address: the custodian takes a position
  for a client only while that identity verifies, so a revoked claim stops
  new positions and leaves the client's holding alone.
- The sub-ledger is a memorandum pair in the custodian's books, off its
  balance sheet, at face: `custody-holdings/<bond>`, mirroring the omnibus's
  units on chain, against `custody-positions/<bond>/<client>`. A client's
  purchase and sale settle like any issue or trade, with the client's leg at
  the omnibus wallet (`custody` in an allocation, `buyerCustody` and
  `sellerCustody` in a trade) and the cash from and to the client's deposit.
- The paying agent reads the register from the bond's `Transfer` events: each
  address with units at the record block, as its own entry; one bound to a
  bank other than at its own address is a custody wallet, paid to the bank.
  The custodian co-signs only once its clients' positions at the record
  block add up to the omnibus's units, and books what it received to their
  deposits, each share rounded once by the bond's rule, the difference to
  its rounding residual. At redemption the positions are cancelled with the
  units. Its reconciler checks both halves of invariant 13 after each block.
- A lost omnibus wallet is recovered (`recovery` change): the custodian
  names the next wallet as a management key on its identity, the registry's
  operator binds it to the custodian as a holding address, and each bond's
  agent calls `recoveryAddress`, each under its own policy. The custodian
  watches the new wallet before anything moves, so the recovery, between two
  of its own wallets, books nothing and breaks nothing; once the chain shows
  the units moved, its clients' units go to the new wallet.

**Identity for securities.** Bonds are ERC-3643 tokens (§4.2): each bank
attests its own customers' KYC as claims on their identities, and a bond's
identity registry admits an address only with the claims its claim topics
require. Repo collateral and client custody use the same checks: a bond
reaches an address only if its holder's identity verifies, whoever submits
the movement. Revoking a claim stops the holder receiving the bond, without
touching what it holds.

**Key rotation and recovery.** A participant can move to a new signing key:
the new address is admitted in the registry under the same participant, the
old one retired, both under the policy for administrative changes, and every
token role it held moves with it in one change. For a bond holder that lost
its key, the issuer's agent uses ERC-3643's recovery: the holder's identity
is bound to a new address and its units move there, under the same policy.

- A rotation is an administrative change (`rotate-key`) an administrator
  starts at the participant. Once its policy is met, the runtime derives its
  next key (the sandbox's keys are derived from public labels, one
  generation after another), has its current key consent and the new key
  prove itself over the registry's EIP-712 `KeyRotation` digest, which
  carries a nonce per participant, and asks the registry's operator to admit
  it (`bind-address`). The operator's own policy holds that request; once
  approved, the operator allowlists the new key on every validator (Besu's
  local permissioning) and sends `rotateKey`, which binds the new key and
  retires the old one in one transaction. The participant signs with the new
  key as soon as the registry shows it admitted, and a restarted service
  derives it again. The registry's operator rotates its own key the same
  way, applying it itself.
- The retired key stays bound to the participant as a holding address: its
  balances are still the participant's, moved with the participant's
  approval, so nothing moves on chain to rotate. It no longer submits,
  approves or holds any role. A co-signature it gave before the rotation and
  that has not settled is refused by the engine afterwards; the instruction
  carrying it fails and voids, as any refusal does.
- The sandbox rotates only its derived keys: a participant signing through
  AWS KMS would have to name its new key, which the sandbox does not support.

## Sources

Every public source behind a design choice is numbered in
[docs/sources.md](docs/sources.md) and cited where it applies in
[docs/design.md](docs/design.md). The interop and confidential modes (§7,
§10) build on Paladin: https://github.com/LFDT-Paladin/paladin
