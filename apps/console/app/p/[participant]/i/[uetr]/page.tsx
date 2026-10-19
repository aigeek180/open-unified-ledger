import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoNetwork } from "@/components/no-network";
import { Live } from "@/components/live";
import { Stamp } from "@/components/stamp";
import { block, describe, kindLabel, money, namer, roleLabel, terms, time } from "@/lib/format";
import { highlightXml, labelOf, legKindOf, type Place, placeOf } from "@/lib/messages";
import {
  attempt,
  type InstructionDetail,
  type JournalEntry,
  type Leg,
  type MessageRef,
  type Network,
  type NetworkParticipant,
  readNetwork,
  service,
} from "@/lib/services";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ participant: string; uetr: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { uetr } = await params;
  return { title: `${uetr.slice(0, 8)} · Open Unified Ledger` };
}

interface Message extends MessageRef {
  label: string;
  xml: string | null;
}

export default async function InstructionPage({ params }: Props) {
  const { participant: id, uetr } = await params;
  if (!/^[0-9a-f-]{36}$/.test(uetr)) notFound();
  const read = await attempt(readNetwork());
  if (!read.ok) return <NoNetwork error={read.error} />;
  const network = read.value;
  const participant = network.participants.find((p) => p.id === id);
  if (!participant?.url) notFound();
  const s = service(participant);
  const n = namer(network);

  const detail = await attempt(s.instruction(uetr));
  if (!detail.ok) {
    return (
      <Shell participant={participant} uetr={uetr}>
        <p className="unavailable">{detail.error}</p>
      </Shell>
    );
  }

  // Not a party here: the central bank may still have posted its side from the chain.
  if (detail.value === null) {
    const observed = await attempt(s.journalFor(uetr));
    if (observed.ok && observed.value) {
      return (
        <Shell participant={participant} uetr={uetr}>
          <header className="instr-head">
            <div>
              <p className="eyebrow">Observed on the shared ledger</p>
              <h1>Not a party</h1>
              <p className="instr-desc">
                {participant.name} neither sent nor signed this instruction. It saw the movement on its accounts in a
                committed block and posted it from the chain.
              </p>
            </div>
            {observed.value.block ? <Stamp status="settled" settledBlock={observed.value.block} /> : null}
          </header>
          <Books entry={observed.value} participant={participant} messages={[]} timeZone={network.scenario.timeZone} />
        </Shell>
      );
    }
    return (
      <Shell participant={participant} uetr={uetr}>
        <h1 className="instr-missing">{participant.name} has no record of this instruction</h1>
        <p className="empty">Each participant sees only instructions it sent, signed, booked or observed on its own accounts.</p>
      </Shell>
    );
  }

  const i = detail.value;
  const refs = await attempt(s.messages(uetr));
  const messages: Message[] = refs.ok
    ? await Promise.all(
        refs.value.map(async (m) => ({ ...m, label: labelOf(m, n.participant), xml: await s.messageXml(m).catch(() => null) })),
      )
    : [];
  const at = (place: Place) => messages.filter((m) => placeOf(m) === place);
  const tz = network.scenario.timeZone;

  return (
    <Shell participant={participant} uetr={uetr}>
      <header className="instr-head">
        <div>
          <p className="eyebrow">
            {kindLabel(i.kind)} · {participant.name} {roleLabel(i.role)} it
          </p>
          <h1>
            {money(i.amount)} <span className="instr-ccy">{i.currency}</span>
            {i.target ? (
              <>
                {" → "}
                {money(i.target.amount)} <span className="instr-ccy">{i.target.currency}</span>
              </>
            ) : null}
          </h1>
          {terms(i) ? <p className="instr-desc">{terms(i)}</p> : null}
          <p className="instr-desc">{describe(i, network)}</p>
        </div>
        <div className="instr-head-side">
          <Stamp status={i.status} settledBlock={i.settledBlock} />
          <Live />
        </div>
      </header>

      <Track i={i} network={network} participant={participant} />

      <section className="instr-section" aria-labelledby="on-ledger">
        <div className="instr-main">
          <h2 id="on-ledger">On the shared ledger</h2>
          <p className="panel-note">One instruction: every leg settles in the same transaction, or none does.</p>
          <Legs legs={i.legs} />
        </div>
        <Messages messages={at("ledger")} empty="No ledger message concerns this participant." />
      </section>

      {i.journal ? (
        <Books entry={i.journal} participant={participant} messages={at("books")} timeZone={tz} />
      ) : (
        <section className="instr-section">
          <div className="instr-main">
            <h2>In {participant.name}'s books</h2>
            <p className="empty">No entry: {participant.name} signed this instruction without booking a side of it.</p>
          </div>
          <Messages messages={at("books")} empty="" />
        </section>
      )}

      {at("outcome").length > 0 ? (
        <section className="instr-section" aria-labelledby="outcome">
          <div className="instr-main">
            <h2 id="outcome">Outcome</h2>
            <Outcome i={i} timeZone={tz} />
          </div>
          <Messages messages={at("outcome")} empty="" />
        </section>
      ) : null}
    </Shell>
  );
}

function Shell({ participant, uetr, children }: { participant: NetworkParticipant; uetr: string; children: React.ReactNode }) {
  return (
    <article className="instr">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href={`/p/${participant.id}`}>← {participant.name}</Link>
        <code>{uetr}</code>
      </nav>
      {children}
    </article>
  );
}

/** The instruction's life in order: requested, signed, sent, and final or not. */
function Track({ i, network, participant }: { i: InstructionDetail; network: Network; participant: NetworkParticipant }) {
  const n = namer(network);
  const tz = network.scenario.timeZone;
  const signedBy = new Set(i.approvals.map((a) => a.by));
  const dead = i.status === "failed" || i.status === "expired" || i.status === "rejected";
  const settled = i.status === "settled";
  const sent = i.txHash !== null || i.status === "settled";
  // The submitter checks every instruction against the engine first; a refusal there mines nothing.
  const refusedBeforeSending = i.status === "failed" && i.txHash === null;
  const steps: { title: string; detail: React.ReactNode; state: "done" | "now" | "todo" | "dead" }[] = [
    {
      title: "Requested",
      detail: (
        <>
          {time(i.createdAt, tz)}
          {i.journal ? <> · booked pending in {participant.name}'s books</> : null}
        </>
      ),
      state: "done",
    },
    // Its participant's policy (SPEC.md §15): approvals by operators other than its initiator, before anything is signed.
    ...(i.policy
      ? [
          {
            title: i.policy.status === "approved" ? "Approved" : i.policy.status === "rejected" ? "Approval rejected" : i.policy.status === "expired" ? "Not approved in time" : "Waiting for approval",
            detail: (
              <>
                started by {i.policy.initiator.replace(/^operator:/, "").replace(/^peer:/, "a request from ")}; needs {i.policy.required} from {i.policy.roles.join(" or ")}
                {i.policy.decisions.length > 0 ? ` · ${i.policy.decisions.map((d) => `${d.operator} ${d.decision === "approve" ? "approved" : "rejected"} ${time(d.at, tz)}`).join(", ")}` : ""}
              </>
            ),
            state: (i.policy.status === "approved" ? "done" : i.policy.status === "open" ? "now" : "dead") as "done" | "now" | "dead",
          },
        ]
      : []),
    {
      title: i.approvers.length ? "Signed" : "No co-signature needed",
      detail: i.approvers.length ? (
        <ul className="sigs">
          {i.approvers.map((a) => (
            <li key={a} className={signedBy.has(a) || settled ? "sig-yes" : "sig-unknown"}>
              {n.participant(a)}
              {signedBy.has(a) ? " signed" : settled ? " signed: the engine settles nothing without it" : " · not recorded here"}
            </li>
          ))}
        </ul>
      ) : (
        <>the sender's own authority covers every leg</>
      ),
      state: settled || i.approvers.every((a) => signedBy.has(a)) ? "done" : dead ? "dead" : "now",
    },
    refusedBeforeSending
      ? {
          title: "Not sent",
          detail: <>the engine refused it when {n.participant(i.submitter)} checked it, so no transaction was mined</>,
          state: "dead",
        }
      : {
          title: `Sent by ${n.participant(i.submitter)}`,
          detail: i.txHash ? <code title={i.txHash}>tx {i.txHash.slice(0, 12)}…</code> : sent ? "to the settlement engine" : dead ? "never reached the ledger" : "waiting",
          state: sent ? "done" : dead ? "dead" : "todo",
        },
    i.status === "settled"
      ? {
          title: `Final at block ${block(i.settledBlock ?? "?")}`,
          detail: i.journal?.postedAt ? <>posted {time(i.journal.postedAt, tz)}</> : "committed",
          state: "done",
        }
      : dead
        ? {
            title: i.status === "failed" ? "Refused" : i.status === "rejected" ? "Rejected" : "Expired",
            detail: i.status === "expired" ? `nothing settled by ${time(i.deadline, tz)}` : <Reason error={i.error} />,
            state: "dead",
          }
        : { title: "Final", detail: <>by {time(i.deadline, tz)} or not at all</>, state: "todo" },
  ];
  return (
    <ol className="track" aria-label="What happened">
      {steps.map((step, index) => (
        <li key={index} className={`track-step is-${step.state}`}>
          <span className="track-n" aria-hidden="true">
            {index + 1}
          </span>
          <span className="track-title">{step.title}</span>
          <span className="track-detail">{step.detail}</span>
        </li>
      ))}
    </ol>
  );
}

const LEG_VERB = { mint: "Mint", burn: "Burn", transfer: "Transfer" } as const;

function Legs({ legs }: { legs: Leg[] }) {
  return (
    <table className="figures legs">
      <thead>
        <tr>
          <th scope="col">Leg</th>
          <th scope="col">From</th>
          <th scope="col">To</th>
          <th scope="col" className="num">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {legs.map((leg, index) => (
          <tr key={index} className={`leg-${leg.tokenKind ?? "other"}`}>
            <th scope="row">
              <span className="leg-verb">{LEG_VERB[leg.kind]}</span> <span className="leg-token">{leg.token}</span>
            </th>
            <td>{leg.from ? leg.from.name : <span className="is-quiet">issued</span>}</td>
            <td>{leg.to ? leg.to.name : <span className="is-quiet">redeemed</span>}</td>
            <td className="num">
              {leg.amount !== undefined ? (
                <>
                  {money(leg.amount)} <span className="unit">{leg.currency}</span>
                </>
              ) : (
                `${money(leg.units ?? "0")} units`
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Books({
  entry,
  participant,
  messages,
  timeZone,
}: {
  entry: JournalEntry;
  participant: NetworkParticipant;
  messages: Message[];
  timeZone: string;
}) {
  const status =
    entry.status === "posted"
      ? `Posted ${entry.postedAt ? time(entry.postedAt, timeZone) : ""}${entry.block ? ` with block ${block(entry.block)}` : ""}`
      : entry.status === "voided"
        ? `Voided ${entry.voidedAt ? time(entry.voidedAt, timeZone) : ""}: nothing settled, so nothing is owed`
        : "Pending until the block that settles it";
  return (
    <section className="instr-section" aria-labelledby="in-books">
      <div className="instr-main">
        <h2 id="in-books">In {participant.name}'s books</h2>
        <p className="panel-note">
          Entry {entry.id} · {status}
        </p>
        <table className={`figures journal is-${entry.status}`}>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="num">
                Debit
              </th>
              <th scope="col" className="num">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line, index) => {
              // An entry across currencies balances in each: every line says which.
              const unit = new Set(entry.lines.map((l) => l.currency)).size > 1 ? <span className="unit"> {line.currency}</span> : null;
              return (
                <tr key={index}>
                  <th scope="row" className={line.side === "credit" ? "is-credit" : undefined}>
                    <code className="account-code">{line.account}</code>
                  </th>
                  <td className="num">{line.side === "debit" ? <>{money(line.amount)}{unit}</> : ""}</td>
                  <td className="num">{line.side === "credit" ? <>{money(line.amount)}{unit}</> : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Messages messages={messages} empty="" />
    </section>
  );
}

function Outcome({ i, timeZone }: { i: InstructionDetail; timeZone: string }) {
  if (i.status === "settled") {
    return <p className="outcome">Accepted and settled: final at block {block(i.settledBlock ?? "?")}.</p>;
  }
  if (i.status === "failed") {
    return (
      <p className="outcome is-dead">
        Nothing moved. <Reason error={i.error} />
      </p>
    );
  }
  if (i.status === "expired") {
    return <p className="outcome is-dead">Expired at {time(i.deadline, timeZone)} with nothing settled.</p>;
  }
  return <p className="outcome">Pending: settles by {time(i.deadline, timeZone)} or not at all.</p>;
}

function Messages({ messages, empty }: { messages: Message[]; empty: string }) {
  return (
    <aside className="instr-messages" aria-label="ISO 20022 messages">
      {messages.length === 0 ? (
        empty ? <p className="empty">{empty}</p> : null
      ) : (
        messages.map((m) => (
          <details key={m.name} className={`message leg-${legKindOf(m) ?? "none"}`}>
            <summary>
              <span className="message-type">
                {m.type}
                <span>.{m.version.split(".").slice(2).join(".")}</span>
              </span>
              <span className="message-label">{m.label}</span>
              <code className="message-id">{m.msgId}</code>
            </summary>
            {m.xml ? (
              // highlightXml escapes the XML before adding any markup of its own.
              <pre className="xml" dangerouslySetInnerHTML={{ __html: highlightXml(m.xml) }} />
            ) : (
              <p className="unavailable">The message could not be read.</p>
            )}
          </details>
        ))
      )}
    </aside>
  );
}

/** Why an instruction failed, with the engine's rule named as the contract does. */
function Reason({ error }: { error: string | null }) {
  if (!error) return null;
  const rule = error.match(/^refused by the engine: (\w+)$/)?.[1];
  return rule ? (
    <>
      The settlement engine refused it: <code>{rule}</code>
    </>
  ) : (
    <>{error}</>
  );
}
