import Link from "next/link";
import { ActionForm, UetrField } from "@/components/action-form";
import { Amount } from "@/components/operate";
import { affirm, issue, payNext, sell } from "@/lib/actions";
import { block, money } from "@/lib/format";
import type { BondSummary, Network, NetworkParticipant, Result } from "@/lib/services";

/**
 * A bond as one bank sees it: its terms, its holding or, for the paying
 * agent, units outstanding; the schedule with each payment's block; and
 * what this bank can start. Issues and trades are matched: the buyer
 * affirms under a UETR first, and the agent or seller uses the same one.
 */
export function Bond({ bond, bank, network }: { bond: Result<BondSummary>; bank: NetworkParticipant; network: Network }) {
  if (!bond.ok) {
    return (
      <section className="panel">
        <p className="unavailable">The bond could not be read: {bond.error}</p>
      </section>
    );
  }
  const b = bond.value;
  const isAgent = b.agent === bank.id;
  const name = (id: string) => network.participants.find((p) => p.id === id)?.name ?? id;
  const banks = network.participants.filter((p) => p.kind === "bank");
  const buyers = banks.filter((p) => p.id !== b.agent);
  const counterparties = buyers.filter((p) => p.id !== bank.id);
  const next = b.schedule.find((p) => !p.paid);
  const issued = b.outstandingUnits !== "0";
  const currency = network.instruments.bonds.find((x) => x.symbol === b.symbol)?.currency ?? b.terms.currency;
  // A custodian's clients (SPEC.md §15), by name, from the scenario's directory.
  const clientsOf = (id: string) => {
    const ids = network.custody?.find((c) => c.bank === id)?.clients ?? [];
    const names = network.participants.find((p) => p.id === id)?.customers ?? [];
    return ids.map((c) => ({ id: c, name: names.find((x) => x.id === c)?.name ?? c }));
  };

  return (
    <section className="panel bond" aria-labelledby={`bond-${b.symbol}`}>
      <div className="panel-head">
        <h2 id={`bond-${b.symbol}`}>{b.symbol}</h2>
        <p className="panel-note">
          {isAgent ? `${bank.name} is issuing and paying agent for ${name(b.issuer)}` : `Issued by ${name(b.issuer)} through ${name(b.agent)}`}
        </p>
      </div>
      <p className="bond-terms">{network.instruments.bonds.find((x) => x.symbol === b.symbol)?.name}</p>
      <dl className="bond-facts">
        <div>
          <dt>Face per unit</dt>
          <dd>{money(b.terms.face)}</dd>
        </div>
        <div>
          <dt>Coupon</dt>
          <dd>
            {b.terms.couponRate} · {b.terms.frequency} · {b.terms.dayCount}
          </dd>
        </div>
        <div>
          <dt>Outstanding</dt>
          <dd>{money(b.outstandingUnits)} units</dd>
        </div>
        {b.holdingUnits !== null ? (
          <div>
            <dt>{bank.name} holds</dt>
            <dd>{money(b.holdingUnits)} units</dd>
          </div>
        ) : null}
        {b.verified !== null && !isAgent ? (
          <div>
            <dt>May receive it</dt>
            <dd className={b.verified ? "is-yes" : "is-no"} title="ERC-3643: its identity carries a valid KYC claim by a trusted issuer">
              {b.verified ? "yes, identity verified" : "no: identity not verified"}
            </dd>
          </div>
        ) : null}
      </dl>
      {b.regulation ? (
        <p className="panel-note bond-regulation">
          ERC-3643: identity registry <code title={b.regulation.identityRegistry}>{b.regulation.identityRegistry.slice(0, 10)}…</code>, compliance{" "}
          <code title={b.regulation.compliance}>{b.regulation.compliance.slice(0, 10)}…</code> allows a movement only inside a settlement
        </p>
      ) : null}

      <table className="figures schedule">
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Record</th>
            <th scope="col">Pays</th>
            <th scope="col" className="num">
              Paid
            </th>
          </tr>
        </thead>
        <tbody>
          {b.schedule.map((p) => (
            <tr key={p.number} className={p.paid ? undefined : "is-quiet"}>
              <th scope="row">
                {p.number}
                {p.final ? " · redemption" : ""}
              </th>
              <td>{p.recordDate}</td>
              <td>{p.paymentDate}</td>
              <td className="num">
                {p.paid ? (
                  <Link href={`/p/${bank.id}/i/${p.paid.uetr}`}>block {p.paid.settledBlock ? block(p.paid.settledBlock) : "?"}</Link>
                ) : p === next && issued ? (
                  "next"
                ) : (
                  ""
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isAgent ? (
        <>
          <details className="op" open={!issued}>
            <summary>Issue to buyers that affirmed</summary>
            <ActionForm action={issue.bind(null, bank.id)} participant={bank.id} submit="Issue" pendingLabel="Asking the buyers to co-sign…">
              <input type="hidden" name="bond" value={b.symbol} />
              <UetrField generate={false} label="UETR the buyers affirmed" />
              <Amount currency={currency} name="price" label="Price per unit" />
              {buyers.flatMap((p) => [
                <label key={p.id} className="op-field op-units">
                  <span>{p.name} units</span>
                  <input type="hidden" name="bank" value={p.id} />
                  <input type="hidden" name="client" value="" />
                  <input name="units" inputMode="numeric" placeholder="0" autoComplete="off" pattern="[0-9][0-9,]*" />
                </label>,
                // A custodian's clients' allocations go to its omnibus wallet (SPEC.md §15).
                ...clientsOf(p.id).map((c) => (
                  <label key={`${p.id}/${c.id}`} className="op-field op-units">
                    <span>
                      {p.name} for {c.name}
                    </span>
                    <input type="hidden" name="bank" value={p.id} />
                    <input type="hidden" name="client" value={c.id} />
                    <input name="units" inputMode="numeric" placeholder="0" autoComplete="off" pattern="[0-9][0-9,]*" />
                  </label>
                )),
              ])}
            </ActionForm>
          </details>
          {issued && next ? (
            <details className="op" open>
              <summary>{next.final ? "Redeem at maturity" : `Pay coupon ${next.number}`}</summary>
              <ActionForm action={payNext.bind(null, bank.id)} participant={bank.id} submit={next.final ? "Redeem" : "Pay coupon"} pendingLabel="Holders are verifying…">
                <input type="hidden" name="bond" value={b.symbol} />
                <p className="op-note">
                  Each holder recomputes its amount from the terms and its holding at the record date, {next.recordDate}, and
                  co-signs only if it agrees.
                </p>
              </ActionForm>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <details className="op">
            <summary>Affirm a purchase</summary>
            <ActionForm action={affirm.bind(null, bank.id)} participant={bank.id} submit="Affirm" pendingLabel="Affirming…">
              <input type="hidden" name="bond" value={b.symbol} />
              <fieldset className="op-field op-choice">
                <legend>Buying in</legend>
                <label>
                  <input type="radio" name="kind" value="issue" defaultChecked /> the issue, from {name(b.agent)}
                </label>
                <label>
                  <input type="radio" name="kind" value="trade" /> a trade, from
                  <select name="seller" aria-label="Seller">
                    {counterparties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </fieldset>
              <UetrField label="UETR to give the seller" />
              <ForWhom clients={clientsOf(bank.id)} />
              <label className="op-field op-units">
                <span>Units</span>
                <input name="units" inputMode="numeric" required autoComplete="off" pattern="[0-9][0-9,]*" />
              </label>
              <Amount currency={currency} name="price" label="Price per unit" />
            </ActionForm>
          </details>
          {b.holdingUnits && b.holdingUnits !== "0" ? (
            <details className="op">
              <summary>Sell to a buyer that affirmed</summary>
              <ActionForm action={sell.bind(null, bank.id)} participant={bank.id} submit="Sell" pendingLabel="Asking the buyer to co-sign…">
                <input type="hidden" name="bond" value={b.symbol} />
                <label className="op-field">
                  <span>Buyer</span>
                  <select name="buyer" required>
                    {counterparties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <UetrField generate={false} label="UETR the buyer affirmed" />
                <ForWhom clients={clientsOf(bank.id)} label="Whose units" />
                <label className="op-field op-units">
                  <span>Units</span>
                  <input name="units" inputMode="numeric" required autoComplete="off" pattern="[0-9][0-9,]*" />
                </label>
                <Amount currency={currency} name="price" label="Price per unit" />
              </ActionForm>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

/** For the bank's own book, or for one of its custody clients at its omnibus wallet (SPEC.md §15). */
function ForWhom({ clients, label = "For" }: { clients: { id: string; name: string }[]; label?: string }) {
  if (clients.length === 0) return null;
  return (
    <label className="op-field">
      <span>{label}</span>
      <select name="client" defaultValue="">
        <option value="">Its own book</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}, in custody
          </option>
        ))}
      </select>
    </label>
  );
}
