import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Live } from "@/components/live";
import { NoNetwork } from "@/components/no-network";
import { shortUetr, time } from "@/lib/format";
import { attempt, readNetwork, service } from "@/lib/services";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ participant: string }>; searchParams: Promise<{ before?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { participant } = await params;
  return { title: `Audit log · ${participant} · Open Unified Ledger` };
}

const ACTION: Record<string, string> = {
  initiated: "Initiated",
  approved: "Approved",
  rejected: "Rejected",
  released: "Released to sign and send",
  signed: "Co-signed",
  submitted: "Submitted to the engine",
  settled: "Settled",
  refused: "Refused",
  expired: "Expired",
  affirmed: "Affirmation in force",
  changed: "Change applied",
};

/**
 * A participant's audit log (SPEC.md §15): every initiation, approval,
 * rejection, signature and submission, newest first, each carrying the hash
 * of the entry before it; and the service's walk of the whole chain, which
 * names the first entry that was edited or whose predecessor was deleted.
 */
export default async function AuditPage({ params, searchParams }: Props) {
  const { participant: id } = await params;
  const { before } = await searchParams;
  const read = await attempt(readNetwork());
  if (!read.ok) return <NoNetwork error={read.error} />;
  const network = read.value;
  const participant = network.participants.find((p) => p.id === id);
  if (!participant?.url) notFound();
  const s = service(participant);
  const [log, verification] = await Promise.all([attempt(s.audit({ limit: 100, ...(before && /^\d+$/.test(before) ? { before } : {}) })), attempt(s.verifyAudit())]);
  const tz = network.scenario.timeZone;
  const broken = verification.ok && !verification.value.ok ? verification.value.brokenAt?.seq : undefined;

  return (
    <article className="ledger audit">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href={`/p/${participant.id}`}>← {participant.name}</Link>
        <span>Audit log</span>
      </nav>
      <header className="ledger-head">
        <div>
          <p className="eyebrow">Audit log · append-only, hash-chained</p>
          <h1>{participant.name}</h1>
        </div>
        <div className="ledger-head-side">
          {verification.ok ? (
            <span className={`seal ${verification.value.ok ? "seal-ok" : "seal-break"}`}>
              <span className="seal-word">{verification.value.ok ? "Chain verifies" : "Chain broken"}</span>
              <span className="seal-block">
                {verification.value.ok
                  ? `${verification.value.entries} entries · head ${verification.value.head.slice(0, 10)}`
                  : `at entry ${verification.value.brokenAt?.seq}: ${verification.value.brokenAt?.reason}`}
              </span>
            </span>
          ) : null}
          <Live />
        </div>
      </header>
      <section className="panel">
        <div className="panel-head">
          <h2>Entries</h2>
          <p className="panel-note">Each entry's hash covers its content and the hash before it, so an edit or a deletion shows where it happened</p>
        </div>
        {!log.ok ? (
          <p className="unavailable">The log could not be read: {log.error}</p>
        ) : log.value.entries.length === 0 ? (
          <p className="empty">Nothing yet. The first flow an operator starts is its first entry.</p>
        ) : (
          <table className="figures audit-log">
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">Who</th>
                <th scope="col">Of</th>
                <th scope="col">Hash · previous</th>
              </tr>
            </thead>
            <tbody>
              {log.value.entries.map((e) => (
                <tr key={e.seq} className={broken === e.seq ? "is-break" : undefined}>
                  <td className="num">{e.seq}</td>
                  <td>{time(e.at, tz)}</td>
                  <td>
                    {ACTION[e.action] ?? e.action}
                    {e.action === "refused" && typeof e.detail["reason"] === "string" ? <span className="audit-detail"> {e.detail["reason"] as string}</span> : null}
                    {e.action === "initiated" && Number(e.detail["required"] ?? 0) > 0 ? (
                      <span className="audit-detail">
                        {" "}
                        needs {String(e.detail["required"])} from {((e.detail["roles"] as string[] | undefined) ?? []).join(" or ")}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <code>{e.actor}</code>
                  </td>
                  <td>
                    {e.subject && /^[0-9a-f-]{36}$/.test(e.subject) ? (
                      <Link href={`/p/${participant.id}/i/${e.subject}`} className="feed-link">
                        {shortUetr(e.subject)}
                      </Link>
                    ) : (
                      <code>{e.subject ?? ""}</code>
                    )}
                  </td>
                  <td>
                    <code title={`${e.hash}\nafter ${e.prev}`}>
                      {e.hash.slice(0, 10)} · {e.prev.slice(0, 10)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {log.ok && log.value.next ? (
          <p className="more">
            <Link href={`/p/${participant.id}/audit?before=${log.value.next}`}>Older entries</Link>
          </p>
        ) : null}
      </section>
    </article>
  );
}
