import { block } from "@/lib/format";
import type { InstructionStatus } from "@/lib/services";

/**
 * The mark an instruction carries: final at commit (rulebook §5) is a stamp
 * with its block; a refusal or an expiry is stamped too; anything still in
 * flight is not stamped at all, only labelled.
 */
export function Stamp({ status, settledBlock }: { status: InstructionStatus; settledBlock: string | null }) {
  if (status === "settled") {
    return (
      <span className="stamp stamp-final" title={`Final at block ${settledBlock}`}>
        <span className="stamp-word">Final</span>
        <span className="stamp-block">block {settledBlock ? block(settledBlock) : "?"}</span>
      </span>
    );
  }
  if (status === "failed" || status === "expired" || status === "rejected") {
    return (
      <span className="stamp stamp-void">
        <span className="stamp-word">{status === "failed" ? "Refused" : status === "rejected" ? "Rejected" : "Expired"}</span>
      </span>
    );
  }
  return <span className="in-flight">{status === "awaiting" ? "awaiting counterparty" : status === "proposed" ? "waiting for approval" : status}</span>;
}

/** A participant's books against the chain: reconciled at a block, a break, or not yet checked. */
export function BooksSeal({ ok, at }: { ok: boolean | null; at: string | null }) {
  if (ok === null || at === null) return <span className="seal seal-none">Not reconciled yet</span>;
  return (
    <span className={`seal ${ok ? "seal-ok" : "seal-break"}`}>
      <span className="seal-word">{ok ? "Books = chain" : "Break"}</span>
      <span className="seal-block">at block {block(at)}</span>
    </span>
  );
}
