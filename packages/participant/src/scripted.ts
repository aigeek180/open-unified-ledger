import type { CurrencyCode } from "@oul/domain";
import type { PolicyAction } from "@oul/scenario";
import { FlowRejected } from "./errors.ts";
import { type Affirmation, centralBankOf, type Flow, flowCurrency, flowValue } from "./flows.ts";
import type { FlowRequest, Participant } from "./participant.ts";
import { requirementFor } from "./policy.ts";
import type { InstructionRow } from "./store.ts";

/**
 * Operators for scripted runs: the runtime's tests, the conformance kit and
 * the harness act as a participant's operators would, starting each flow as
 * an operator allowed to and approving it with others until its policy is
 * met. Nothing here bypasses a policy; it only plays its operators.
 */

/** The first operator whose roles let it initiate `action` at its amount. */
export function initiatorFor(participant: Participant, action: PolicyAction, amount?: { minor: bigint; currency: CurrencyCode }): string {
  const requirement = requirementFor(participant.rt.scenario, participant.id, action, amount);
  const operator = participant.operators.operators.find((o) => o.roles.some((r) => requirement.initiate.includes(r)));
  if (!operator) throw new FlowRejected("not-permitted", `No operator of ${participant.id} may initiate ${action}`);
  return operator.id;
}

/** Approve what waits under `subject` with as many eligible operators, other than its initiator, as its policy needs. */
export async function approveAll(participant: Participant, subject: string): Promise<void> {
  for (;;) {
    const proposal = await participant.proposal(subject);
    if (!proposal || proposal.status !== "open") return;
    const next = participant.operators.operators.find(
      (o) =>
        `operator:${o.id}` !== proposal.initiator &&
        o.roles.some((r) => proposal.roles.includes(r)) &&
        !proposal.decisions.some((d) => d.operator === o.id),
    );
    if (!next) throw new Error(`No operator of ${participant.id} is left to approve ${subject}`);
    try {
      await participant.decide(subject, next.id, "approve");
    } catch (error) {
      // Approving the same subject at once (a request repeated concurrently): another approval landed first,
      // or this operator's did. Read the proposal again; anything else is a real refusal.
      if (!(error instanceof FlowRejected && error.reason === "conflicting-instruction")) throw error;
    }
  }
}

/**
 * Start a flow at `initiator` as one of its operators, and approve it as its
 * policy asks there and, for funding, at the central bank that mints it.
 * Returns the initiator's instruction as it stands afterwards.
 */
export async function act(
  initiator: Participant,
  request: FlowRequest,
  participant: (id: string) => Participant | undefined,
): Promise<InstructionRow> {
  const flow = request as unknown as Flow;
  let amount: { minor: bigint; currency: CurrencyCode } | undefined;
  try {
    amount = { minor: flowValue(flow), currency: flowCurrency(flow, initiator.rt.scenario) };
  } catch {
    // An invalid flow: the participant refuses it with its own reason.
  }
  const row = await initiator.initiate(request, initiatorFor(initiator, request.kind, amount));
  if (row.status === "proposed") await approveAll(initiator, row.uetr);
  if (row.flow.kind === "fund") {
    const cb = participant(centralBankOf(row.flow, initiator.rt.scenario));
    if (cb) await approveAll(cb, row.uetr);
  }
  return (await initiator.instruction(row.uetr)) ?? row;
}

/** A co-signer's operator affirms an issue, a trade or a repo flow, and others approve it as its policy asks. */
export async function affirmAs(buyer: Participant, request: Affirmation): Promise<void> {
  const flow = { ...request, deadline: 0 } as Flow;
  const mine =
    request.kind === "bond-issue" ? request.allocations.filter((a) => a.bank === buyer.id) : request.kind === "bond-trade" ? [{ units: request.units }] : [];
  // A buyer's value is what it pays; a repo's, what flowValue says (its cash, or its collateral at the mark).
  const minor =
    request.kind === "bond-issue" || request.kind === "bond-trade"
      ? mine.reduce((t, a) => t + BigInt(a.units) * BigInt(request.price), 0n)
      : flowValue(flow);
  const currency = flowCurrency(flow, buyer.rt.scenario);
  const { status } = await buyer.affirm(request, initiatorFor(buyer, request.kind, { minor, currency }));
  if (status === "proposed") await approveAll(buyer, request.uetr);
}

/** The paying agent's operator pays a bond's next scheduled payment, approved as its policy asks. */
export async function payNextAs(agent: Participant, symbol: string, uetr?: string): Promise<InstructionRow> {
  const row = await agent.payNextBondPayment(symbol, initiatorFor(agent, "bond-coupon"), uetr);
  if (row.status === "proposed") await approveAll(agent, row.uetr);
  return (await agent.instruction(row.uetr)) ?? row;
}
