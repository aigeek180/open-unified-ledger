import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ChooseOperator } from "@/components/choose-operator";
import { actAs, decide } from "@/lib/actions";
import { shortUetr, time } from "@/lib/format";
import type { Network, NetworkParticipant, Operators, Proposal, Result } from "@/lib/services";

const ROLE = { operator: "operator", approver: "approver", administrator: "administrator" } as const;

/** Who the console acts as at this participant, and the policy that operator works under (SPEC.md §15). */
export function ActingAs({ participant, operators, acting }: { participant: NetworkParticipant; operators: Result<Operators>; acting: string | undefined }) {
  if (!operators.ok) return null;
  const current = operators.value.operators.find((o) => o.id === acting);
  return (
    <section className="panel acting" aria-labelledby="acting">
      <div className="panel-head">
        <h2 id="acting">Acting as</h2>
        <p className="panel-note">Each request carries this operator's token; {participant.name}'s service checks its roles</p>
      </div>
      <form action={actAs.bind(null, participant.id)} className="acting-form">
        <ChooseOperator
          name="operator"
          value={acting ?? ""}
          options={operators.value.operators.map((o) => ({ id: o.id, label: `${o.name} · ${o.roles.map((r) => ROLE[r]).join(", ")}` }))}
        />
      </form>
      {current ? (
        <p className="acting-note">
          {current.roles.includes("administrator") && !current.roles.includes("operator") ? "Starts and approves administrative changes. " : null}
          {current.roles.includes("operator") ? "Starts flows; cannot approve them. " : null}
          {current.roles.includes("approver") ? "Approves what others start; never what it started itself. " : null}
        </p>
      ) : null}
      {operators.value.policy.length > 0 ? (
        <ul className="policy-rules">
          {operators.value.policy.map((rule, index) => (
            <li key={index}>
              <span className="policy-actions">{rule.actions.join(", ")}</span>
              {rule.over ? <> above {rule.over}</> : null}: {rule.approvals === 0 ? "no second step" : `${rule.approvals} approval${rule.approvals > 1 ? "s" : ""} by ${rule.by.join(" or ")}`}
              {rule.initiate ? <>, started only by {rule.initiate.join(" or ")}</> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No rule asks for a second step: every operator's own role is the approval.</p>
      )}
    </section>
  );
}

/** What waits for this participant's approvers, and what they decided lately. */
export function Approvals({
  participant,
  proposals,
  network,
  acting,
}: {
  participant: NetworkParticipant;
  proposals: Result<Proposal[]>;
  network: Network;
  acting: string | undefined;
}) {
  const tz = network.scenario.timeZone;
  if (!proposals.ok) return <p className="unavailable">Approvals could not be read: {proposals.error}</p>;
  const open = proposals.value.filter((p) => p.status === "open");
  const decided = proposals.value.filter((p) => p.status !== "open").slice(0, 6);
  const link = (p: Proposal) =>
    p.kind === "instruction" ? (
      <Link href={`/p/${participant.id}/i/${p.subject}`} className="feed-link">
        {p.action} {shortUetr(p.subject)}
      </Link>
    ) : (
      <span>
        {p.kind === "affirmation" ? "affirmation" : p.action} <code>{shortUetr(p.subject)}</code>
      </span>
    );
  return (
    <section className="panel approvals" aria-labelledby="approvals">
      <div className="panel-head">
        <h2 id="approvals">Waiting for approval</h2>
        <p className="panel-note">Booked, but neither signed nor sent until its policy is met (invariant 12)</p>
      </div>
      {open.length === 0 ? (
        <p className="empty">Nothing waits. A flow above its policy's threshold stops here until an approver other than its initiator approves it.</p>
      ) : (
        <ul className="proposal-list">
          {open.map((p) => (
            <li key={p.subject} className="proposal">
              <div className="proposal-what">
                {link(p)}
                <span className="proposal-who">
                  started by {p.initiator.replace(/^operator:/, "").replace(/^peer:/, "request from ")} {time(p.createdAt, tz)} · needs {p.required - p.decisions.filter((d) => d.decision === "approve").length} more from{" "}
                  {p.roles.join(" or ")}
                </span>
              </div>
              <div className="proposal-act">
                <ActionForm action={decide.bind(null, participant.id, p.subject, "approve")} participant={participant.id} submit="Approve" pendingLabel="Approving…" disabled={!acting}>
                  {null}
                </ActionForm>
                <ActionForm action={decide.bind(null, participant.id, p.subject, "reject")} participant={participant.id} submit="Reject" pendingLabel="Rejecting…" className="op-reject" disabled={!acting}>
                  {null}
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 ? (
        <>
          <h3 className="sub">Decided</h3>
          <ul className="proposal-list is-decided">
            {decided.map((p) => (
              <li key={p.subject} className={`proposal is-${p.status}`}>
                <div className="proposal-what">
                  {link(p)}
                  <span className="proposal-who">
                    {p.status} {p.decidedAt ? time(p.decidedAt, tz) : ""}
                    {p.decisions.length > 0 ? ` · ${p.decisions.map((d) => `${d.operator} ${d.decision === "approve" ? "approved" : "rejected"}`).join(", ")}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
