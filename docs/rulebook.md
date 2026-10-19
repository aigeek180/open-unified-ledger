# Sandbox rulebook

The rules the Open Unified Ledger sandbox runs by: who takes part, what an
instruction is, when it is final, and what happens when something goes wrong.

**This is not a legal document.** It binds no one and has no legal effect. A
real settlement system's rules are a contract among its participants and the
operator, backed by law. This rulebook exists to make the sandbox's rules
explicit, so a reader can see where the code enforces each one and what a
real system would have to settle in law. Where code enforces a rule, the rule
names it. Sources are listed in [sources.md](sources.md).

## 1. The system and its operator

1.1 The system is a permissioned shared ledger (Hyperledger Besu, QBFT
consensus) on which the instruments in §3 are issued, held and settled, and
the participants' off-ledger books that mirror it.

1.2 The central bank operates the system. It admits, suspends and reinstates
participants, lists the tokens the settlement engine may move, and issues
and redeems wholesale tokens. Where the ledger carries more than one
currency, each has its own central bank: the first operates the system and
admits the others, and each issues, redeems and lists its own wholesale
token and alone decides which banks hold reserves in it. The operator never
suspends another central bank.
*Code: [`ParticipantRegistry.sol`](../contracts/src/ParticipantRegistry.sol),
[`WholesaleToken.sol`](../contracts/src/WholesaleToken.sol).*

1.3 The central bank and each bank run a validator. The ledger keeps
producing final blocks while no more than one validator in four is faulty or
offline.
*Code: [`genesis.ts`](../packages/chain/src/genesis.ts); fault scenario
"validator down" in [`faults.ts`](../sim/src/harness/faults.ts).*

## 2. Participants

2.1 **Central bank.** Issues wholesale tokens in its currency, which are its
liability to the bank holding them, and opens a reserve account for each
bank that may hold them. Holds no tokens itself.

2.2 **Banks.** Hold wholesale tokens in each currency they hold reserves in.
Each bank issues one deposit token, in one of those currencies, which is its
deposit liability to the customer holding it. A bank may hold bonds and may
act as issuing and paying agent for a bond.

2.3 **Issuers** of bonds run no node and act through a bank as their issuing
and paying agent; the issuer's deposit at its agent is debited and credited
for its bond.

2.4 **Customers** hold deposit tokens at addresses their bank has
allowlisted. They send no transactions: their bank instructs for them.

2.5 Only an active participant may submit an instruction or approve one. A
suspended participant's approvals are refused and a suspended bank can
neither send nor receive wholesale tokens.
*Code: `SettlementEngine.settle`, `WholesaleToken.canSend/canReceive`.*

## 3. Instruments and whose liability each is

| Instrument | Liability of | Held by |
| --- | --- | --- |
| Wholesale token (`wCAD`) | its currency's central bank | active banks with a reserve account at that central bank |
| Deposit token (`dCAD-A`, …) | the issuing bank, as a deposit | customers the issuing bank has allowlisted |
| Bond | the issuer, through its agent | addresses whose identity verifies in the bond's identity registry, never the bond's own paying agent; a repo lender holds it as collateral too (§8a) |

3.1 A tokenized deposit is a deposit. Tokenizing or detokenizing moves value
between two of the bank's own deposit liability accounts and never changes
the bank's total deposits (invariant 4).

3.2 A cash token's smallest unit is the currency's minor unit, so token
amounts and book amounts are the same numbers, with no conversion.

## 4. Instructions

4.1 An instruction is a set of legs (mint, burn, transfer of listed tokens)
that settle together or not at all. Its identifier is the ISO 20022 UETR of
the payment or transaction it settles.
*Code: [`SettlementEngine.sol`](../contracts/src/SettlementEngine.sol).*

4.2 **Authority.** Every leg needs the approval of the participant that owns
what the leg takes or creates:
- a mint, of the token's issuer, since it creates the issuer's liability;
- a burn or a transfer out of an account, of that account's participant, or,
  for a customer, of the bank that issued the token, acting for it.

Approval is given by submitting the instruction or by an EIP-712 [S24] signature
over it. A signature covers exactly the legs, identifier and deadline it was
given for, on this chain and this engine only.

4.3 **Consent to a liability.** In an interbank payment the payee's bank
co-signs, because the payment mints its deposit liability. In an issue or a
trade the buyer co-signs, because its wholesale tokens move; it does so only
for an issue or trade its own operator affirmed first under the same UETR
(§8).

4.4 **Deadline.** Every instruction carries a deadline in block time. The
engine refuses an instruction after its deadline, so approvals cannot be used
indefinitely.

4.4a **Across currencies.** A payment from a deposit in one currency to a
deposit in another settles payment versus payment, in one instruction,
through the scenario's dealer: neither currency moves without the other. It
settles only at a quote the dealer signed for the payer's bank, unchanged,
whose target amount is the source amount at the quoted rate rounded once,
half-even (invariant 11). The dealer co-signs first, since its wholesale
leaves it; then the payee's bank, as in §4.3. A quote settles at most one
instruction, and the instruction's deadline is no later than the quote's
expiry.
*Code: [`fx.ts`](../packages/participant/src/fx.ts).*

4.5 **Once only.** An identifier settles at most once. Resubmitting a settled
instruction is refused (invariant 6).

## 5. Settlement and finality

5.1 An instruction **settles** when the block containing it is committed.
QBFT commits blocks with immediate finality: a committed block is never
reorganized.

5.2 **Settlement is final at commit.** From that point, in this sandbox, the
instruction is irrevocable and unconditional: no participant can undo it, and
the books of every participant concerned must post it with that block.

5.3 **Corrections are new instructions.** A settled instruction is never
reversed or edited. An error is corrected by a new instruction, and the
journal keeps both (the books are append-only).

5.4 **Legal finality is outside the sandbox.** Technical irreversibility on
a ledger is not, by itself, legal finality [S1, p.26]. In Canada, the
Governor of the Bank of Canada may designate a clearing and settlement
system (Payment Clearing and Settlement Act, s.4); a designated system's
settlement rules are then valid and binding, and its payments are not to be
reversed, despite other law (s.8) [S15]. Lynx is designated in this way
[S16]. A system like this one would need such a designation, or an
equivalent, before rule 5.2 could have legal force. Agorá found settlement
finality achievable in all seven jurisdictions it studied, but only with
rules that state, for each jurisdiction, which event makes settlement final
[S1, pp.65–66].

## 6. Refusal and expiry

6.1 The engine refuses an instruction that breaks a rule: a missing approval,
an ineligible holder, a frozen balance, insufficient balance, a passed
deadline, an unlisted token, a repeated identifier. Nothing moves.

6.2 A refused instruction's pending entries are voided by the participant
that booked them. The submitter learns of the refusal at once; a co-signer
learns once block time passes the deadline with nothing settled, and voids
its own entry then. This is the only notice it needs: the chain is the
record.
*Code: [`submitter.ts`](../packages/participant/src/submitter.ts),
[`sweeper.ts`](../packages/participant/src/sweeper.ts).*

6.3 A payment status report (`pacs.002`) states `RJCT` and the engine's
reason for a refused payment.

## 7. Holders, freezing and forced transfer

7.1 A bank allowlists a customer address only after its own
know-your-customer checks, which happen outside the system. Only
allowlisted addresses can receive or send its deposit token.

7.2 The issuer of a token may freeze some or all of a holder's balance. A
frozen balance cannot be moved by any instruction.

7.3 The issuer of a token may force a transfer out of a holder's account, for
example under a court order; the receiver must still be eligible. A forced
transfer is outside the settlement engine: participants record it as a
movement their books cannot explain until they book it themselves, and it is
shown, never silently absorbed.

7.4 **Identity for securities.** A bond reaches an address only if the
address is bound, in the bond's identity registry, to an identity carrying
a valid KYC claim by a trusted issuer: the central bank for the banks it
admitted, each bank for its own customers. An issuer may revoke a claim it
made; from then on the holder receives no units, and what it holds stays,
to sell, be paid on and be redeemed. Every movement of a bond outside a
settlement instruction is refused as not compliant, except the agent's
forced transfers and recoveries (§7.3).
*Code: [`Bond.sol`](../contracts/src/Bond.sol),
[`IdentityRegistry.sol`](../contracts/src/erc3643/IdentityRegistry.sol).*

7.5 **Client custody.** A bank may hold bonds for its customers at an
omnibus wallet bound to it, recording each client's position in its own
books. The positions must add up, for each bond, to what the omnibus holds
(invariant 13). What the omnibus receives is the clients', shared by their
positions at the record date, each share rounded once; the residual is the
bank's, shown. A bank takes a position for a client only while the client's
identity verifies (§7.4). A lost omnibus wallet is recovered by the bond's
agent to a new one the bank names, bound to the bank by the operator.
*Code: [`custody.ts`](../packages/participant/src/custody.ts).*

## 8. Matching for securities

8.1 A bank pays for bond units only if its operator affirmed the purchase
first, under the same UETR, bond, price and units. The affirmation is, in
substance, the buyer's receive-against-payment settlement instruction
(`sese.023` `RECE`), and the seller's or agent's instruction is the matching
deliver (`DELI`); both carry the UETR as their common reference.

8.2 Coupons and redemption need no affirmation: each holder checks its own
amount from the bond's terms and its holding at the record block, and
co-signs only if it agrees.

## 8a. Repo

8a.1 A repo is a sale of bond units for cash with an agreement to buy them
back at the end date for the cash plus repo interest [S44]. Title to the
units passes on the ledger; the economics stay with the borrower, so
neither bank books a sale. The lender records the units it received as
collateral, apart from what it owns, and the borrower keeps them in its
holdings as pledged (SPEC.md §5.7).
*Code: [`repo.ts`](../packages/participant/src/repo.ts),
[`postings.ts`](../packages/domain/src/postings.ts).*

8a.2 **Terms both affirm.** The lender pays only on terms its operator
affirmed under the repo's UETR: the collateral bond and units, the purchase
price, the rate, the haircut, the start and end dates. The units at the
agreed mark, less the haircut, must cover the purchase price.

8a.3 **Margin.** The side that receives units calls the margin at marks
it affirms: the borrower's shortfall, in the fewest units that again cover
the cash lent plus accrued interest; the lender's excess, in the most it
can return while the rest still covers it [S45, S46]. The other side
delivers on the call, and only what it computes itself. A call not met
within the scenario's time is overdue, shown to both sides; what follows a
default is outside the sandbox (§16).

8a.4 **Substitution.** The borrower may replace collateral with units of
another bond the repo accepts, worth at least as much at marks the lender
affirms, in one instruction: the lender is never without collateral.

8a.5 **Close.** At the end date every collateral unit goes back against
the purchase price plus interest over the days held, on a 365-day year,
rounded once, half-even [S48]. Each side checks it against its own record.

8a.6 **Income on collateral.** A coupon paid on collateral goes to the
lender, which holds it on the ledger, and the lender pays the borrower the
same coupon on those units, computed from its record at the coupon's record
block: a manufactured payment, once per coupon [S47].

8a.7 **No re-use.** A bank delivers only units it owns and has not pledged:
the collateral it holds as lender is not its to sell or pledge, and the
units it pledged are not its to deliver until they come back. A bond is not
redeemed while units of it are repo collateral (invariant 14).

## 9. Liquidity

9.1 A bank obtains wholesale tokens by funding them from its settlement
account at that currency's central bank, and returns them by redeeming. The
central bank funds only what the settlement account covers.

9.2 A bond's paying agent pays from its own wholesale tokens and must fund
them before a payment the issue proceeds no longer cover.

## 10. Books and reconciliation

10.1 Each participant keeps double-entry books in which every balance it
mirrors on the ledger is a separate account. Every account is in one
currency and every entry balances in each currency; a bank holding reserves
in more than one currency keeps its reserves and an FX position in each.

10.2 Each participant reconciles those accounts against the ledger after the
blocks it processes: a wholesale line or reserve against the wholesale
token, a customer's tokenized deposit against the customer's token balance,
a bond holding against its units times face.

10.3 A difference is a break. A break is recorded and shown; it is never
corrected automatically. It is resolved by finding its cause and posting a
correcting entry.

## 11. Messages

11.1 Participants exchange and report in ISO 20022 at the versions in
[design.md](design.md) §3.13: `pacs.008`, `pacs.009`, `pacs.002`,
`camt.054`, `camt.053`, `sese.023` and `sese.025`. A `pacs.009` is sent as
cover carrying the payment's UETR, one per currency for a payment across
currencies, and for a repo's manufactured payment. `sese.023` and
`sese.025` are used for a bond's settlement and for each repo leg.

## 12. Keys

12.1 Each participant signs with its own key, which it alone controls. The
sandbox derives keys from public labels for convenience; they are public and
must never hold value. A participant may hold its key in AWS KMS instead.

12.2 **Signing keys and holding addresses.** A participant's addresses are
its signing keys, which submit and approve instructions and hold its roles,
and its holding addresses, which hold balances for it and sign nothing.
Roles belong to the participant, not to a key.
*Code: [`ParticipantRegistry.sol`](../contracts/src/ParticipantRegistry.sol).*

12.3 **Rotation.** A participant moves to a new signing key in one registry
change: the new key admitted, the old one retired to a holding address,
every role moving with it. The participant's current key consents and the
new key proves itself; the operator makes the change, and allowlists the
new key on the network. Both act under their policies for administrative
changes (§15.2). A signature given with a retired key no longer counts.
*Code: [`changes.ts`](../packages/participant/src/changes.ts).*

## 13. Settlement in two steps (interop mode)

13.1 In interop mode an instruction's legs live on two ledgers, and each
ledger locks its own part in its `ConditionalSettlement`, authorized by the
same rule as §4.2, over the instruction and its condition together.
*Code: [`ConditionalSettlement.sol`](../contracts/src/ConditionalSettlement.sol).*

13.2 **A lock is not settlement.** While a part is locked, what its legs
take is frozen at the holder and nothing has moved. A part **settles** when
its lock settles, in a committed block, and from then it is final on that
ledger, as §5.2 says of any settlement.

13.3 **Each ledger is final on its own.** A transfer across two ledgers is
complete only when both parts have settled. Nothing on either ledger makes
one part wait for the other: that is the coordinator's job, and the
sandbox's interop runs show where each coordinator can fail at it
(SPEC.md §7).

13.4 **Timeouts split time.** Before a lock's timeout only settling is
possible; from it, only releasing. A claim or commit that reaches the ledger
at or after the timeout is refused.

13.5 **Hashlock.** A hashlocked part settles for whoever shows the preimage
of its hash, before the timeout; the preimage is then public on that ledger.
The party that holds the secret locks first, with the longer timeout.

13.6 **Notary.** A notarized part settles when the named notary commits it,
before the timeout; the notary may abort it instead. The notary records each
decision before acting on it, and a restarted notary carries out what it
recorded, for whatever parts are still locked.

13.7 **Release.** From a lock's timeout, anyone may release it, and what it
held returns to the holder. Each bank releases its own locks once they are
past their timeout.

13.8 A transfer whose parts end differently (one settled, one released)
stays that way on both ledgers: nothing in the sandbox reverses a settled
part or settles a released one. Who bears that outcome is not decided here
(§16).

13.9 **Across currencies.** When a payment across currencies is split by
currency over two ledgers, ledger 2's part moves the dealer's wholesale and
mints the payee's deposit: the dealer locks it, and the payee's bank
co-signs the lock, as §4.3 and §4.4a require of the same legs on one ledger.
A transfer whose parts end differently has then delivered one currency and
not the other: FX settlement risk, which settling both currencies in one
instruction (§4.4a) does not have.
*Code: [`ledgers.ts`](../services/coordinator/src/ledgers.ts),
[`CrossCurrencyInterop.t.sol`](../contracts/test/CrossCurrencyInterop.t.sol).*

## 14. Confidential deposits (confidential mode)

14.1 In confidential mode each bank's deposit token is a Paladin Noto token,
notarized by the bank: the bank's notary validates every mint, transfer and
burn of its token and submits it to the shared ledger. A customer holds
unspent states under a key its bank's Paladin node derives for it.
*Code: [`paladin.ts`](../packages/chain/src/paladin.ts).*

14.2 **Who sees what.** A customer's states, and so its balance, are held by
its bank's node. Another bank's node holds none of them. The shared ledger
records each state as a hash, with the notary's signature; validators see
neither the customer's key nor the amount of a deposit movement.

14.3 **An interbank payment** settles in one shared-ledger transaction
through `ConfidentialSettlement`: the payer's bank locks a burn of its
customer's deposit, the payee's bank locks a mint of its customer's, each
delegates its lock to the contract, the payee's bank signs the payment, and
the payer's bank settles. The wholesale leg moves under §4.2's rule in the
same transaction, and is visible to validators as in the baseline mode.
*Code: [`ConfidentialSettlement.sol`](../contracts/src/ConfidentialSettlement.sol).*

14.4 **Cancellation.** A bank may cancel a lock on its own deposit token that
it delegated, while the payment is unsettled. That aborts the payment and
returns what the lock held; no other participant may cancel it.

14.5 **Admission.** The central bank keeps the list of Noto tokens the
contract accepts and registers each bank's Paladin node, as it lists tokens
and admits participants on the ledger. Each node's signing keys are added to
every validator's account allowlist before it may send transactions.

## 15. Operators, approvals and the audit log

15.1 Each participant acts through named operators, each holding one or
more roles: an `operator` starts flows, an `approver` approves flows others
started, an `administrator` starts and approves administrative changes.
*Code: [`operators.yaml`](../scenarios/ca-interbank/operators.yaml),
[`policy.ts`](../packages/participant/src/policy.ts).*

15.2 **Policy before signature.** Each participant's policy says, for every
flow it sends by kind and amount, and for every administrative change, how
many approvals it needs and from which roles. The participant neither signs
nor sends it until those approvals are recorded, by operators other than the
one who started it. An operator may never approve what it started itself
(invariant 12).

15.3 A flow waiting for approval is booked: what it would spend is held.
A rejection, or its deadline passing first, voids its entry, as a refused
instruction's is (§6.2). Once approved, it is released under a fresh
deadline.

15.4 A central bank's policy applies to the wholesale tokens it mints at a
bank's request; a bank's to the purchases its operators affirm (§8.1). A
co-signature a participant gives at another's request is not its outgoing
flow: it checks and books what it signs (§4.3), and its log records the
signature.

15.5 **Audit log.** Each participant keeps an append-only log of every
initiation, approval, rejection, signature, submission and outcome, each
entry carrying the hash of the one before. A participant's own records are
evidence only while that chain verifies; an entry edited or removed shows
where the chain breaks, and is reported, never repaired in place.

## 16. What a real system would add

A production system would need, at least:

- legal designation and a rulebook with legal force;
- participant agreements covering liability and loss allocation, including
  who bears a transfer whose parts end differently on two ledgers (§13.8);
- default and insolvency procedures for a failing participant (what happens
  to its deposit tokens and its wholesale holdings), and for a repo whose
  margin call goes unmet or whose party fails (closing out, valuing and
  netting under a master agreement such as the GMRA [S47]);
- operating hours, incident and business-continuity rules;
- governance for changing the rules and the code;
- data-protection rules for what each participant may see of the others'
  activity, including whether the wholesale leg itself must be private
  (§14.2);
- authenticated, encrypted links between participants beyond the Paladin
  nodes' mutual TLS.

None of these is decided here.
