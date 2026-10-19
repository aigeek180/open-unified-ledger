"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { actingOperator, cookieName, operatorToken } from "./operators";
import { harnessUrl, type Operators, readNetwork } from "./services";

/**
 * What an operator starts from a participant's view, sent to that
 * participant's own service: the console decides nothing, it only fills in
 * the request the service's API takes (SPEC.md §4.5), and shows what the
 * service answers.
 */

export type ActionState =
  | { ok: true; uetr: string | null; message: string; at: number; follow: boolean }
  | { ok: false; error: string; at: number }
  | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** An amount as typed, with grouping removed: the service parses it exactly. */
const amount = (form: FormData, name = "amount") => text(form, name).replaceAll(",", "").replaceAll(" ", "");

/** The `Authorization` header of the operator the console acts as at `participant`. */
async function operatorHeader(participant: string, url: string): Promise<Record<string, string>> {
  const operators = await fetch(`${url}/operators`, { cache: "no-store", signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? (r.json() as Promise<Operators>) : null))
    .catch(() => null);
  const operator = await actingOperator(participant, operators);
  return operator ? { authorization: `Bearer ${operatorToken(participant, operator)}` } : {};
}

async function post(participant: string, path: string, body: unknown, message: string, follow = true): Promise<ActionState> {
  const network = await readNetwork();
  const url = network.participants.find((p) => p.id === participant)?.url;
  if (!url) return { ok: false, error: `${participant} runs no service`, at: Date.now() };
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await operatorHeader(participant, url)) },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, error: `${url} did not answer: ${(error as Error).message}`, at: Date.now() };
  }
  const payload = (await response.json().catch(() => ({}))) as { uetr?: string; affirmed?: string; call?: string; subject?: string; status?: string; detail?: string; title?: string };
  if (!response.ok) {
    return { ok: false, error: payload.detail ?? payload.title ?? `${response.status} ${response.statusText}`, at: Date.now() };
  }
  revalidatePath(`/p/${participant}`, "layout");
  // Above its policy's threshold the service holds what was started until an approver approves it.
  const held = payload.status === "proposed" ? "Booked, and held for approval: nothing is signed or sent until an approver approves it" : message;
  return { ok: true, uetr: payload.uetr ?? payload.affirmed ?? payload.call ?? payload.subject ?? null, message: held, at: Date.now(), follow };
}

/** Act as another of the participant's operators from now on, in this browser. */
export async function actAs(participant: string, form: FormData): Promise<void> {
  const operator = text(form, "operator");
  if (!/^[a-z0-9-]+$/.test(operator)) return;
  (await cookies()).set(cookieName(participant), operator, { path: "/", sameSite: "lax", httpOnly: true });
  revalidatePath(`/p/${participant}`, "layout");
}

/** An administrator starts moving the participant to a new signing key (SPEC.md §15). */
export async function rotateKey(participant: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(participant, "/keys/rotate", {}, "Asked the registry's operator to admit a new key", false);
}

/** As a trusted claim issuer, an administrator revokes the KYC claim it made about `subject` (ERC-3643). */
export async function revokeClaim(participant: string, subject: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(participant, "/identity/claims/revoke", { subject }, "Revoking the claim", false);
}

/** A custodian's administrator reports its omnibus wallet lost: the bond's agent recovers its units (SPEC.md §15). */
export async function recoverCustody(participant: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(participant, "/custody/recover", {}, "Asked the registry's operator and the bond's agent to recover the wallet", false);
}

/** The acting operator approves or rejects what waits for the participant's policy. */
export async function decide(participant: string, subject: string, decision: "approve" | "reject", _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(
    participant,
    `/proposals/${encodeURIComponent(subject)}/decisions`,
    { decision },
    decision === "approve" ? "Approved" : "Rejected: its pending entry is voided",
    false,
  );
}

export async function moveWholesale(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const direction = text(form, "direction") === "redeem" ? "redeem" : "fund";
  const currency = text(form, "currency");
  return post(
    participant,
    `/wholesale/${direction}`,
    { amount: amount(form), ...(currency ? { currency } : {}) },
    direction === "fund" ? "Funding requested from the central bank" : "Redemption sent",
  );
}

export async function tokenize(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const direction = text(form, "direction") === "detokenize" ? "detokenize" : "tokenize";
  const customer = text(form, "customer");
  return post(
    participant,
    `/customers/${encodeURIComponent(customer)}/${direction}`,
    { amount: amount(form) },
    direction === "tokenize" ? "Tokenizing the deposit" : "Returning the tokens to deposit",
  );
}

export async function pay(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const [payeeBank = "", payee = ""] = text(form, "payee").split("/");
  const network = await readNetwork();
  const currencyOf = (id: string) => network.participants.find((p) => p.id === id)?.currency;
  const payer = text(form, "payer");
  if (network.fx && currencyOf(payeeBank) !== currencyOf(participant)) {
    // Across currencies (SPEC.md §13): the dealer quotes first, then the payment settles at its quote.
    const url = network.participants.find((p) => p.id === participant)?.url;
    let quote: { id?: string; source?: { amount: string; currency: string }; target?: { amount: string; currency: string }; rate?: string; detail?: string };
    try {
      const response = await fetch(`${url}/fx/quotes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: currencyOf(payeeBank), amount: amount(form) }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      quote = (await response.json()) as typeof quote;
      if (!response.ok) return { ok: false, error: quote.detail ?? `${response.status} ${response.statusText}`, at: Date.now() };
    } catch (error) {
      return { ok: false, error: `${url} did not answer: ${(error as Error).message}`, at: Date.now() };
    }
    const dealer = network.participants.find((p) => p.id === network.fx!.dealer)?.name ?? network.fx.dealer;
    return post(
      participant,
      "/payments",
      { payer, payeeBank, payee, quote: quote.id },
      `Paying ${quote.target!.currency} ${quote.target!.amount} for ${quote.source!.currency} ${quote.source!.amount} at ${dealer}'s quote of ${quote.rate}`,
    );
  }
  return post(participant, "/payments", { payer, payeeBank, payee, amount: amount(form) }, "Payment sent for the payee's bank to co-sign");
}

export async function affirm(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const bond = text(form, "bond");
  const kind = text(form, "kind") === "trade" ? "trade" : "issue";
  const units = text(form, "units").replaceAll(",", "");
  // For its own book, or for a custody client at its omnibus wallet (SPEC.md §15).
  const client = text(form, "client");
  const body = {
    kind,
    uetr: text(form, "uetr"),
    units,
    price: amount(form, "price"),
    ...(client ? { client } : {}),
    ...(kind === "trade" ? { seller: text(form, "seller") } : {}),
  };
  return post(
    participant,
    `/bonds/${encodeURIComponent(bond)}/affirmations`,
    body,
    kind === "issue" ? "Affirmed: the agent can now issue under" : "Affirmed: the seller can now sell under",
    // Nothing settles until the agent or seller acts, so there is no timeline to follow yet.
    false,
  );
}

export async function sell(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const bond = text(form, "bond");
  return post(
    participant,
    `/bonds/${encodeURIComponent(bond)}/trades`,
    {
      uetr: text(form, "uetr"),
      buyer: text(form, "buyer"),
      units: text(form, "units").replaceAll(",", ""),
      price: amount(form, "price"),
      ...(text(form, "client") ? { client: text(form, "client") } : {}),
    },
    "Trade sent for the buyer to co-sign",
  );
}

export async function issue(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const bond = text(form, "bond");
  const clients = form.getAll("client");
  const allocations = form
    .getAll("bank")
    .map((bank, index) => ({
      bank: String(bank),
      units: String(form.getAll("units")[index] ?? "").replaceAll(",", "").trim(),
      ...(clients[index] ? { client: String(clients[index]) } : {}),
    }))
    .filter((a) => a.units !== "" && a.units !== "0");
  if (allocations.length === 0) return { ok: false, error: "Allocate units to at least one bank", at: Date.now() };
  return post(
    participant,
    `/bonds/${encodeURIComponent(bond)}/issue`,
    { uetr: text(form, "uetr"), price: amount(form, "price"), allocations },
    "Issue sent for the buyers to co-sign",
  );
}

export async function payNext(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const bond = text(form, "bond");
  return post(participant, `/bonds/${encodeURIComponent(bond)}/payments/next`, {}, "Next payment sent for the holders to verify and co-sign");
}

// ---------------------------------------------------------------- repo (SPEC.md §5.7–§5.10)

const units = (form: FormData, name = "units") => text(form, name).replaceAll(",", "");

/** A repo's terms as typed: the collateral, its mark, the purchase price, the rate, the haircut and the dates. */
const repoTerms = (form: FormData) => ({
  uetr: text(form, "uetr"),
  bond: text(form, "bond"),
  units: units(form),
  mark: amount(form, "mark"),
  cash: amount(form, "cash"),
  rate: text(form, "rate"),
  haircut: text(form, "haircut"),
  startDate: text(form, "startDate"),
  endDate: text(form, "endDate"),
});

/** Every bond's mark as typed, one per collateral bond the repo names. */
const marks = (form: FormData) =>
  form
    .getAll("markBond")
    .map((bond, index) => ({ bond: String(bond), price: String(form.getAll("markPrice")[index] ?? "").replaceAll(",", "").trim() }))
    .filter((m) => m.price !== "");

/** As lender: agree a repo's terms, for the borrower to open under the same UETR. */
export async function affirmRepo(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return post(participant, "/repos/affirmations", { ...repoTerms(form), borrower: text(form, "counterparty") }, "Affirmed: the borrower can now open the repo under", false);
}

/** As borrower: open a repo the lender affirmed. */
export async function openRepo(participant: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return post(participant, "/repos", { ...repoTerms(form), lender: text(form, "counterparty") }, "Repo sent for the lender to co-sign");
}

/** Call the margin agreed marks give: the lender a shortfall, the borrower an excess. */
export async function callMargin(participant: string, repo: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return post(participant, `/repos/${repo}/margin-calls`, { marks: marks(form), asOf: text(form, "asOf"), bond: text(form, "bond") }, "Margin called: the other side delivers it under", false);
}

/** Deliver the margin the other side called. */
export async function meetCall(participant: string, repo: string, call: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(participant, `/repos/${repo}/margin`, { call }, "Margin sent for the caller to co-sign");
}

const substitution = (form: FormData) => ({
  uetr: text(form, "uetr"),
  outgoing: { bond: text(form, "outgoing"), units: units(form) },
  incoming: text(form, "incoming"),
  marks: marks(form),
  asOf: text(form, "asOf"),
});

/** As lender: agree a substitution at marks. */
export async function affirmSubstitution(participant: string, repo: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return post(participant, `/repos/${repo}/substitutions/affirmations`, substitution(form), "Affirmed: the borrower can now substitute under", false);
}

/** As borrower: substitute under the UETR the lender affirmed. */
export async function substitute(participant: string, repo: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return post(participant, `/repos/${repo}/substitutions`, substitution(form), "Substitution sent for the lender to co-sign");
}

/** As borrower, at the end date: every unit back against principal plus interest. */
export async function closeRepo(participant: string, repo: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(participant, `/repos/${repo}/close`, {}, "Close sent for the lender to check and co-sign");
}

/** As lender: pass on a coupon received on collateral. */
export async function passOnCoupon(participant: string, repo: string, bond: string, period: number, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return post(participant, `/repos/${repo}/manufactured`, { bond, period }, "Manufactured payment sent for the borrower to check and co-sign");
}

// ---------------------------------------------------------------- the harness

async function harness(path: string, body: unknown, message: string): Promise<ActionState> {
  let response: Response;
  try {
    response = await fetch(`${harnessUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, error: `The harness at ${harnessUrl} did not answer: ${(error as Error).message}`, at: Date.now() };
  }
  const payload = (await response.json().catch(() => ({}))) as { detail?: string; title?: string };
  if (!response.ok) return { ok: false, error: payload.detail ?? payload.title ?? `${response.status}`, at: Date.now() };
  revalidatePath("/harness");
  return { ok: true, uetr: null, message, at: Date.now(), follow: false };
}

export async function injectFault(kind: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  return harness(`/faults/${encodeURIComponent(kind)}`, {}, "Injected: follow it in the steps");
}

export async function runFlows(_prev: ActionState, form: FormData): Promise<ActionState> {
  const count = Number(text(form, "count") || 5);
  const faults = Number(text(form, "faults") || 0);
  return harness("/steps", { count, faults }, "Running: follow them in the steps");
}

export async function checkRun(_prev: ActionState, _form: FormData): Promise<ActionState> {
  return harness("/check", {}, "Checking: participants catch up first");
}
