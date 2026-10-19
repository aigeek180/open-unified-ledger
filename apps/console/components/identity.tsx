import { ActionForm } from "@/components/action-form";
import { revokeClaim } from "@/lib/actions";
import { namer } from "@/lib/format";
import type { IdentityView, Network, NetworkParticipant, Result } from "@/lib/services";

/**
 * Identity for securities (SPEC.md §15, ERC-3643): the participant's own
 * identity and the KYC claims on it, which decide whether it may receive a
 * bond; and, for a trusted claim issuer, the claims it made, each of which an
 * administrator may revoke. A revoked claim stops the holder receiving the
 * bond and leaves what it holds alone.
 */
export function IdentityPanel({ participant, identity, network }: { participant: NetworkParticipant; identity: Result<IdentityView>; network: Network }) {
  if (!identity.ok || (!identity.value.identity && !identity.value.claimIssuer)) return null;
  const n = namer(network);
  const name = (ref: string) => (ref.includes("/") ? n.customer(ref.split("/")[0], ref.split("/")[1]) : n.participant(ref));
  const { claims, issued } = identity.value;
  return (
    <section className="panel identity" aria-labelledby="identity">
      <div className="panel-head">
        <h2 id="identity">Identity for securities</h2>
        <p className="panel-note">ERC-3643: a bond reaches an address only if its identity carries a valid KYC claim</p>
      </div>
      {identity.value.identity ? (
        <>
          <p className="identity-own">
            Identity <code title={identity.value.identity}>{identity.value.identity}</code>
          </p>
          {claims.length === 0 ? (
            <p className="empty">No claim on it: it cannot receive a bond.</p>
          ) : (
            <ul className="claim-list">
              {claims.map((c) => (
                <li key={c.issuerIdentity} className={c.valid ? "is-valid" : "is-revoked"}>
                  KYC by {n.participant(c.issuer)}: {c.valid ? "valid" : "revoked"}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {identity.value.claimIssuer ? (
        <>
          <h3 className="sub">Claims {participant.name} made</h3>
          {issued.length === 0 ? (
            <p className="empty">None yet.</p>
          ) : (
            <ul className="proposal-list">
              {issued.map((c) => (
                <li key={c.subject} className={`proposal ${c.valid ? "" : "is-rejected"}`}>
                  <div className="proposal-what">
                    <span>KYC of {name(c.subject)}</span>
                    <span className="proposal-who">{c.valid ? "valid" : "revoked: it receives no more units, keeps what it holds"}</span>
                  </div>
                  {c.valid ? (
                    <div className="proposal-act">
                      <ActionForm action={revokeClaim.bind(null, participant.id, c.subject)} participant={participant.id} submit="Revoke" pendingLabel="Revoking…" className="op-reject">
                        {null}
                      </ActionForm>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
