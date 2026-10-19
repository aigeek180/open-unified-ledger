"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavParticipant {
  id: string;
  name: string;
  kind: "central-bank" | "bank" | "issuer";
  agent: string | null;
  /** The latest reconciliation, "down" when the service did not answer, null for a participant without one. */
  reconciled: boolean | null | "down";
}

const KIND = { "central-bank": "Central bank", bank: "Bank", issuer: "Issuer" } as const;

export function ParticipantNav({ participants }: { participants: NavParticipant[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Participants">
      <ul className="tabs">
        {participants.map((p) => {
          if (p.kind === "issuer") {
            return (
              <li key={p.id} className="tab tab-issuer">
                <span className="tab-name">{p.name}</span>
                <span className="tab-kind">Issuer · through {p.agent}</span>
              </li>
            );
          }
          const href = `/p/${p.id}`;
          const current = pathname === href || pathname.startsWith(`${href}/`);
          const state = p.reconciled === "down" ? "down" : p.reconciled === false ? "break" : p.reconciled ? "ok" : "none";
          const stateLabel = { down: "service down", break: "break", ok: "reconciled", none: "not reconciled yet" }[state];
          return (
            <li key={p.id}>
              <Link href={href} className="tab" aria-current={current ? "page" : undefined}>
                <span className="tab-name">{p.name}</span>
                <span className="tab-kind">
                  <span className={`tab-light light-${state}`} aria-hidden="true" />
                  {KIND[p.kind]} · {stateLabel}
                </span>
              </Link>
            </li>
          );
        })}
        <li className="tab-sep" aria-hidden="true" />
        <li>
          <Link href="/harness" className="tab" aria-current={pathname === "/harness" ? "page" : undefined}>
            <span className="tab-name">Harness</span>
            <span className="tab-kind">Flows, faults and invariant checks</span>
          </Link>
        </li>
        <li>
          <Link href="/interop" className="tab" aria-current={pathname === "/interop" ? "page" : undefined}>
            <span className="tab-name">Interop</span>
            <span className="tab-kind">One transfer across two ledgers</span>
          </Link>
        </li>
        <li>
          <Link href="/confidential" className="tab" aria-current={pathname === "/confidential" ? "page" : undefined}>
            <span className="tab-name">Who sees what</span>
            <span className="tab-kind">Baseline and confidential modes</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}
