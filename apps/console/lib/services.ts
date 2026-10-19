/**
 * The console reads each participant's own service and nothing else (SPEC.md
 * §4.6): a participant's view shows only what that participant's service
 * answers. The directory comes from any one service's `/network`, the central
 * bank's by default.
 */

const ENTRY = (process.env["OUL_CONSOLE_ENTRY"] ?? "http://127.0.0.1:7100").replace(/\/$/, "");

export interface NetworkParticipant {
  id: string;
  name: string;
  kind: "central-bank" | "bank" | "issuer";
  validator: boolean;
  agent?: string;
  /** The currency of a central bank's or bank's own books. */
  currency?: string;
  /** The currencies a bank holds reserves in. */
  reserves?: string[];
  address: string | null;
  url: string | null;
  customers: { id: string; name: string }[];
}

export interface Network {
  self: string;
  scenario: { id: string; name: string; currencies: string[]; timeZone: string };
  participants: NetworkParticipant[];
  instruments: {
    /** One per currency, issued by that currency's central bank. */
    wholesale: { symbol: string; issuer: string; currency: string }[];
    deposits: { symbol: string; issuer: string; currency: string }[];
    bonds: { symbol: string; name: string; issuer: string; agent: string; currency: string }[];
  };
  /** The FX dealer of a scenario of two currencies, with the rates it quotes. */
  fx: { dealer: string; quoteSeconds: number; rates: { from: string; to: string; rate: string }[] } | null;
  /** Client custody: each custodian bank and the customers it holds bonds for. */
  custody?: { bank: string; clients: string[] }[];
  /** Repo between the banks: its day count, the bonds it accepts, how long a margin call may stay unmet. */
  repo?: { dayCount: string; collateral: string[]; marginCallSeconds: number } | null;
  deployment: { startBlock: string; deployedAt: string; chainId: number };
}

/** A dealer's quote, as the bank that asked for it or the dealer that gave it keeps it. */
export interface Quote {
  id: string;
  role: "dealer" | "requester";
  dealer: string;
  requester: string;
  source: { amount: string; currency: string };
  target: { amount: string; currency: string };
  rate: string;
  expiresAt: string;
  /** The payment that settles it, once one has. */
  uetr: string | null;
  createdAt: string;
}

export interface Health {
  participant: string;
  kind: string;
  reconciledBlock: string | null;
  reconciled: boolean | null;
}

export interface Account {
  account: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  mirrored: boolean;
  currency: string;
  posted: string;
  available: string;
  pendingDebits: string;
  pendingCredits: string;
}

export interface Reconciliation {
  participant: string;
  block: string | null;
  ok: boolean | null;
  checks: { invariant: number; account: string; books: string; chain: string; ok: boolean }[];
  breaks: { id: string; block: string; kind: "unexplained" | "mismatch"; uetr: string | null; tx_hash: string; detail: unknown; recorded_at: string }[];
}

export type InstructionStatus = "proposed" | "ready" | "submitted" | "awaiting" | "settled" | "failed" | "expired" | "rejected";

/** A participant's operators and policy (SPEC.md §15); tokens never travel. */
export interface Operators {
  participant: string;
  operators: { id: string; name: string; roles: ("operator" | "approver" | "administrator")[] }[];
  policy: { actions: string[]; over?: string; approvals: number; by: string[]; initiate?: string[] }[];
}

/** What waits for a participant's policy, or got its decision. */
export interface Proposal {
  subject: string;
  kind: "instruction" | "affirmation" | "change";
  action: string;
  initiator: string;
  rule: number | null;
  required: number;
  roles: string[];
  status: "open" | "approved" | "rejected" | "expired";
  createdAt: string;
  decidedAt: string | null;
  decisions: { operator: string; decision: "approve" | "reject"; roles: string[]; at: string }[];
}

export interface SigningKeys {
  participant: string;
  current: string;
  keys: { generation: number; address: string; status: "active" | "pending" | "retired"; createdAt: string; retiredAt: string | null }[];
}

/** An administrative change started here or asked of this participant (SPEC.md §15). */
export interface Change {
  id: string;
  action: string;
  request: Record<string, unknown>;
  initiator: string;
  status: "proposed" | "approved" | "requested" | "applied" | "failed" | "rejected" | "expired";
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimView {
  subject: string;
  identity: string;
  issuer: string;
  issuerIdentity: string;
  topic: string;
  valid: boolean;
}

/** A participant's identity for securities and the claims on it; as a trusted issuer, the claims it made. */
export interface IdentityView {
  identity: string | null;
  claims: ClaimView[];
  claimIssuer: string | null;
  issued: ClaimView[];
}

/** A custodian's omnibus wallets and its clients' positions, against the units on chain (SPEC.md §15). */
export interface CustodyView {
  bank: string;
  custodian: boolean;
  clients: string[];
  wallets: { address: string; generation: number; status: "active" | "pending" | "lost" }[];
  block: string;
  bonds: { bond: string; onChain: string; positions: { client: string; units: string }[] }[];
}

/** A repo as one side sees it (SPEC.md §5.7–§5.10): its terms, the collateral its record holds, and what is owed. */
export interface RepoView {
  id: string;
  role: "lender" | "borrower";
  counterparty: string;
  terms: { lender: string; borrower: string; amount: string; currency: string; rate: string; haircut: string; startDate: string; endDate: string; dayCount: string };
  collateral: { bond: string; units: string }[];
  status: "open" | "closed";
  openedBlock: string;
  closedBlock: string | null;
  currency: string;
  repurchasePrice: string;
  interestAtEnd: string;
  collateralAtFace: string;
  history: { uetr: string; kind: string; block: string; collateral: { bond: string; units: string }[] }[];
  calls: {
    uetr: string;
    caller: string;
    dueBy: string;
    status: "proposed" | "rejected" | "open" | "overdue" | "met";
    settledBlock: string | null;
    flow: { direction: "deliver" | "return"; bond: string; units: string; asOf: string; marks: { bond: string; price: string }[] };
  }[];
  manufactured: { bond: string; period: number; recordBlock: string; units: string; paidBy: string | null; status: string | null }[];
}

export interface AuditEntry {
  seq: string;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  detail: Record<string, unknown>;
  prev: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  head: string;
  brokenAt?: { seq: string; reason: string };
}

export interface Instruction {
  uetr: string;
  kind:
    | "fund"
    | "redeem"
    | "tokenize"
    | "detokenize"
    | "interbank"
    | "pvp"
    | "bond-issue"
    | "bond-trade"
    | "bond-coupon"
    | "bond-redeem"
    | "repo-open"
    | "repo-margin"
    | "repo-substitute"
    | "repo-close"
    | "repo-manufactured";
  amount: string;
  currency: string;
  role: "submitter" | "approver" | "party";
  status: InstructionStatus;
  entry: "pending" | "posted" | "voided" | null;
  deadline: string;
  settledBlock: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  // The flow's parties, which depend on its kind.
  bank?: string;
  customer?: string;
  payerBank?: string;
  payer?: string;
  payeeBank?: string;
  payee?: string;
  bond?: string;
  seller?: string;
  buyer?: string;
  units?: string;
  period?: number;
  allocations?: { bank: string; units: string }[];
  payments?: { bank: string; units: string }[];
  /** A payment across currencies: what the payee's bank is paid, and at what rate. */
  target?: { amount: string; currency: string };
  rate?: string;
  /** A payment across currencies: the dealer's quote it settles at. */
  quote?: { id: string; dealer: string; from: string; to: string; rate: string; sourceAmount: string; targetAmount: string };
  /** A repo flow (SPEC.md §5.7–§5.10): the repo it belongs to, and its two sides. */
  repo?: string;
  lender?: string;
  borrower?: string;
  /** A margin: units the borrower delivers on the lender's call, or the lender returns. */
  direction?: "deliver" | "return";
  /** An opening: the repo's terms, its rate a year beside `rate`. */
  haircut?: string;
  startDate?: string;
  endDate?: string;
  /** A substitution: the bond's units going back to the borrower, and those coming in. */
  outgoing?: { bond: string; units: string };
  incoming?: { bond: string; units: string };
}

export interface Customer {
  customer: string;
  name: string;
  address: string | null;
  deposit: { posted: string; available: string };
  tokenized: { posted: string; available: string };
}

export interface BondSummary {
  symbol: string;
  agent: string;
  issuer: string;
  terms: {
    face: string;
    currency: string;
    couponRate: string;
    frequency: string;
    dayCount: string;
    issueDate: string;
    maturityDate: string;
  };
  outstandingUnits: string;
  holdingUnits: string | null;
  /** ERC-3643: whether this bank may receive the bond, and the bond's identity registry and compliance. */
  verified: boolean | null;
  regulation: { identityRegistry: string; compliance: string; claimTopics: string; trustedIssuers: string; onchainID: string } | null;
  faceOutstanding: string;
  schedule: {
    number: number;
    start: string;
    end: string;
    paymentDate: string;
    recordDate: string;
    final: boolean;
    paid: { uetr: string; settledBlock: string | null } | null;
  }[];
}

export interface Rtgs {
  currency: string;
  settlementAccounts: { bank: string; posted: string; available: string }[];
}

export interface Wholesale {
  currency: string;
  symbol: string;
  outstanding: string;
  lines: { bank: string; outstanding: string }[];
}

export interface Party {
  ref: string | null;
  name: string;
}

export interface Leg {
  kind: "mint" | "burn" | "transfer";
  token: string;
  tokenKind: "wholesale" | "deposit" | "bond" | null;
  from: Party | null;
  to: Party | null;
  amount?: string;
  currency?: string;
  units?: string;
}

export interface JournalEntry {
  id: string;
  key: string;
  uetr: string | null;
  description: string;
  status: "pending" | "posted" | "voided";
  createdAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  block: string | null;
  lines: { account: string; side: "debit" | "credit"; amount: string; currency: string }[];
}

export interface InstructionDetail extends Instruction {
  attempts: number;
  submitter: string;
  approvers: string[];
  legs: Leg[];
  approvals: { signer: string; by: string | null }[];
  journal: JournalEntry | null;
  /** What its policy asked here before it was signed or sent, if anything. */
  policy: Proposal | null;
}

export interface MessageRef {
  name: string;
  type: string;
  version: string;
  msgId: string;
  href: string;
}

/** A read that failed: the service is down, or answered with an error. */
export class Unreachable extends Error {
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.url = url;
  }
}

async function request(base: string, path: string): Promise<Response | null> {
  const url = `${base}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
  } catch (error) {
    throw new Unreachable(url, error);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new Unreachable(url, `${response.status} ${body.detail ?? body.title ?? response.statusText}`);
  }
  return response;
}

async function read<T>(base: string, path: string): Promise<T> {
  const response = await request(base, path);
  if (!response) throw new Unreachable(`${base}${path}`, "404 Not found");
  return (await response.json()) as T;
}

/** A read of something that may not exist at this participant: null when the service says 404. */
async function readMaybe<T>(base: string, path: string): Promise<T | null> {
  const response = await request(base, path);
  return response ? ((await response.json()) as T) : null;
}

/** A read that may fail, as a value the page can show instead of throwing. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function attempt<T>(promise: Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readNetwork(): Promise<Network> {
  return read<Network>(ENTRY, "/network");
}

export const entryUrl = ENTRY;

/** Reads against one participant's service. */
export function service(participant: NetworkParticipant) {
  const base = participant.url;
  if (!base) throw new Error(`${participant.name} runs no service`);
  return {
    url: base,
    health: () => read<Health>(base, "/health"),
    accounts: () => read<{ accounts: Account[] }>(base, "/accounts").then((r) => r.accounts),
    reconciliation: () => read<Reconciliation>(base, "/reconciliation"),
    instructions: (limit = 40) =>
      read<{ instructions: Instruction[]; next: string | null }>(base, `/instructions?limit=${limit}`),
    customers: () => read<{ customers: Customer[] }>(base, "/customers").then((r) => r.customers),
    instruction: (uetr: string) => readMaybe<InstructionDetail>(base, `/instructions/${uetr}`),
    messages: (uetr: string) =>
      readMaybe<{ messages: MessageRef[] }>(base, `/instructions/${uetr}/messages`).then((r) => r?.messages ?? []),
    messageXml: async (ref: MessageRef) => (await request(base, ref.href))?.text() ?? null,
    journal: (limit = 12) => read<{ entries: JournalEntry[]; next: string | null }>(base, `/journal?limit=${limit}`),
    journalFor: (uetr: string) =>
      read<{ entries: JournalEntry[] }>(base, `/journal?uetr=${uetr}`).then((r) => r.entries[0] ?? null),
    bond: (symbol: string) => read<BondSummary>(base, `/bonds/${encodeURIComponent(symbol)}`),
    rtgs: () => read<Rtgs>(base, "/rtgs"),
    wholesale: () => read<Wholesale>(base, "/wholesale"),
    quotes: (limit = 12) => read<{ quotes: Quote[] }>(base, `/fx/quotes?limit=${limit}`).then((r) => r.quotes),
    operators: () => read<Operators>(base, "/operators"),
    proposals: (status?: Proposal["status"], limit = 20) =>
      read<{ proposals: Proposal[] }>(base, `/proposals?limit=${limit}${status ? `&status=${status}` : ""}`).then((r) => r.proposals),
    audit: (options: { limit?: number; before?: string; subject?: string } = {}) =>
      read<{ entries: AuditEntry[]; next: string | null }>(
        base,
        `/audit?limit=${options.limit ?? 100}${options.before ? `&before=${options.before}` : ""}${options.subject ? `&subject=${options.subject}` : ""}`,
      ),
    verifyAudit: () => read<AuditVerification>(base, "/audit/verify"),
    keys: () => read<SigningKeys>(base, "/keys"),
    identity: () => read<IdentityView>(base, "/identity"),
    custody: () => read<CustodyView>(base, "/custody"),
    repos: () => read<{ repos: RepoView[] }>(base, "/repos").then((r) => r.repos),
    changes: (limit = 10) => read<{ changes: Change[] }>(base, `/changes?limit=${limit}`).then((r) => r.changes),
  };
}

// ---------------------------------------------------------------- the harness in serve mode

const HARNESS = (process.env["OUL_HARNESS_URL"] ?? "http://127.0.0.1:7099").replace(/\/$/, "");

export interface HarnessCheck {
  invariant: string;
  what: string;
  ok: boolean;
  detail?: string;
}

export interface HarnessStep {
  n: number;
  kind: "action" | "fault";
  label: string;
  outcome: string;
  ok: boolean;
  skipped: boolean;
  at: string;
}

export interface HarnessStatus {
  scenario: { id: string; name: string };
  seed: number;
  startedAt: string;
  deployment: { startBlock: string; deployedAt: string };
  busy: { label: string; since: string } | null;
  counts: { steps: number; settled: number; refused: number; faults: number };
  blocksChecked: number;
  checksRun: number;
  checkedThrough: string;
  ok: boolean;
  failures: HarnessCheck[];
  lastGlobal: { at: string | null; checks: HarnessCheck[] } | null;
  faults: string[];
  steps: HarnessStep[];
}

export const harnessUrl = HARNESS;

export function readHarness(): Promise<HarnessStatus> {
  return read<HarnessStatus>(HARNESS, "/status");
}
