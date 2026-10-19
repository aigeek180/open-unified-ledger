import type { Instruction, Network } from "./services";

/**
 * Amounts arrive as exact decimal strings ("2500.00") and are only ever
 * regrouped as text: never parsed into a number, so nothing is rounded.
 */
export function money(amount: string): string {
  // Only a plain decimal is regrouped; a check that states a sum in words is shown as it is.
  if (!/^-?\d+(\.\d+)?$/.test(amount)) return amount;
  const negative = amount.startsWith("-");
  const [whole = "0", fraction] = (negative ? amount.slice(1) : amount).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

export function isZero(amount: string): boolean {
  return /^-?0*(\.0*)?$/.test(amount);
}

export function block(n: string): string {
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** A count with its noun: "1 fault", "4 faults". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function shortUetr(uetr: string): string {
  return uetr.slice(0, 8);
}

export function time(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** A participant's display name, or a customer as `Customer at Bank`, from the scenario's public directory. */
export function namer(network: Network) {
  const names = new Map(network.participants.map((p) => [p.id, p.name]));
  const customers = new Map(network.participants.flatMap((p) => (p.customers ?? []).map((c) => [`${p.id}/${c.id}`, c.name] as const)));
  const participant = (id: string | undefined) => (id ? (names.get(id) ?? id) : "?");
  const customerName = (bank: string | undefined, id: string | undefined) => customers.get(`${bank}/${id}`) ?? id ?? "?";
  const customer = (bank: string | undefined, id: string | undefined) => `${customerName(bank, id)} at ${participant(bank)}`;
  return { participant, customer, customerName };
}

const KIND: Record<Instruction["kind"], string> = {
  fund: "Fund",
  redeem: "Redeem",
  tokenize: "Tokenize",
  detokenize: "Detokenize",
  interbank: "Payment",
  pvp: "Payment across currencies",
  "bond-issue": "Issue",
  "bond-trade": "Trade",
  "bond-coupon": "Coupon",
  "bond-redeem": "Redemption",
  "repo-open": "Repo opened",
  "repo-margin": "Repo margin",
  "repo-substitute": "Repo substitution",
  "repo-close": "Repo closed",
  "repo-manufactured": "Manufactured payment",
};

export function kindLabel(kind: Instruction["kind"]): string {
  return KIND[kind];
}

/** What an instruction does, in a line, named from the reading participant's directory. */
export function describe(i: Instruction, network: Network): string {
  const n = namer(network);
  const wholesale = network.instruments.wholesale.find((w) => w.currency === i.currency)?.symbol ?? `wholesale ${i.currency}`;
  switch (i.kind) {
    case "fund":
      return `${n.participant(i.bank)} moves reserves into ${wholesale}`;
    case "redeem":
      return `${n.participant(i.bank)} returns ${wholesale} to reserves`;
    case "tokenize":
      return `${n.customerName(i.bank, i.customer)}: deposit into tokens at ${n.participant(i.bank)}`;
    case "detokenize":
      return `${n.customerName(i.bank, i.customer)}: tokens back to deposit at ${n.participant(i.bank)}`;
    case "interbank":
      return `${n.customer(i.payerBank, i.payer)} → ${n.customer(i.payeeBank, i.payee)}`;
    case "pvp":
      return `${n.customer(i.payerBank, i.payer)} → ${n.customer(i.payeeBank, i.payee)}, ${i.quote?.from}→${i.quote?.to} through ${n.participant(i.quote?.dealer)}`;
    case "bond-issue":
      return `${i.bond} to ${(i.allocations ?? []).map((a) => n.participant(a.bank)).join(", ")}`;
    case "bond-trade":
      return `${money(i.units ?? "0")} ${i.bond} from ${n.participant(i.seller)} to ${n.participant(i.buyer)}`;
    case "bond-coupon":
      return `${i.bond} coupon ${i.period ?? ""}`.trim();
    case "bond-redeem":
      return `${i.bond} at maturity`;
    case "repo-open":
      return `${n.participant(i.lender)} lends to ${n.participant(i.borrower)} against ${money(i.units ?? "0")} ${i.bond}`;
    case "repo-margin":
      return i.direction === "return"
        ? `${n.participant(i.lender)} returns ${money(i.units ?? "0")} ${i.bond} to ${n.participant(i.borrower)}, repo ${shortUetr(i.repo ?? "")}`
        : `${n.participant(i.borrower)} delivers ${money(i.units ?? "0")} ${i.bond} to ${n.participant(i.lender)}, repo ${shortUetr(i.repo ?? "")}`;
    case "repo-substitute":
      return `${n.participant(i.borrower)} takes back ${money(i.outgoing?.units ?? "0")} ${i.outgoing?.bond} for ${money(i.incoming?.units ?? "0")} ${i.incoming?.bond}, repo ${shortUetr(i.repo ?? "")}`;
    case "repo-close":
      return `${n.participant(i.borrower)} repays ${n.participant(i.lender)} principal plus interest, every unit back, repo ${shortUetr(i.repo ?? "")}`;
    case "repo-manufactured":
      return `${n.participant(i.lender)} passes ${i.bond} coupon ${i.period ?? ""} on to ${n.participant(i.borrower)}, repo ${shortUetr(i.repo ?? "")}`;
  }
}

/** The price an instruction settles at, where it has one: a dealer's quote, or a repo's terms. */
export function terms(i: Instruction): string | null {
  if (i.kind === "pvp" && i.rate) return `At the dealer's quote of ${i.rate} ${i.target?.currency} per ${i.currency}`;
  if (i.kind === "repo-open" && i.rate) return `At ${i.rate} a year, haircut ${i.haircut}, from ${i.startDate} to ${i.endDate}`;
  return null;
}

export function roleLabel(role: Instruction["role"]): string {
  return role === "submitter" ? "sent" : role === "approver" ? "co-signed" : "booked";
}
