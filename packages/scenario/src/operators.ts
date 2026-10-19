import { createHash } from "node:crypto";
import { type CurrencyCode, parseDecimal, parseMoney } from "@oul/domain";
import { z } from "zod";

/**
 * Who operates each participant and what its policy requires before a flow
 * is signed or sent (SPEC.md §15, invariant 12): `operators.yaml` in a
 * scenario folder. Operators and their roles are fictional; in the sandbox an
 * operator is identified by a token derived from public labels, as the
 * sandbox's keys are, which the console sends. A real bank would put its
 * identity provider there; the policy checks would not change.
 */

/** What an operator may do: initiate flows, approve them, or initiate and approve administrative changes. */
export const ROLES = ["operator", "approver", "administrator"] as const;
export type Role = (typeof ROLES)[number];

/** The flows of SPEC.md §5 and §13, as policy actions; repo's (§5.7–§5.10) among them. */
export const FLOW_ACTIONS = [
  "fund",
  "redeem",
  "tokenize",
  "detokenize",
  "interbank",
  "pvp",
  "bond-issue",
  "bond-trade",
  "bond-coupon",
  "bond-redeem",
  "repo-open",
  "repo-margin",
  "repo-substitute",
  "repo-close",
  "repo-manufactured",
] as const;

/**
 * Administrative changes (SPEC.md §15): moving to a new signing key, binding
 * another participant's key or address in the registry, issuing or revoking
 * an identity claim, registering an identity for a bond, and recovering a lost
 * wallet. `administration` in a rule names all of them.
 */
export const ADMIN_ACTIONS = ["rotate-key", "bind-address", "claim", "identity", "recovery"] as const;

export type FlowAction = (typeof FLOW_ACTIONS)[number];
export type AdminAction = (typeof ADMIN_ACTIONS)[number];
export type PolicyAction = FlowAction | AdminAction;

export const isAdminAction = (action: string): action is AdminAction => (ADMIN_ACTIONS as readonly string[]).includes(action);

/** Who may initiate an action when no rule says otherwise. */
export const DEFAULT_INITIATORS: Readonly<Record<"flow" | "administration", readonly Role[]>> = {
  flow: ["operator", "approver"],
  administration: ["administrator"],
};

export interface Operator {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly Role[];
}

/**
 * One rule of a policy. The first rule whose actions include the action and
 * whose threshold the amount exceeds decides: how many approvals the action
 * needs, from operators other than its initiator holding one of `by`, and
 * which roles may initiate it.
 */
export interface PolicyRule {
  readonly actions: readonly PolicyAction[];
  /** In major units of the flow's own currency; the rule applies above it. Absent: at any amount. */
  readonly over?: string;
  readonly approvals: number;
  readonly by: readonly Role[];
  /** Roles that may initiate under this rule; the action's defaults if absent. */
  readonly initiate?: readonly Role[];
}

export interface ParticipantOperators {
  readonly operators: readonly Operator[];
  readonly policy: readonly PolicyRule[];
}

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase words joined by hyphens");
const role = z.enum(ROLES);
const action = z.enum([...FLOW_ACTIONS, ...ADMIN_ACTIONS, "administration"]);

export const operatorsFile = z.record(
  id,
  z.strictObject({
    operators: z.array(z.strictObject({ id, name: z.string().min(1), roles: z.array(role).min(1) })).min(1),
    policy: z
      .array(
        z.strictObject({
          actions: z.array(action).min(1),
          over: z.string().optional(),
          approvals: z.number().int().min(0).max(5),
          by: z.array(role).default([]),
          initiate: z.array(role).min(1).optional(),
        }),
      )
      .default([]),
  }),
);
export type OperatorsFile = z.infer<typeof operatorsFile>;

/** A participant the scenario gives no operators has one, holding every role, and a policy needing no approvals. */
export const DEFAULT_OPERATORS: ParticipantOperators = {
  operators: [{ id: "operator", name: "Operator", roles: [...ROLES] }],
  policy: [],
};

/** Check one participant's operators and policy; returns it in its loaded form. */
export function buildOperators(
  participant: string,
  raw: OperatorsFile[string],
  currencies: readonly CurrencyCode[],
  issues: string[],
): ParticipantOperators {
  const where = `operators.yaml: ${participant}`;
  const ids = raw.operators.map((o) => o.id);
  for (const dup of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) issues.push(`${where}: operator "${dup}" appears twice`);
  const policy: PolicyRule[] = raw.policy.map((rule, index) => {
    const at = `${where}.policy[${index}]`;
    const actions = rule.actions.flatMap((a) => (a === "administration" ? [...ADMIN_ACTIONS] : [a]));
    if (rule.over !== undefined) {
      try {
        if (parseDecimal(rule.over).isNegative()) issues.push(`${at}: over must not be negative`);
        // The threshold is read in each flow's own currency, so it must be exact in every one of them.
        for (const code of currencies) parseMoney(code, rule.over);
      } catch (error) {
        issues.push(`${at}: over: ${(error as Error).message}`);
      }
      if (actions.some(isAdminAction)) issues.push(`${at}: administrative changes have no amount to compare with over`);
    }
    if (rule.approvals > 0 && rule.by.length === 0) issues.push(`${at}: approvals need the roles that may give them (by)`);
    const initiate = rule.initiate ?? [...new Set(actions.flatMap((a) => DEFAULT_INITIATORS[isAdminAction(a) ? "administration" : "flow"]))];
    // Every operator that may initiate under the rule must find enough others to approve it.
    for (const initiator of raw.operators.filter((o) => o.roles.some((r) => initiate.includes(r)))) {
      const others = raw.operators.filter((o) => o.id !== initiator.id && o.roles.some((r) => rule.by.includes(r))).length;
      if (others < rule.approvals) {
        issues.push(`${at}: needs ${rule.approvals} approvals besides ${initiator.id}'s own, but only ${others} other operators hold ${rule.by.join(" or ")}`);
      }
    }
    if (!raw.operators.some((o) => o.roles.some((r) => initiate.includes(r)))) {
      issues.push(`${at}: no operator holds a role that may initiate it (${initiate.join(", ")})`);
    }
    return {
      actions,
      ...(rule.over !== undefined ? { over: rule.over } : {}),
      approvals: rule.approvals,
      by: rule.by,
      ...(rule.initiate ? { initiate: rule.initiate } : {}),
    };
  });
  return { operators: raw.operators, policy };
}

/**
 * The token that identifies an operator to its participant's service:
 * derived from public labels, so it is public and for the sandbox only, as
 * the sandbox's keys are.
 */
export function operatorToken(participant: string, operator: string): string {
  return createHash("sha256").update(`open-unified-ledger/dev/operator/${participant}/${operator}`).digest("hex");
}

/**
 * The same scenario with each participant's policy emptied, its operators
 * kept: for tests that study other rules and would otherwise have to approve
 * every flow they start. Never used outside tests.
 */
export function withoutPolicies<S extends { readonly operators: Readonly<Record<string, ParticipantOperators>> }>(scenario: S): S {
  return {
    ...scenario,
    operators: Object.fromEntries(Object.entries(scenario.operators).map(([id, o]) => [id, { ...o, policy: [] }])),
  };
}
