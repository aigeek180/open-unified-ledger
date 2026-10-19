import type { CurrencyCode } from "@oul/domain";
import { parseMoney } from "@oul/domain";
import type { Executor } from "@oul/ledger";
import {
  DEFAULT_INITIATORS,
  isAdminAction,
  type Operator,
  operatorToken,
  type ParticipantOperators,
  type PolicyAction,
  type Role,
  type Scenario,
} from "@oul/scenario";
import { sql } from "drizzle-orm";
import type { AuditEntry } from "./audit.ts";
import { FlowRejected } from "./errors.ts";

/**
 * Approval policies (SPEC.md §15, invariant 12). Each participant's policy
 * says, for every outgoing flow by kind and amount and for every
 * administrative change, how many approvals it needs and from which roles.
 * An operator initiates; the flow waits, booked but unsigned and unsent,
 * until operators other than its initiator holding one of those roles have
 * approved it; only then is it signed and sent. Holding the permission is the
 * approval: an initiator whose role alone satisfies the policy needs no
 * second step.
 */

export interface Requirement {
  readonly action: PolicyAction;
  /** The index of the rule that decided, or null when none matched. */
  readonly rule: number | null;
  readonly required: number;
  /** Roles whose holders may approve. */
  readonly roles: readonly Role[];
  /** Roles whose holders may initiate. */
  readonly initiate: readonly Role[];
}

export function operatorsOf(scenario: Scenario, participant: string): ParticipantOperators {
  const found = scenario.operators[participant];
  if (!found) throw new RangeError(`"${participant}" has no operators in ${scenario.id}`);
  return found;
}

export function findOperator(scenario: Scenario, participant: string, id: string): Operator | undefined {
  return operatorsOf(scenario, participant).operators.find((o) => o.id === id);
}

/** The operator a sandbox token identifies, if any (scenario `operatorToken`). */
export function operatorByToken(scenario: Scenario, participant: string, token: string): Operator | undefined {
  return operatorsOf(scenario, participant).operators.find((o) => operatorToken(participant, o.id) === token);
}

/**
 * What the policy asks of `action`: the first rule naming the action whose
 * threshold the amount exceeds (a rule without one matches any amount);
 * nothing beyond the initiator's permission when none does.
 */
export function requirementFor(
  scenario: Scenario,
  participant: string,
  action: PolicyAction,
  amount?: { readonly minor: bigint; readonly currency: CurrencyCode },
): Requirement {
  const { policy } = operatorsOf(scenario, participant);
  const defaults = DEFAULT_INITIATORS[isAdminAction(action) ? "administration" : "flow"];
  for (const [index, rule] of policy.entries()) {
    if (!rule.actions.includes(action)) continue;
    if (rule.over !== undefined && amount && amount.minor <= parseMoney(amount.currency, rule.over).minor) continue;
    return { action, rule: index, required: rule.approvals, roles: rule.by, initiate: rule.initiate ?? defaults };
  }
  return { action, rule: null, required: 0, roles: [], initiate: defaults };
}

export const operatorActor = (operator: string) => `operator:${operator}`;
export const peerActor = (participant: string) => `peer:${participant}`;

/** Refuse an operator whose roles do not let it initiate under `requirement`. */
export function assertMayInitiate(operator: Operator, requirement: Requirement): void {
  if (!operator.roles.some((r) => requirement.initiate.includes(r))) {
    throw new FlowRejected(
      "not-permitted",
      `${operator.id} (${operator.roles.join(", ")}) may not initiate ${requirement.action}; it needs ${requirement.initiate.join(" or ")}`,
    );
  }
}

// ---------------------------------------------------------------- proposals (migrations/0005)

export type ProposalKind = "instruction" | "affirmation" | "change";
export type ProposalStatus = "open" | "approved" | "rejected" | "expired";

export interface Proposal {
  readonly subject: string;
  readonly kind: ProposalKind;
  readonly action: string;
  readonly initiator: string;
  readonly rule: number | null;
  readonly required: number;
  readonly roles: readonly Role[];
  readonly status: ProposalStatus;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decisions: readonly { operator: string; decision: "approve" | "reject"; roles: readonly Role[]; at: Date }[];
}

export async function insertProposal(
  db: Executor,
  p: { subject: string; kind: ProposalKind; initiator: string; requirement: Requirement },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO proposals (subject, kind, action, initiator, rule, required, roles, status)
    VALUES (${p.subject}, ${p.kind}, ${p.requirement.action}, ${p.initiator}, ${p.requirement.rule}, ${p.requirement.required},
            ${JSON.stringify(p.requirement.roles)}::jsonb, 'open')
  `);
}

const proposalFromRow = (row: Record<string, unknown>, decisions: Proposal["decisions"]): Proposal => ({
  subject: String(row["subject"]),
  kind: row["kind"] as ProposalKind,
  action: String(row["action"]),
  initiator: String(row["initiator"]),
  rule: row["rule"] == null ? null : Number(row["rule"]),
  required: Number(row["required"]),
  roles: row["roles"] as Role[],
  status: row["status"] as ProposalStatus,
  createdAt: new Date(String(row["created_at"])),
  decidedAt: row["decided_at"] == null ? null : new Date(String(row["decided_at"])),
  decisions,
});

async function decisionsOf(db: Executor, subjects: readonly string[]) {
  if (subjects.length === 0) return new Map<string, Proposal["decisions"][number][]>();
  const rows = (
    await db.execute(sql`
      SELECT subject, operator, decision, roles, at FROM proposal_decisions
       WHERE subject IN (${sql.join(subjects.map((s) => sql`${s}`), sql`, `)}) ORDER BY at
    `)
  ).rows;
  const map = new Map<string, Proposal["decisions"][number][]>();
  for (const r of rows) {
    const list = map.get(String(r["subject"])) ?? [];
    list.push({ operator: String(r["operator"]), decision: r["decision"] as "approve" | "reject", roles: r["roles"] as Role[], at: new Date(String(r["at"])) });
    map.set(String(r["subject"]), list);
  }
  return map;
}

export async function getProposal(db: Executor, subject: string, options: { forUpdate?: boolean } = {}): Promise<Proposal | undefined> {
  const row = (await db.execute(sql`SELECT * FROM proposals WHERE subject = ${subject} ${options.forUpdate ? sql`FOR UPDATE` : sql``}`)).rows[0];
  if (!row) return undefined;
  return proposalFromRow(row, (await decisionsOf(db, [subject])).get(subject) ?? []);
}

export async function listProposals(db: Executor, options: { status?: ProposalStatus; limit: number }): Promise<Proposal[]> {
  const rows = (
    await db.execute(sql`
      SELECT * FROM proposals ${options.status ? sql`WHERE status = ${options.status}` : sql``}
       ORDER BY created_at DESC LIMIT ${options.limit}
    `)
  ).rows;
  const decisions = await decisionsOf(db, rows.map((r) => String(r["subject"])));
  return rows.map((r) => proposalFromRow(r, decisions.get(String(r["subject"])) ?? []));
}

export async function recordDecision(
  db: Executor,
  subject: string,
  operator: Operator,
  decision: "approve" | "reject",
): Promise<void> {
  await db.execute(sql`
    INSERT INTO proposal_decisions (subject, operator, decision, roles)
    VALUES (${subject}, ${operator.id}, ${decision}, ${JSON.stringify(operator.roles)}::jsonb)
  `);
}

export async function setProposalStatus(db: Executor, subject: string, status: ProposalStatus): Promise<void> {
  await db.execute(sql`UPDATE proposals SET status = ${status}, decided_at = clock_timestamp() WHERE subject = ${subject}`);
}

/** Approved proposals whose subject has not gone on yet: what a restarted runtime must still release. */
export async function approvedInstructionsWaiting(db: Executor): Promise<string[]> {
  const rows = (
    await db.execute(sql`
      SELECT p.subject FROM proposals p JOIN instructions i ON i.uetr = p.subject
       WHERE p.kind = 'instruction' AND p.status = 'approved' AND i.status = 'proposed'
    `)
  ).rows;
  return rows.map((r) => String(r["subject"]));
}

/**
 * Check an operator's decision against a proposal: it is still open, the
 * operator is not its initiator, holds a role that may approve it (any such
 * role may also reject it), and has not decided before.
 */
export function assertMayDecide(proposal: Proposal, operator: Operator): void {
  if (proposal.status !== "open") {
    throw new FlowRejected("conflicting-instruction", `${proposal.subject} is ${proposal.status}, not waiting for approval`);
  }
  if (proposal.initiator === operatorActor(operator.id)) {
    throw new FlowRejected("not-permitted", `${operator.id} initiated ${proposal.subject} and cannot approve it`);
  }
  if (!operator.roles.some((r) => proposal.roles.includes(r))) {
    throw new FlowRejected("not-permitted", `${operator.id} (${operator.roles.join(", ")}) cannot decide on it; it needs ${proposal.roles.join(" or ")}`);
  }
  if (proposal.decisions.some((d) => d.operator === operator.id)) {
    throw new FlowRejected("conflicting-instruction", `${operator.id} has already decided on ${proposal.subject}`);
  }
}

// ---------------------------------------------------------------- invariant 12, from the audit log alone

/**
 * Invariant 12 over an audit log, oldest entry first: everything released
 * (an instruction going to its co-signers and the engine, an affirmation
 * taking effect, a change being applied) was initiated first, with the
 * approvals its policy required recorded before the release, each by a
 * different operator other than the initiator holding a role the policy
 * named; and nothing was submitted before it was released. The harness reads
 * the log from outside the services and runs the same check.
 */
export function policyViolations(entries: readonly AuditEntry[]): { subject: string; problem: string }[] {
  const violations: { subject: string; problem: string }[] = [];
  const initiated = new Map<string, { actor: string; required: number; roles: readonly string[] }>();
  const approvals = new Map<string, Set<string>>();
  const released = new Set<string>();
  for (const e of entries) {
    const subject = e.subject;
    if (!subject) continue;
    switch (e.action) {
      case "initiated": {
        const detail = e.detail as { required?: number; roles?: string[] };
        initiated.set(subject, { actor: e.actor, required: Number(detail.required ?? 0), roles: detail.roles ?? [] });
        break;
      }
      case "approved": {
        const start = initiated.get(subject);
        const roles = ((e.detail as { roles?: string[] }).roles ?? []) as string[];
        if (!start) violations.push({ subject, problem: `approved by ${e.actor} before it was initiated` });
        else if (e.actor === start.actor) violations.push({ subject, problem: `approved by its own initiator ${e.actor}` });
        else if (!roles.some((r) => start.roles.includes(r))) violations.push({ subject, problem: `approved by ${e.actor}, whose roles the policy does not name` });
        else approvals.set(subject, new Set([...(approvals.get(subject) ?? []), e.actor]));
        break;
      }
      case "released":
      case "affirmed":
      case "changed": {
        const start = initiated.get(subject);
        const given = approvals.get(subject)?.size ?? 0;
        if (!start) violations.push({ subject, problem: `${e.action} without being initiated` });
        else if (given < start.required) violations.push({ subject, problem: `${e.action} with ${given} of the ${start.required} approvals its policy requires` });
        released.add(subject);
        break;
      }
      case "submitted":
        if (!released.has(subject)) violations.push({ subject, problem: "submitted before it was released" });
        break;
      default:
        break;
    }
  }
  return violations;
}
