import type { Metadata } from "next";
import { money, time } from "@/lib/format";
import { confidentialRunsDir, FACTS, type ModeReport, readVisibility } from "@/lib/confidential";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Who sees what · Open Unified Ledger" };

export default async function ConfidentialPage() {
  const report = await readVisibility();
  if (!report) {
    return (
      <article className="seen">
        <header className="ledger-head">
          <div>
            <p className="eyebrow">Confidential mode</p>
            <h1>Who sees what</h1>
          </div>
        </header>
        <section className="offline">
          <p>
            No comparison yet. With the shared ledger and the Paladin nodes up (README, confidential mode), make the same
            payment in each mode and ask each participant what it can see; this page reads what it saves in{" "}
            <code>{confidentialRunsDir}</code>:
          </p>
          <pre>pnpm confidential:compare ca-interbank</pre>
        </section>
      </article>
    );
  }

  const p = report.payment;
  const n = p.names ?? { payerBank: p.payerBank, payer: p.payer, payeeBank: p.payeeBank, payee: p.payee };
  const count = (mode: ModeReport, id: string) => {
    const o = mode.observers.find((x) => x.id === id);
    return o ? FACTS.filter((f) => o.facts[f.key].visible).length : 0;
  };

  return (
    <article className="seen">
      <header className="ledger-head">
        <div>
          <p className="eyebrow">
            Confidential mode · {report.scenario} · measured {time(report.at, "UTC")} UTC
          </p>
          <h1>Who sees what</h1>
        </div>
      </header>

      <p className="interop-lede">
        The same payment twice: <strong>{n.payer}</strong> at {n.payerBank} pays <strong>{n.payee}</strong> at{" "}
        {n.payeeBank} {money(p.amount)} {p.currency}. In the baseline mode the deposits are plain tokens on the shared ledger,
        which every participant validates. In confidential mode each bank's deposits are Noto tokens on its own Paladin
        node; the payment settles atomically on the shared ledger over locks that carry hashes. Each cell is what that
        participant could read, measured.
      </p>

      <p className="seen-summary">
        Every validator sees <strong>{count(report.modes.plain, "validators")}</strong> of {FACTS.length} in the baseline
        mode and <strong>{count(report.modes.confidential, "validators")}</strong> in confidential mode.
      </p>

      <Mode title="Baseline" note="Plain deposit tokens on the shared ledger" mode={report.modes.plain} />
      <Mode title="Confidential" note="Noto deposits on each bank's Paladin node" mode={report.modes.confidential} />
    </article>
  );
}

function Mode({ title, note, mode }: { title: string; note: string; mode: ModeReport }) {
  return (
    <section className="panel seen-mode" aria-labelledby={`mode-${title}`}>
      <div className="panel-head">
        <h2 id={`mode-${title}`}>{title}</h2>
        <p className="panel-note">
          {note} · block {mode.block} · <code title={mode.tx}>{mode.tx.slice(0, 12)}…</code>
        </p>
      </div>
      <div className="seen-scroll">
        <table className="seen-table">
          <thead>
            <tr>
              <th scope="col">Participant</th>
              {FACTS.map((f) => (
                <th key={f.key} scope="col">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mode.observers.map((o) => (
              <tr key={o.id}>
                <th scope="row">{o.label}</th>
                {FACTS.map((f) => {
                  const s = o.facts[f.key];
                  return (
                    <td key={f.key} className={s.visible ? "is-seen" : "is-hidden"} title={s.how}>
                      {s.visible ? <span className="seen-value">{s.value}</span> : <span className="seen-hidden">hidden</span>}
                      <span className="seen-how">{s.how}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
