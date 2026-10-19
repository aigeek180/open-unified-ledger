import type { Metadata } from "next";
import Link from "next/link";
import { InteropTimeline } from "@/components/interop-timeline";
import { time } from "@/lib/format";
import {
  caseKey,
  COORDINATOR_LABEL,
  FAULT_LABEL,
  type InteropCase,
  type InteropReport,
  listReports,
  readReport,
  runsDir,
} from "@/lib/interop";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Interop · Open Unified Ledger" };

type Props = { searchParams: Promise<{ run?: string; case?: string }> };

const COORDINATORS: InteropCase["coordinator"][] = ["unified", "htlc", "notary"];
const FAULTS: InteropCase["fault"][] = ["none", "coordinator-crash", "message-loss", "participant-offline", "late-commit"];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function windowText(c: InteropCase): string {
  const { disagreedMs, disagreesAtEnd } = c.summary;
  if (disagreedMs === null) return "nothing settled";
  if (disagreesAtEnd) return "ledgers disagree, for good";
  if (disagreedMs < 50) return "no window";
  return `disagreed ${seconds(disagreedMs)}`;
}

export default async function InteropPage({ searchParams }: Props) {
  const { run, case: selected } = await searchParams;
  const [report, runs] = await Promise.all([readReport(run), listReports()]);

  if (!report) {
    return (
      <article className="interop">
        <Head />
        <section className="offline">
          <p>
            No interop run yet. With both ledgers up and deployed (README, interop mode), run every coordinator under every
            fault; this page reads what it saves in <code>{runsDir}</code>:
          </p>
          <pre>pnpm interop ca-interbank</pre>
        </section>
      </article>
    );
  }

  const byKey = new Map(report.cases.map((c) => [caseKey(c), c]));
  const misses = report.cases.filter((c) => !c.matches).length;
  const current: InteropCase =
    (selected ? byKey.get(selected) : undefined) ??
    byKey.get("htlc.participant-offline") ??
    report.cases.find((c) => c.outcome === "inconsistent") ??
    report.cases[0]!;
  const runParam = run && runs.includes(run) ? run : undefined;
  const href = (key: string) => `/interop?${new URLSearchParams({ ...(runParam ? { run: runParam } : {}), case: key })}`;

  return (
    <article className="interop">
      <Head report={report} misses={misses} />

      <p className="interop-lede">
        {report.fx ? (
          <>
            One payment across currencies, three ways. <strong>Unified</strong> settles all four legs, {report.fx.from} and{" "}
            {report.fx.to}, in one transaction on one ledger: payment versus payment. <strong>HTLC</strong> and the{" "}
            <strong>notary</strong> split it by currency: the payer's burn and its bank's {report.fx.from} to {report.fx.dealer}{" "}
            on ledger 1, the dealer's {report.fx.to} and the payee's mint on ledger 2, each part locked and then settled or
            released on its own ledger. Each runs under each fault on both real ledgers.
          </>
        ) : (
          <>
            One interbank transfer, three ways. <strong>Unified</strong> settles all three legs in one transaction on one
            ledger. <strong>HTLC</strong> and the <strong>notary</strong> split it: the payer's burn and the wholesale transfer
            on ledger 1, the payee's mint on ledger 2, each part locked and then settled or released on its own ledger. Each
            runs under each fault on both real ledgers.
          </>
        )}
      </p>

      {runs.length > 1 ? (
        <nav className="interop-runs" aria-label="Saved runs">
          <span>Runs</span>
          {runs.slice(0, 8).map((file) => {
            const at = file.replace(/\.json$/, "").replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3");
            const isCurrent = (runParam ?? runs[0]) === file;
            return (
              <Link key={file} href={`/interop?run=${encodeURIComponent(file)}`} aria-current={isCurrent ? "page" : undefined}>
                {time(at, "UTC")}
              </Link>
            );
          })}
          <span className="interop-runs-tz">UTC</span>
        </nav>
      ) : null}

      <section className="panel" aria-labelledby="matrix">
        <div className="panel-head">
          <h2 id="matrix">Every coordinator under every fault</h2>
          <p className="panel-note">Each case must end as SPEC.md §7 says; pick one to see its timeline</p>
        </div>
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Fault</th>
              {COORDINATORS.map((c) => (
                <th key={c} scope="col">
                  {COORDINATOR_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FAULTS.map((f) => (
              <tr key={f}>
                <th scope="row">{FAULT_LABEL[f]}</th>
                {COORDINATORS.map((co) => {
                  const c = byKey.get(`${co}.${f}`);
                  if (!c) return <td key={co} className="is-missing">not run</td>;
                  const isCurrent = c === current;
                  return (
                    <td key={co} className={isCurrent ? "is-current" : undefined}>
                      <Link href={href(caseKey(c))} className={`cell is-${c.outcome}`} aria-current={isCurrent ? "true" : undefined}>
                        <span className="cell-outcome">{c.outcome}</span>
                        <span className="cell-window">{windowText(c)}</span>
                        {!c.matches ? <span className="cell-miss">expected {c.expected}</span> : null}
                      </Link>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel case" aria-labelledby="case">
        <div className="case-head">
          <div>
            <p className="eyebrow">
              {current.amount} {current.currency}
              {current.target ? ` → ${current.target.amount} ${current.target.currency}` : ""} · <code title={current.uetr}>{current.uetr.slice(0, 8)}</code> ·{" "}
              {seconds(current.durationMs)}
            </p>
            <h2 id="case">
              {COORDINATOR_LABEL[current.coordinator]} · {FAULT_LABEL[current.fault]}
            </h2>
            <p className="case-story">{current.story}</p>
          </div>
          <span className={`stamp ${current.outcome === "committed" ? "stamp-final" : current.outcome === "aborted" ? "stamp-plain" : "stamp-void"}`}>
            <span className="stamp-word">{current.outcome}</span>
            <span className="stamp-block">{windowText(current)}</span>
          </span>
        </div>
        {report.fx ? (
          <p className="case-story">
            Across currencies: {report.fx.from} on ledger 1, {report.fx.to} on ledger 2, through {report.fx.dealer}. Where the ledgers end
            disagreeing, one currency was delivered and the other not: FX settlement risk, which the unified mode has none of.
          </p>
        ) : null}
        <InteropTimeline c={current} labels={report.parts} />
        <div className="itl-legend" aria-hidden="true">
          <span className="key is-locked">locked</span>
          <span className="key is-settled">settled</span>
          <span className="key is-released">released</span>
          <span className="key is-window">ledgers disagree</span>
        </div>
        <ol className="narrative">
          {current.events.map((e, i) => (
            <li key={i}>
              <span className="narrative-n">{i + 1}</span>
              <span className="narrative-when">{seconds(e.ms)}</span>
              <span className="narrative-who">{e.actor}</span>
              <span className="narrative-what">{e.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Head({ report, misses }: { report?: InteropReport; misses?: number }) {
  return (
    <header className="ledger-head">
      <div>
        <p className="eyebrow">
          Interop mode
          {report ? ` · ${report.scenario} · ledger 1 chain ${report.chains.ledger1}, ledger 2 chain ${report.chains.ledger2}` : ""}
        </p>
        <h1>Interop</h1>
      </div>
      {report ? (
        <span className={`seal ${misses === 0 ? "seal-ok" : "seal-break"}`}>
          <span className="seal-word">{misses === 0 ? "Every case as expected" : `${misses} not as expected`}</span>
          <span className="seal-block">
            {report.cases.length} cases · run {time(report.at, "UTC")} UTC
          </span>
        </span>
      ) : null}
    </header>
  );
}
