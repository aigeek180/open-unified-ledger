import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import type { Operators } from "./services";

/**
 * Who the console acts as at each participant (SPEC.md §15). The operator is
 * chosen in the console and kept in a cookie per participant; every request
 * that starts or decides something carries that operator's sandbox token,
 * derived from public labels as each service derives it (packages/scenario
 * `operatorToken`), so it is public and for the sandbox only.
 */

export const cookieName = (participant: string) => `oul-operator-${participant}`;

export function operatorToken(participant: string, operator: string): string {
  return createHash("sha256").update(`open-unified-ledger/dev/operator/${participant}/${operator}`).digest("hex");
}

/** The operator chosen for `participant`, if the console has chosen one. */
export async function chosenOperator(participant: string): Promise<string | undefined> {
  return (await cookies()).get(cookieName(participant))?.value;
}

/**
 * The operator the console acts as: the one chosen, if the participant still
 * has it, otherwise its first operator allowed to start flows.
 */
export async function actingOperator(participant: string, operators: Operators | null): Promise<string | undefined> {
  const chosen = await chosenOperator(participant);
  if (!operators) return chosen;
  if (chosen && operators.operators.some((o) => o.id === chosen)) return chosen;
  return (operators.operators.find((o) => o.roles.includes("operator")) ?? operators.operators[0])?.id;
}
