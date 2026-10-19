import Link from "next/link";
import { ActionForm, UetrField } from "@/components/action-form";
import { Amount } from "@/components/operate";
import { affirmRepo, affirmSubstitution, callMargin, closeRepo, meetCall, openRepo, passOnCoupon, substitute } from "@/lib/actions";
import { block, money } from "@/lib/format";
import type { Network, NetworkParticipant, RepoView, Result } from "@/lib/services";

/**
 * Repo as one bank sees it (SPEC.md §5.7–§5.10): each repo it lends or
 * borrows under, with its terms, the collateral its record holds and how it
 * got there, its margin calls (overdue once past their due time unmet, on
 * both sides), and the coupons on collateral the lender owes on. What a bank
 * can start depends on its side: the lender affirms an open or a
 * substitution, the side receiving units calls a margin, the other side
 * starts each under the same UETR; the borrower closes, the lender passes on
 * a coupon.
 */
export function Repos({ bank, repos, network }: { bank: NetworkParticipant; repos: Result<RepoView[]>; network: Network }) {
  const repo = network.repo;
  if (!repo) return null;
  const name = (id: string) => network.participants.find((p) => p.id === id)?.name ?? id;
  const agents = new Set(network.instruments.bonds.filter((b) => repo.collateral.includes(b.symbol)).map((b) => b.agent));
  const counterparties = network.participants.filter((p) => p.kind === "bank" && p.id !== bank.id && !agents.has(p.id));
  if (agents.has(bank.id)) return null;
  const currency = bank.currency ?? network.scenario.currencies[0]!;
  return (
    <section className="panel repos" aria-labelledby="repos">
      <div className="panel-head">
        <h2 id="repos">Repo</h2>
        <p className="panel-note">
          Collateral at the agreed mark, after the haircut, must cover cash lent plus interest accrued ({repo.dayCount}); the units held as collateral are
          exactly each repo's record (invariant 14)
        </p>
      </div>
      {!repos.ok ? (
        <p className="unavailable">The repos could not be read: {repos.error}</p>
      ) : repos.value.length === 0 ? (
        <p className="panel-note">No repo yet. A lender affirms the terms under a UETR; the borrower opens the repo under the same one.</p>
      ) : (
        repos.value.map((r) => <RepoCard key={r.id} bank={bank} repo={r} collateral={repo.collateral} name={name} />)
      )}
      <details className="op">
        <summary>Agree a repo</summary>
        <RepoTermsForm bank={bank} counterparties={counterparties} collateral={repo.collateral} currency={currency} />
      </details>
    </section>
  );
}

function RepoTermsForm({
  bank,
  counterparties,
  collateral,
  currency,
}: {
  bank: NetworkParticipant;
  counterparties: NetworkParticipant[];
  collateral: string[];
  currency: string;
}) {
  return (
    <>
      <p className="op-note">As lender, affirm the terms first; as borrower, open under the UETR the lender affirmed.</p>
      {(["lender", "borrower"] as const).map((side) => (
        <ActionForm
          key={side}
          action={(side === "lender" ? affirmRepo : openRepo).bind(null, bank.id)}
          participant={bank.id}
          submit={side === "lender" ? "Affirm as lender" : "Open as borrower"}
          pendingLabel={side === "lender" ? "Affirming…" : "Asking the lender to co-sign…"}
        >
          <label className="op-field">
            <span>{side === "lender" ? "Borrower" : "Lender"}</span>
            <select name="counterparty" required>
              {counterparties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <UetrField generate={side === "lender"} label={side === "lender" ? "UETR to give the borrower" : "UETR the lender affirmed"} />
          <label className="op-field">
            <span>Collateral</span>
            <select name="bond" required>
              {collateral.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="op-field op-units">
            <span>Units</span>
            <input name="units" inputMode="numeric" required autoComplete="off" pattern="[0-9][0-9,]*" />
          </label>
          <Amount currency={currency} name="mark" label="Mark per unit" />
          <Amount currency={currency} name="cash" label="Purchase price" />
          <label className="op-field">
            <span>Rate</span>
            <input name="rate" required placeholder="0.0275" pattern="0(\.[0-9]{1,18})?" autoComplete="off" />
          </label>
          <label className="op-field">
            <span>Haircut</span>
            <input name="haircut" required placeholder="0.02" pattern="0(\.[0-9]{1,18})?" autoComplete="off" />
          </label>
          <label className="op-field">
            <span>Start</span>
            <input name="startDate" type="date" required />
          </label>
          <label className="op-field">
            <span>End</span>
            <input name="endDate" type="date" required />
          </label>
        </ActionForm>
      ))}
    </>
  );
}

/** One mark field per collateral bond the repo accepts. */
function Marks({ collateral, currency }: { collateral: string[]; currency: string }) {
  return (
    <>
      {collateral.map((bond) => (
        <label key={bond} className="op-field op-amount">
          <span>
            Mark {bond} <span className="unit">{currency}</span>
          </span>
          <input type="hidden" name="markBond" value={bond} />
          <input name="markPrice" inputMode="decimal" placeholder="1,000.00" autoComplete="off" pattern="[0-9][0-9,]*(\.[0-9]{1,2})?" />
        </label>
      ))}
    </>
  );
}

function RepoCard({ bank, repo: r, collateral, name }: { bank: NetworkParticipant; repo: RepoView; collateral: string[]; name: (id: string) => string }) {
  const lender = r.role === "lender";
  const open = r.status === "open";
  const owed = r.manufactured.filter((m) => !m.paidBy);
  const toMeet = r.calls.filter((c) => c.caller !== bank.id && (c.status === "open" || c.status === "overdue"));
  return (
    <div className={`repo ${open ? "is-open" : "is-closed"}`}>
      <h3>
        {lender ? `Lent to ${name(r.counterparty)}` : `Borrowed from ${name(r.counterparty)}`} · <Link href={`/p/${bank.id}/i/${r.id}`}>{r.id.slice(0, 8)}</Link> ·{" "}
        {open ? "open" : `closed in block ${block(r.closedBlock ?? "0")}`}
      </h3>
      <dl className="bond-facts">
        <div>
          <dt>Purchase price</dt>
          <dd>
            {money(r.terms.amount)} {r.currency}
          </dd>
        </div>
        <div>
          <dt>Rate · haircut</dt>
          <dd>
            {r.terms.rate} · {r.terms.haircut}
          </dd>
        </div>
        <div>
          <dt>Term</dt>
          <dd>
            {r.terms.startDate} to {r.terms.endDate}
          </dd>
        </div>
        <div>
          <dt>Repurchase price</dt>
          <dd>
            {money(r.repurchasePrice)} (interest {money(r.interestAtEnd)})
          </dd>
        </div>
      </dl>
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">Block</th>
            <th scope="col">Flow</th>
            <th scope="col" className="num">
              Collateral after
            </th>
          </tr>
        </thead>
        <tbody>
          {r.history.map((h) => (
            <tr key={h.uetr}>
              <th scope="row">
                <Link href={`/p/${bank.id}/i/${h.uetr}`}>{block(h.block)}</Link>
              </th>
              <td>{h.kind.replace("repo-", "")}</td>
              <td className="num">{h.collateral.length === 0 ? "none" : h.collateral.map((c) => `${money(c.units)} ${c.bond}`).join(", ")}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Record now, at face
            </th>
            <td className="num">{money(r.collateralAtFace)}</td>
          </tr>
        </tfoot>
      </table>
      {r.calls.length > 0 ? (
        <ul className="key-list">
          {r.calls.map((c) => (
            <li key={c.uetr} className={`key is-${c.status === "overdue" ? "retired" : "active"}`}>
              <span className="key-gen">
                {c.flow.direction === "deliver" ? "deliver" : "return"} {money(c.flow.units)} {c.flow.bond}
              </span>
              <span>
                called by {name(c.caller)} at marks as of {c.flow.asOf}, due {c.dueBy.slice(11, 19)}
              </span>
              <span className={`key-status ${c.status === "overdue" ? "is-no" : ""}`}>{c.status === "met" ? `met in block ${block(c.settledBlock ?? "0")}` : c.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {r.manufactured.length > 0 ? (
        <ul className="key-list">
          {r.manufactured.map((m) => (
            <li key={`${m.bond}-${m.period}`} className={`key is-${m.paidBy ? "active" : "retired"}`}>
              <span className="key-gen">
                {m.bond} coupon {m.period}
              </span>
              <span>
                on {money(m.units)} units held as collateral at block {block(m.recordBlock)}, owed on to {name(r.counterparty)}
              </span>
              <span className="key-status">
                {m.paidBy ? (
                  <Link href={`/p/${bank.id}/i/${m.paidBy}`}>passed on ({m.status})</Link>
                ) : (
                  "not yet passed on"
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {lender
        ? owed.map((m) => (
            <ActionForm
              key={`${m.bond}-${m.period}`}
              action={passOnCoupon.bind(null, bank.id, r.id, m.bond, m.period)}
              participant={bank.id}
              submit={`Pass on ${m.bond} coupon ${m.period}`}
              pendingLabel="Asking the borrower to check…"
            >
              {null}
            </ActionForm>
          ))
        : null}
      {toMeet.map((c) => (
        <ActionForm
          key={c.uetr}
          action={meetCall.bind(null, bank.id, r.id, c.uetr)}
          participant={bank.id}
          submit={`${c.flow.direction === "deliver" ? "Deliver" : "Return"} ${money(c.flow.units)} ${c.flow.bond}`}
          pendingLabel="Asking the caller to co-sign…"
        >
          {null}
        </ActionForm>
      ))}
      {open ? (
        <>
          <details className="op">
            <summary>Call margin at agreed marks</summary>
            <ActionForm action={callMargin.bind(null, bank.id, r.id)} participant={bank.id} submit="Call margin" pendingLabel="Calling…">
              <p className="op-note">{lender ? "A shortfall is called by the lender." : "An excess is called back by the borrower."}</p>
              <Marks collateral={collateral} currency={r.currency} />
              <label className="op-field">
                <span>As of</span>
                <input name="asOf" type="date" required min={r.terms.startDate} max={r.terms.endDate} />
              </label>
              <label className="op-field">
                <span>Settled in</span>
                <select name="bond">
                  {collateral.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            </ActionForm>
          </details>
          <details className="op">
            <summary>{lender ? "Affirm a substitution" : "Substitute collateral"}</summary>
            <ActionForm
              action={(lender ? affirmSubstitution : substitute).bind(null, bank.id, r.id)}
              participant={bank.id}
              submit={lender ? "Affirm" : "Substitute"}
              pendingLabel={lender ? "Affirming…" : "Asking the lender to co-sign…"}
            >
              <UetrField generate={lender} label={lender ? "UETR to give the borrower" : "UETR the lender affirmed"} />
              <label className="op-field">
                <span>Return</span>
                <select name="outgoing">
                  {r.collateral.map((c) => (
                    <option key={c.bond} value={c.bond}>
                      {c.bond}
                    </option>
                  ))}
                </select>
              </label>
              <label className="op-field op-units">
                <span>Units</span>
                <input name="units" inputMode="numeric" required autoComplete="off" pattern="[0-9][0-9,]*" />
              </label>
              <label className="op-field">
                <span>For</span>
                <select name="incoming">
                  {collateral.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <Marks collateral={collateral} currency={r.currency} />
              <label className="op-field">
                <span>As of</span>
                <input name="asOf" type="date" required min={r.terms.startDate} max={r.terms.endDate} />
              </label>
            </ActionForm>
          </details>
          {!lender ? (
            <ActionForm action={closeRepo.bind(null, bank.id, r.id)} participant={bank.id} submit={`Close: repay ${money(r.repurchasePrice)}`} pendingLabel="Asking the lender to check…">
              {null}
            </ActionForm>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
