import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoNetwork } from "@/components/no-network";
import { Bond } from "@/components/bonds";
import { Live } from "@/components/live";
import { Operate } from "@/components/operate";
import { CustodyPanel } from "@/components/custody";
import { Repos } from "@/components/repos";
import { IdentityPanel } from "@/components/identity";
import { Keys } from "@/components/keys";
import { ActingAs, Approvals } from "@/components/policy";
import { BooksSeal, Stamp } from "@/components/stamp";
import { block, describe, isZero, kindLabel, money, namer, roleLabel, shortUetr, time } from "@/lib/format";
import { actingOperator } from "@/lib/operators";
import {
  type Account,
  attempt,
  type Customer,
  type Instruction,
  type JournalEntry,
  type Network,
  type Quote,
  readNetwork,
  type Reconciliation,
  type Result,
  type Rtgs,
  service,
  type Wholesale,
} from "@/lib/services";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ participant: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { participant } = await params;
  const network = await attempt(readNetwork());
  const name = network.ok ? network.value.participants.find((p) => p.id === participant)?.name : undefined;
  return { title: `${name ?? participant} · Open Unified Ledger` };
}

const TYPE_ORDER: Account["type"][] = ["asset", "liability", "equity", "income", "expense"];
const TYPE_LABEL: Record<Account["type"], string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export default async function ParticipantPage({ params }: Props) {
  const { participant: id } = await params;
  const read = await attempt(readNetwork());
  if (!read.ok) return <NoNetwork error={read.error} />;
  const network = read.value;
  const participant = network.participants.find((p) => p.id === id);
  if (!participant?.url) notFound();

  const s = service(participant);
  const [accounts, reconciliation, instructions, journal, customers, rtgs, wholesale] = await Promise.all([
    attempt(s.accounts()),
    attempt(s.reconciliation()),
    attempt(s.instructions()),
    attempt(s.journal()),
    participant.kind === "bank" ? attempt(s.customers()) : null,
    participant.kind === "central-bank" ? attempt(s.rtgs()) : null,
    participant.kind === "central-bank" ? attempt(s.wholesale()) : null,
  ]);
  // Operators and what waits for their approval (SPEC.md §15), and the audit log's chain.
  const [operators, proposals, auditChain, keys, changes, identity] = await Promise.all([
    attempt(s.operators()),
    attempt(s.proposals()),
    attempt(s.verifyAudit()),
    attempt(s.keys()),
    attempt(s.changes()),
    attempt(s.identity()),
  ]);
  const custody = participant.kind === "bank" && network.custody?.some((c) => c.bank === participant.id) ? await attempt(s.custody()) : null;
  // Repo (SPEC.md §5.7–§5.10): the repos this bank lends or borrows under.
  const repos = participant.kind === "bank" && network.repo ? await attempt(s.repos()) : null;
  const acting = await actingOperator(participant.id, operators.ok ? operators.value : null);
  // Across currencies: the dealer's quotes, or the ones a bank asked it for.
  const quotes = network.fx && participant.kind === "bank" ? await attempt(s.quotes()) : null;
  const bonds =
    participant.kind === "bank"
      ? await Promise.all(network.instruments.bonds.map((b) => attempt(s.bond(b.symbol))))
      : [];
  const down = !accounts.ok && !reconciliation.ok && !instructions.ok;
  const currency = participant.currency ?? network.scenario.currencies[0]!;

  return (
    <article className="ledger">
      <header className="ledger-head">
        <div>
          <p className="eyebrow">
            {participant.kind === "central-bank" ? "Central bank" : "Bank"}
            {participant.validator ? " · runs a validator" : ""}
            {participant.address ? <code title={participant.address}> · {participant.address.slice(0, 10)}…</code> : null}
          </p>
          <h1>{participant.name}</h1>
        </div>
        <div className="ledger-head-side">
          {reconciliation.ok ? <BooksSeal ok={reconciliation.value.ok} at={reconciliation.value.block} /> : null}
          {auditChain.ok ? (
            <Link href={`/p/${participant.id}/audit`} className={`seal ${auditChain.value.ok ? "seal-ok" : "seal-break"}`}>
              <span className="seal-word">{auditChain.value.ok ? "Audit chain verifies" : "Audit chain broken"}</span>
              <span className="seal-block">{auditChain.value.ok ? `${auditChain.value.entries} entries` : `at entry ${auditChain.value.brokenAt?.seq}`}</span>
            </Link>
          ) : null}
          <Live />
        </div>
      </header>

      {down ? (
        <section className="panel offline-panel">
          <h2>{participant.name}'s service is not answering</h2>
          <p>
            Its books live behind <code>{s.url}</code>. Start the services with <code>pnpm services:up {network.scenario.id}</code>;
            this view comes back on its own.
          </p>
        </section>
      ) : (
        <div className="ledger-grid">
          <div className="ledger-books">
            <ActingAs participant={participant} operators={operators} acting={acting} />
            <Approvals participant={participant} proposals={proposals} network={network} acting={acting} />
            {participant.kind === "bank" ? <Operate bank={participant} network={network} /> : null}
            <Books accounts={accounts} currency={currency} />
            {customers ? <Customers customers={customers} currency={currency} /> : null}
            {quotes ? <Quotes quotes={quotes} accounts={accounts} participant={participant.id} network={network} /> : null}
            {custody ? <CustodyPanel bank={participant} custody={custody} /> : null}
            {repos ? <Repos bank={participant} repos={repos} network={network} /> : null}
            {bonds.map((bond, index) => (
              <Bond key={network.instruments.bonds[index]!.symbol} bond={bond} bank={participant} network={network} />
            ))}
            {rtgs && wholesale ? <Banks rtgs={rtgs} wholesale={wholesale} network={network} /> : null}
            <ReconciliationPanel reconciliation={reconciliation} />
            <IdentityPanel participant={participant} identity={identity} network={network} />
            <Keys participant={participant} keys={keys} changes={changes} timeZone={network.scenario.timeZone} />
            <Journal journal={journal} participant={participant.id} timeZone={network.scenario.timeZone} />
          </div>
          <Instructions instructions={instructions} network={network} participant={participant.id} />
        </div>
      )}
    </article>
  );
}

function Unavailable({ what, result }: { what: string; result: { ok: false; error: string } }) {
  return (
    <p className="unavailable">
      {what} could not be read: {result.error}
    </p>
  );
}

function Books({ accounts, currency }: { accounts: Result<Account[]>; currency: string }) {
  // Books kept in more than one currency name each account's: amounts in different currencies never share a column unit.
  const several = accounts.ok && new Set(accounts.value.map((a) => a.currency)).size > 1;
  return (
    <section className="panel" aria-labelledby="books">
      <div className="panel-head">
        <h2 id="books">Books</h2>
        <p className="panel-note">
          <span className="mirror-mark" aria-hidden="true">⇄</span> mirrors a balance on the shared ledger
        </p>
      </div>
      {!accounts.ok ? (
        <Unavailable what="The books" result={accounts} />
      ) : (
        <table className="figures">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="num">
                Posted {several ? null : <span className="unit">{currency}</span>}
              </th>
              <th scope="col" className="num">
                Available
              </th>
            </tr>
          </thead>
          {TYPE_ORDER.map((type) => {
            const rows = accounts.value.filter((a) => a.type === type);
            if (rows.length === 0) return null;
            return (
              <tbody key={type}>
                <tr className="group">
                  <th scope="rowgroup" colSpan={3}>
                    {TYPE_LABEL[type]}
                  </th>
                </tr>
                {rows.map((a) => {
                  const pending = !isZero(a.pendingDebits) || !isZero(a.pendingCredits);
                  return (
                    <tr
                      key={a.account}
                      className={[a.account.includes("/") ? "is-sub" : "", isZero(a.posted) && !pending ? "is-quiet" : ""]
                        .join(" ")
                        .trim() || undefined}
                    >
                      <th scope="row">
                        <span className="account-name">
                          {a.mirrored ? (
                            <span className="mirror-mark" title="Mirrors a balance on the shared ledger">
                              ⇄
                            </span>
                          ) : null}
                          {a.name}
                        </span>
                        <code className="account-code">{a.account}</code>
                      </th>
                      <td className="num">
                        {money(a.posted)}
                        {several ? <span className="unit"> {a.currency}</span> : null}
                      </td>
                      <td className="num">
                        {money(a.available)}
                        {pending ? (
                          <span className="pending">
                            {!isZero(a.pendingDebits) ? `${money(a.pendingDebits)} Dr pending` : null}
                            {!isZero(a.pendingDebits) && !isZero(a.pendingCredits) ? " · " : null}
                            {!isZero(a.pendingCredits) ? `${money(a.pendingCredits)} Cr pending` : null}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      )}
    </section>
  );
}

function Customers({ customers, currency }: { customers: Result<Customer[]>; currency: string }) {
  return (
    <section className="panel" aria-labelledby="customers">
      <div className="panel-head">
        <h2 id="customers">Customers</h2>
        <p className="panel-note">A tokenized deposit is still this bank's deposit</p>
      </div>
      {!customers.ok ? (
        <Unavailable what="Customers" result={customers} />
      ) : customers.value.length === 0 ? (
        <p className="empty">This bank has no customers in the scenario.</p>
      ) : (
        <table className="figures">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col" className="num">
                Deposit <span className="unit">{currency}</span>
              </th>
              <th scope="col" className="num">
                Tokenized
              </th>
            </tr>
          </thead>
          <tbody>
            {customers.value.map((c) => (
              <tr key={c.customer}>
                <th scope="row">
                  <span className="account-name">{c.name}</span>
                  <code className="account-code" title={c.address ?? undefined}>
                    {c.customer}
                    {c.address ? ` · ${c.address.slice(0, 8)}…` : ""}
                  </code>
                </th>
                <td className="num">{money(c.deposit.posted)}</td>
                <td className={`num ${isZero(c.tokenized.posted) ? "is-quiet" : ""}`}>{money(c.tokenized.posted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Banks({ rtgs, wholesale, network }: { rtgs: Result<Rtgs>; wholesale: Result<Wholesale>; network: Network }) {
  const n = namer(network);
  return (
    <section className="panel" aria-labelledby="banks">
      <div className="panel-head">
        <h2 id="banks">Banks</h2>
        <p className="panel-note">Reserves in the RTGS system, and the wholesale tokens funded from them</p>
      </div>
      {!rtgs.ok ? (
        <Unavailable what="Settlement accounts" result={rtgs} />
      ) : !wholesale.ok ? (
        <Unavailable what="Wholesale lines" result={wholesale} />
      ) : (
        <table className="figures">
          <thead>
            <tr>
              <th scope="col">Bank</th>
              <th scope="col" className="num">
                Settlement account <span className="unit">{rtgs.value.currency}</span>
              </th>
              <th scope="col" className="num">
                {wholesale.value.symbol} outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {rtgs.value.settlementAccounts.map((a) => (
              <tr key={a.bank}>
                <th scope="row">
                  <span className="account-name">{n.participant(a.bank)}</span>
                </th>
                <td className="num">{money(a.posted)}</td>
                <td className="num">{money(wholesale.value.lines.find((l) => l.bank === a.bank)?.outstanding ?? "0")}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total {wholesale.value.symbol} issued</th>
              <td />
              <td className="num">{money(wholesale.value.outstanding)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}

/**
 * Payment versus payment (SPEC.md §13): at the dealer, every quote it gave and
 * its position in each currency; at another bank, the quotes it asked for.
 * Each quote shows the payment that settled it, once one has.
 */
function Quotes({
  quotes,
  accounts,
  participant,
  network,
}: {
  quotes: Result<Quote[]>;
  accounts: Result<Account[]>;
  participant: string;
  network: Network;
}) {
  const n = namer(network);
  const dealer = network.fx?.dealer === participant;
  const positions = accounts.ok ? accounts.value.filter((a) => a.account.startsWith("fx-position/")) : [];
  return (
    <section className="panel" aria-labelledby="quotes">
      <div className="panel-head">
        <h2 id="quotes">{dealer ? "FX quotes given" : "FX quotes"}</h2>
        <p className="panel-note">
          {dealer
            ? `Signed by ${n.participant(participant)}; each settles one payment, before it expires`
            : `Asked of ${n.participant(network.fx?.dealer)} for payments into another currency`}
        </p>
      </div>
      {dealer && positions.length > 0 ? (
        <p className="fx-positions">
          Position{" "}
          {positions.map((p, index) => (
            <span key={p.account}>
              {index > 0 ? " · " : null}
              {/* An FX position is equity: a credit balance is what the dealer bought, a debit what it sold. */}
              {money(p.posted)} <span className="unit">{p.currency}</span>
            </span>
          ))}
        </p>
      ) : null}
      {!quotes.ok ? (
        <Unavailable what="Quotes" result={quotes} />
      ) : quotes.value.length === 0 ? (
        <p className="empty">No quotes yet. A payment to a customer in another currency asks for one.</p>
      ) : (
        <table className="figures">
          <thead>
            <tr>
              <th scope="col">{dealer ? "For" : "Quote"}</th>
              <th scope="col" className="num">
                Pays
              </th>
              <th scope="col" className="num">
                Rate
              </th>
              <th scope="col" className="num">
                Receives
              </th>
            </tr>
          </thead>
          <tbody>
            {quotes.value.map((q) => (
              <tr key={q.id} className={q.uetr ? undefined : "is-quiet"}>
                <th scope="row">
                  <span className="account-name">{dealer ? n.participant(q.requester) : shortUetr(q.id)}</span>
                  <code className="account-code">
                    {q.uetr ? (
                      <Link href={`/p/${participant}/i/${q.uetr}`} className="feed-link">
                        settled {shortUetr(q.uetr)}
                      </Link>
                    ) : (
                      `until ${time(q.expiresAt, network.scenario.timeZone)}`
                    )}
                  </code>
                </th>
                <td className="num">
                  {money(q.source.amount)} <span className="unit">{q.source.currency}</span>
                </td>
                <td className="num">{q.rate}</td>
                <td className="num">
                  {money(q.target.amount)} <span className="unit">{q.target.currency}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ReconciliationPanel({ reconciliation }: { reconciliation: Result<Reconciliation> }) {
  return (
    <section className="panel" aria-labelledby="reconciliation">
      <div className="panel-head">
        <h2 id="reconciliation">Books against the chain</h2>
        {reconciliation.ok && reconciliation.value.block ? (
          <p className="panel-note">Latest check at block {block(reconciliation.value.block)}</p>
        ) : null}
      </div>
      {!reconciliation.ok ? (
        <Unavailable what="Reconciliation" result={reconciliation} />
      ) : reconciliation.value.block === null ? (
        <p className="empty">The first check runs once the listener processes a block.</p>
      ) : (
        <>
          <table className="figures checks">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="num">
                  Books
                </th>
                <th scope="col" className="num">
                  Chain
                </th>
                <th scope="col" className="inv">
                  Invariant
                </th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.value.checks.map((c) => (
                <tr key={c.account} className={c.ok ? undefined : "is-break"}>
                  <th scope="row">
                    <code className="account-code">{c.account}</code>
                  </th>
                  <td className="num">{money(c.books)}</td>
                  <td className="num">{money(c.chain)}</td>
                  <td className="inv">
                    {c.ok ? "=" : "≠"} {c.invariant}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="sub">Breaks</h3>
          {reconciliation.value.breaks.length === 0 ? (
            <p className="empty">None. Every movement on the chain is explained by an entry in these books.</p>
          ) : (
            <ul className="breaks">
              {reconciliation.value.breaks.map((b) => (
                <li key={b.id}>
                  <span className="break-kind">{b.kind === "mismatch" ? "Differs from what was booked" : "No entry explains it"}</span>
                  <span>
                    block {block(b.block)}
                    {b.uetr ? ` · ${shortUetr(b.uetr)}` : ""} · tx <code>{b.tx_hash.slice(0, 10)}…</code>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Instructions({
  instructions,
  network,
  participant,
}: {
  instructions: Result<{ instructions: Instruction[] }>;
  network: Network;
  participant: string;
}) {
  return (
    <section className="panel instructions" aria-labelledby="instructions">
      <div className="panel-head">
        <h2 id="instructions">Instructions</h2>
        <p className="panel-note">Newest first · each settles whole or not at all</p>
      </div>
      {!instructions.ok ? (
        <Unavailable what="Instructions" result={instructions} />
      ) : instructions.value.instructions.length === 0 ? (
        <p className="empty">
          Nothing yet. Start a flow from this bank's Operate panel, or run <code>pnpm sim {network.scenario.id}</code>.
        </p>
      ) : (
        <ol className="feed">
          {instructions.value.instructions.map((i) => (
            <li key={i.uetr} className={`feed-row status-${i.status}`}>
              <div className="feed-when">
                <time dateTime={i.createdAt}>{time(i.createdAt, network.scenario.timeZone)}</time>
                <code title={i.uetr}>{shortUetr(i.uetr)}</code>
              </div>
              <div className="feed-what">
                <span className="feed-kind">
                  {kindLabel(i.kind)} <span className="feed-role">· {roleLabel(i.role)}</span>
                </span>
                <Link href={`/p/${participant}/i/${i.uetr}`} className="feed-link">
                  {describe(i, network)}
                </Link>
                {i.error && i.status !== "settled" ? <span className="feed-error">{i.error}</span> : null}
              </div>
              <div className="feed-amount">
                {money(i.amount)}
                {network.scenario.currencies.length > 1 ? <span className="unit"> {i.currency}</span> : null}
                {i.target ? (
                  <span className="feed-fx">
                    → {money(i.target.amount)} <span className="unit">{i.target.currency}</span>
                  </span>
                ) : null}
              </div>
              <div className="feed-mark">
                <Stamp status={i.status} settledBlock={i.settledBlock} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Journal({ journal, participant, timeZone }: { journal: Result<{ entries: JournalEntry[] }>; participant: string; timeZone: string }) {
  return (
    <section className="panel" aria-labelledby="journal">
      <div className="panel-head">
        <h2 id="journal">Journal</h2>
        <p className="panel-note">Latest entries · append-only, corrected only by new entries</p>
      </div>
      {!journal.ok ? (
        <Unavailable what="The journal" result={journal} />
      ) : (
        <ol className="journal-list">
          {journal.value.entries.map((e) => {
            const debits = e.lines.filter((l) => l.side === "debit");
            const total = debits.length === 1 ? debits[0]!.amount : null;
            return (
              <li key={e.id} className={`journal-row is-${e.status}`}>
                <span className="journal-id">{e.id}</span>
                <span className="journal-what">
                  {e.uetr ? (
                    <Link href={`/p/${participant}/i/${e.uetr}`} className="feed-link">
                      {e.description}
                    </Link>
                  ) : (
                    e.description
                  )}
                  <span className="journal-when">
                    {e.status === "posted"
                      ? `posted ${e.postedAt ? time(e.postedAt, timeZone) : ""}${e.block ? ` · block ${block(e.block)}` : ""}`
                      : e.status === "voided"
                        ? "voided"
                        : "pending"}
                    {" · "}
                    {e.lines.length} lines
                  </span>
                </span>
                <span className="journal-amount">{total ? money(total) : ""}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
