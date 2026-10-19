import { ActionForm } from "@/components/action-form";
import { recoverCustody } from "@/lib/actions";
import { money } from "@/lib/format";
import type { CustodyView, NetworkParticipant, Result } from "@/lib/services";

/**
 * Client custody (SPEC.md §15): the bonds a bank holds for its clients at its
 * omnibus wallet, each client's position as its own books record it, and the
 * units on chain they must add up to (invariant 13). A lost omnibus wallet is
 * recovered by the bond's agent to a new one, with its units.
 */
export function CustodyPanel({ bank, custody }: { bank: NetworkParticipant; custody: Result<CustodyView> }) {
  if (!custody.ok || !custody.value.custodian) return null;
  const v = custody.value;
  const name = (id: string) => bank.customers.find((c) => c.id === id)?.name ?? id;
  return (
    <section className="panel custody" aria-labelledby="custody">
      <div className="panel-head">
        <h2 id="custody">Client custody</h2>
        <p className="panel-note">Off the balance sheet: positions must add up to the omnibus wallet's units on chain (invariant 13)</p>
      </div>
      <ul className="key-list">
        {v.wallets.map((w) => (
          <li key={w.address} className={`key is-${w.status === "active" ? "active" : "retired"}`}>
            <span className="key-gen">wallet {w.generation}</span>
            <code title={w.address}>{w.address}</code>
            <span className="key-status">{w.status === "active" ? "holds for clients" : w.status === "pending" ? "being recovered to" : "lost: its units were recovered"}</span>
          </li>
        ))}
      </ul>
      {v.bonds.map((b) => {
        const total = b.positions.reduce((t, p) => t + BigInt(p.units), 0n);
        return (
          <table key={b.bond} className="figures">
            <thead>
              <tr>
                <th scope="col">{b.bond}</th>
                <th scope="col" className="num">
                  Units
                </th>
              </tr>
            </thead>
            <tbody>
              {b.positions.map((p) => (
                <tr key={p.client} className={p.units === "0" ? "is-quiet" : undefined}>
                  <th scope="row">{name(p.client)}</th>
                  <td className="num">{money(p.units)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={total.toString() === b.onChain ? undefined : "is-break"}>
                <th scope="row">Positions · omnibus on chain</th>
                <td className="num">
                  {money(total.toString())} {total.toString() === b.onChain ? "=" : "≠"} {money(b.onChain)}
                </td>
              </tr>
            </tfoot>
          </table>
        );
      })}
      <ActionForm action={recoverCustody.bind(null, bank.id)} participant={bank.id} submit="Report the omnibus wallet lost" pendingLabel="Asking…" className="op-reject">
        {null}
      </ActionForm>
    </section>
  );
}
