import { ActionForm } from "@/components/action-form";
import { rotateKey } from "@/lib/actions";
import { time } from "@/lib/format";
import type { Change, NetworkParticipant, Result, SigningKeys } from "@/lib/services";

const STATUS: Record<Change["status"], string> = {
  proposed: "waiting for approval",
  approved: "approved, being applied",
  requested: "asked of the registry's operator",
  applied: "applied",
  failed: "failed",
  rejected: "rejected",
  expired: "expired",
};

/**
 * The keys a participant signs with (SPEC.md §15): the active one, any
 * waiting to be admitted, and those retired, which keep holding what they
 * held for it but sign nothing. An administrator starts a rotation; it waits
 * for this participant's policy, then for the registry's operator's.
 */
export function Keys({
  participant,
  keys,
  changes,
  timeZone,
}: {
  participant: NetworkParticipant;
  keys: Result<SigningKeys>;
  changes: Result<Change[]>;
  timeZone: string;
}) {
  if (!keys.ok) return null;
  const recent = changes.ok ? changes.value.slice(0, 5) : [];
  return (
    <section className="panel keys" aria-labelledby="keys">
      <div className="panel-head">
        <h2 id="keys">Signing keys</h2>
        <p className="panel-note">Roles follow the active key: one registry change moves them all</p>
      </div>
      <ul className="key-list">
        {keys.value.keys.map((k) => (
          <li key={k.generation} className={`key is-${k.status}`}>
            <span className="key-gen">key {k.generation}</span>
            <code title={k.address}>{k.address}</code>
            <span className="key-status">
              {k.status === "active" ? "signs now" : k.status === "pending" ? "waiting to be admitted" : `retired ${k.retiredAt ? time(k.retiredAt, timeZone) : ""}: holds, signs nothing`}
            </span>
          </li>
        ))}
      </ul>
      <ActionForm action={rotateKey.bind(null, participant.id)} participant={participant.id} submit="Move to a new key" pendingLabel="Asking…">
        {null}
      </ActionForm>
      {recent.length > 0 ? (
        <>
          <h3 className="sub">Administrative changes</h3>
          <ul className="proposal-list is-decided">
            {recent.map((c) => (
              <li key={c.id} className={`proposal is-${c.status}`}>
                <div className="proposal-what">
                  <span>
                    {describeChange(c)}{" "}
                    <code>{c.id.slice(0, 8)}</code>
                  </span>
                  <span className="proposal-who">
                    {STATUS[c.status]} · started by {c.initiator.replace(/^operator:/, "").replace(/^peer:/, "a request from ")} {time(c.createdAt, timeZone)}
                    {c.error ? ` · ${c.error}` : ""}
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

/** An administrative change in a line. */
function describeChange(c: Change): string {
  const r = c.request;
  switch (c.action) {
    case "rotate-key":
      return "Move to a new signing key";
    case "bind-address":
      return r["op"] === "holding" ? `Bind ${String(r["participant"])}'s new custody wallet` : `Admit ${String(r["participant"])}'s new key`;
    case "claim":
      return `Revoke the KYC claim on ${String(r["subject"])}`;
    case "recovery":
      return r["op"] === "recover" ? `Recover ${String(r["holder"])}'s lost wallet` : "Recover the lost omnibus wallet";
    default:
      return c.action;
  }
}
