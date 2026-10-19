/**
 * Why a participant refused a flow. The services turn these into RFC 9457
 * problem details; `reason` is the stable part a client can branch on.
 */
export type RejectionReason =
  | "insufficient-funds"
  | "not-a-party"
  | "unknown-customer"
  | "conflicting-instruction"
  | "invalid-flow"
  /** No operator, or one the participant does not know (SPEC.md §15). */
  | "unauthenticated"
  /** The operator's roles do not let it do this, or it initiated what it tries to approve. */
  | "not-permitted"
  | "not-found";

export class FlowRejected extends Error {
  override readonly name = "FlowRejected";
  readonly reason: RejectionReason;

  constructor(reason: RejectionReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Another participant's service could not be reached; the flow was not started. */
export class PeerUnavailable extends Error {
  override readonly name = "PeerUnavailable";
  readonly participant: string;

  constructor(participant: string, cause: unknown) {
    super(`${participant} could not be reached`, { cause });
    this.participant = participant;
  }
}
