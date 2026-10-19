import { existsSync } from "node:fs";
import path from "node:path";
import { devKeys, LegKind, readDeployment, readNetwork, REPO_ROOT, ZERO_ADDRESS } from "@oul/chain";
import { formatMoney } from "@oul/domain";
import {
  approversOf,
  type AuditEntry,
  type ChangeRow,
  entryKey,
  type Flow,
  flowCurrency,
  flowValue,
  type InstructionRow,
  legsOf,
  Participant,
  type Proposal,
  submitterOf,
} from "@oul/participant";
import type { Entry } from "@oul/ledger";
import { homeCurrency, loadScenario } from "@oul/scenario";
import { createSigner, type SignerConfig } from "@oul/signer";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { changeRequestSchema, formatAmount, HttpPeers, installErrorHandler, notFound, operatorOf, problem, servicePort, serviceUrl, uetrSchema } from "./http.ts";

/** How an instruction looks over HTTP: amounts in major units, no bigints. */
export function instructionView(participant: Participant, row: InstructionRow & { entryStatus: string | null }) {
  const { uetr: _u, deadline: _d, kind, ...details } = row.flow as Flow & { amount?: string };
  const { amount: _a, ...parties } = details;
  return {
    uetr: row.uetr,
    kind,
    ...parties,
    ...formatAmount(flowCurrency(row.flow, participant.rt.scenario), flowValue(row.flow)),
    // Across currencies, what the payee's bank is paid, in its currency, at the dealer's quote.
    ...(row.flow.kind === "pvp" ? { target: formatAmount(row.flow.quote.to, row.flow.quote.targetAmount), rate: row.flow.quote.rate } : {}),
    role: row.role,
    status: row.status,
    entry: row.entryStatus,
    deadline: row.deadline.toISOString(),
    settledBlock: row.settledBlock?.toString() ?? null,
    txHash: row.txHash,
    error: row.lastError,
  };
}

/** Who an address is: a participant or a bank's customer, by the deployment's public directory. */
function directory(participant: Participant) {
  const { scenario, deployment } = participant.rt;
  const names = new Map<string, { ref: string; name: string }>();
  for (const p of scenario.participants) {
    const at = deployment.participants[p.id];
    if (at) names.set(at.address.toLowerCase(), { ref: p.id, name: p.name });
  }
  for (const ledger of scenario.ledgers) {
    for (const c of ledger.customers) {
      const at = deployment.customers[`${ledger.participant}/${c.id}`];
      if (at) names.set(at.address.toLowerCase(), { ref: `${ledger.participant}/${c.id}`, name: c.name });
    }
  }
  const tokens = new Map(Object.entries(deployment.tokens).map(([symbol, t]) => [t.address.toLowerCase(), { symbol, ...t }]));
  return { names, tokens };
}

/**
 * An instruction in full, for the settlement timeline: the legs the engine
 * executes with each party named, who signed, and the journal entry that
 * books this participant's side.
 */
async function instructionDetail(participant: Participant, row: InstructionRow & { entryStatus: string | null }) {
  const { names, tokens } = directory(participant);
  const party = (address: string) =>
    address === ZERO_ADDRESS ? null : (names.get(address.toLowerCase()) ?? { ref: null, name: address });
  const kindName = Object.fromEntries(Object.entries(LegKind).map(([name, value]) => [value, name]));
  const legs = legsOf(row.flow, participant.rt).legs.map((leg) => {
    const token = tokens.get(leg.token.toLowerCase());
    const isCash = token?.kind !== "bond";
    return {
      kind: kindName[leg.kind],
      token: token?.symbol ?? leg.token,
      tokenKind: token?.kind ?? null,
      from: party(leg.from),
      to: party(leg.to),
      ...(isCash && token ? formatAmount(token.currency, leg.amount) : { units: leg.amount.toString() }),
    };
  });
  const entry = await participant.entry(row.uetr);
  const proposal = await participant.proposal(row.uetr);
  return {
    ...instructionView(participant, row),
    // What its policy asked before it was signed or sent here (SPEC.md §15), if it asked anything.
    policy: proposal ? proposalView(proposal) : null,
    createdAt: row.createdAt.toISOString(),
    attempts: row.attempts,
    submitter: submitterOf(row.flow, participant.rt),
    approvers: approversOf(row.flow),
    legs,
    approvals: row.approvals.map((a) => ({ signer: a.signer, by: party(a.signer)?.ref ?? null })),
    journal: entry ? entryView(entry) : null,
  };
}

/** A journal entry over HTTP, with the UETR of the instruction it books if it books one. */
function entryView(entry: Entry) {
  const prefix = entryKey("");
  return {
    id: entry.id.toString(),
    key: entry.idempotencyKey,
    uetr: entry.idempotencyKey.startsWith(prefix) ? entry.idempotencyKey.slice(prefix.length) : null,
    description: entry.description,
    status: entry.status,
    createdAt: entry.createdAt.toISOString(),
    postedAt: entry.postedAt?.toISOString() ?? null,
    voidedAt: entry.voidedAt?.toISOString() ?? null,
    block: entry.ledgerBlock?.toString() ?? null,
    lines: entry.lines.map((l) => ({ account: l.account, side: l.side, ...formatAmount(l.amount.currency, l.amount.minor) })),
  };
}

const STATUSES = ["proposed", "ready", "submitted", "awaiting", "settled", "failed", "expired", "rejected"] as const;

/** What waits for a participant's policy, over HTTP. */
export function proposalView(p: Proposal) {
  return {
    subject: p.subject,
    kind: p.kind,
    action: p.action,
    initiator: p.initiator,
    rule: p.rule,
    required: p.required,
    roles: p.roles,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisions: p.decisions.map((d) => ({ operator: d.operator, decision: d.decision, roles: d.roles, at: d.at.toISOString() })),
  };
}

/** A change over HTTP; signatures stay in the participant's books. */
export function changeView(c: ChangeRow) {
  const { consent: _c, proof: _p, ...request } = c.request as ChangeRow["request"] & { consent?: string; proof?: string };
  return {
    id: c.id,
    action: c.action,
    request,
    initiator: c.initiator,
    status: c.status,
    result: c.result,
    error: c.error,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function auditView(e: AuditEntry) {
  return { seq: e.seq.toString(), at: e.at.toISOString(), actor: e.actor, action: e.action, subject: e.subject, detail: e.detail, prev: e.prev, hash: e.hash };
}

/** Routes every participant serves: health, directory, instructions, accounts, reconciliation. */
function commonRoutes(app: FastifyInstance, participant: Participant): void {
  app.get("/health", async () => {
    const reconciliation = await participant.reconciliation();
    return {
      participant: participant.id,
      kind: participant.rt.kind,
      reconciledBlock: reconciliation?.block.toString() ?? null,
      reconciled: reconciliation?.ok ?? null,
    };
  });

  // The scenario's public directory: who takes part, where each service listens, what is issued.
  app.get("/network", async () => {
    const { scenario, deployment } = participant.rt;
    return {
      self: participant.id,
      scenario: { id: scenario.id, name: scenario.name, currencies: scenario.currencies, timeZone: scenario.timeZone },
      participants: scenario.participants.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        validator: p.validator,
        ...(p.agent ? { agent: p.agent } : {}),
        // The currency of its own books, and for a bank every currency it holds reserves in.
        ...(p.kind === "central-bank" || p.kind === "bank" ? { currency: homeCurrency(scenario, p.id) } : {}),
        ...(p.kind === "bank" ? { reserves: p.reserves } : {}),
        address: deployment.participants[p.id]?.address ?? null,
        url: p.kind === "central-bank" || p.kind === "bank" ? serviceUrl(scenario, p.id) : null,
        customers: scenario.ledgers.find((l) => l.participant === p.id)?.customers ?? [],
      })),
      instruments: {
        wholesale: scenario.instruments.wholesale,
        deposits: scenario.instruments.deposits,
        bonds: scenario.instruments.bonds.map((b) => ({ symbol: b.symbol, name: b.name, issuer: b.issuer, agent: b.agent, currency: b.currency })),
      },
      // Payment versus payment (SPEC.md §13): the dealer, its rates and how long its quotes hold.
      fx: scenario.fx ?? null,
      // Client custody (SPEC.md §15): each custodian and the customers it holds bonds for.
      custody: scenario.custody,
      // Repo (SPEC.md §5.7–§5.10): its day count, the bonds it accepts and how long a margin call may stay unmet.
      repo: scenario.repo ?? null,
      deployment: { startBlock: deployment.startBlock, deployedAt: deployment.deployedAt, chainId: deployment.chainId },
    };
  });

  // This participant's instructions, newest first; `before` is the previous page's `next`.
  app.get("/instructions", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z
          .string()
          .regex(/^[^~]+~[0-9a-f-]{36}$/)
          .optional(),
        status: z
          .string()
          .transform((v) => v.split(","))
          .pipe(z.array(z.enum(STATUSES)))
          .optional(),
      })
      .parse(request.query ?? {});
    const [at, uetr] = query.before?.split("~") ?? [];
    const rows = await participant.instructions({
      limit: query.limit,
      ...(at && uetr ? { before: { createdAt: new Date(at), uetr } } : {}),
      ...(query.status ? { statuses: query.status } : {}),
    });
    const last = rows.at(-1);
    return {
      participant: participant.id,
      instructions: rows.map((row) => ({ ...instructionView(participant, row), createdAt: row.createdAt.toISOString() })),
      next: rows.length === query.limit && last ? `${last.createdAt.toISOString()}~${last.uetr}` : null,
    };
  });

  app.get("/instructions/:uetr", async (request, reply) => {
    const { uetr } = z.object({ uetr: uetrSchema }).parse(request.params);
    const row = await participant.instruction(uetr);
    return row ? instructionDetail(participant, row) : notFound(reply, `No instruction ${uetr} at ${participant.id}`);
  });

  // ISO 20022 messages for an instruction (SPEC.md §8): the list, then each as XML.
  app.get("/instructions/:uetr/messages", async (request, reply) => {
    const { uetr } = z.object({ uetr: uetrSchema }).parse(request.params);
    const messages = await participant.messages(uetr);
    if (!messages) return notFound(reply, `No instruction ${uetr} at ${participant.id}`);
    return {
      uetr,
      participant: participant.id,
      messages: messages.map((m) => ({
        name: m.name,
        type: m.type,
        version: m.version,
        msgId: m.msgId,
        href: `/instructions/${uetr}/messages/${m.name}`,
      })),
    };
  });

  app.get("/instructions/:uetr/messages/:name", async (request, reply) => {
    const { uetr, name } = z.object({ uetr: uetrSchema, name: z.string().min(1) }).parse(request.params);
    const message = (await participant.messages(uetr))?.find((m) => m.name === name);
    if (!message) return notFound(reply, `No message ${name} for instruction ${uetr} at ${participant.id}`);
    return reply.type("application/xml; charset=utf-8").send(message.xml);
  });

  // The journal, newest first; `uetr` picks the entry booking one instruction,
  // which at the central bank may be one it observed on chain without being a party.
  app.get("/journal", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(30),
        before: z.string().regex(/^[1-9]\d*$/).optional(),
        uetr: uetrSchema.optional(),
      })
      .parse(request.query ?? {});
    const entries = await participant.rt.books.entries({
      limit: query.limit,
      ...(query.before ? { beforeId: BigInt(query.before) } : {}),
      ...(query.uetr ? { keys: [entryKey(query.uetr)] } : {}),
    });
    const last = entries.at(-1);
    return {
      participant: participant.id,
      entries: entries.map(entryView),
      next: entries.length === query.limit && last ? last.id.toString() : null,
    };
  });

  app.get("/accounts", async () => {
    const { books, scenario } = participant.rt;
    const chart = scenario.ledgers.find((l) => l.participant === participant.id)!.chart;
    const accounts = [];
    for (const spec of chart) {
      const balance = await books.balance(spec.code);
      accounts.push({
        account: spec.code,
        name: spec.name,
        type: spec.type,
        mirrored: spec.mirrored,
        currency: spec.currency,
        posted: formatMoney(balance.posted),
        available: formatMoney(balance.available),
        pendingDebits: formatMoney(balance.pendingDebits),
        pendingCredits: formatMoney(balance.pendingCredits),
      });
    }
    return { participant: participant.id, accounts };
  });

  // Operators and policy (SPEC.md §15): who may initiate and approve what. Never their tokens.
  app.get("/operators", async () => ({ participant: participant.id, ...participant.operators }));

  // What waits for this participant's policy, or got its decision, newest first.
  app.get("/proposals", async (request) => {
    const query = z
      .object({ status: z.enum(["open", "approved", "rejected", "expired"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query ?? {});
    const proposals = await participant.proposals({ limit: query.limit, ...(query.status ? { status: query.status } : {}) });
    return { participant: participant.id, proposals: proposals.map(proposalView) };
  });

  app.get("/proposals/:subject", async (request, reply) => {
    const { subject } = z.object({ subject: z.string().min(1) }).parse(request.params);
    const proposal = await participant.proposal(subject);
    return proposal ? proposalView(proposal) : notFound(reply, `Nothing waits for approval under ${subject} at ${participant.id}`);
  });

  // An operator other than the initiator approves or rejects it.
  app.post("/proposals/:subject/decisions", async (request) => {
    const { subject } = z.object({ subject: z.string().min(1) }).parse(request.params);
    const body = z.strictObject({ decision: z.enum(["approve", "reject"]) }).parse(request.body);
    return proposalView(await participant.decide(subject, operatorOf(participant, request), body.decision));
  });

  // Signing keys (SPEC.md §15): the one it signs with now, and every one before.
  app.get("/keys", async () => {
    const { current, keys } = await participant.keys();
    return {
      participant: participant.id,
      current,
      keys: keys.map((k) => ({ ...k, createdAt: k.createdAt.toISOString(), retiredAt: k.retiredAt?.toISOString() ?? null })),
    };
  });

  // An administrator starts moving this participant to a new signing key; the registry's operator admits it.
  app.post("/keys/rotate", async (request, reply) => {
    z.strictObject({}).parse(request.body ?? {});
    const change = await participant.proposeChange({ action: "rotate-key" }, operatorOf(participant, request));
    return reply.status(202).header("location", `/changes/${change.id}`).send(changeView(change));
  });

  // Identity for securities (SPEC.md §15, ERC-3643): its identity and the claims on it, and those it issued.
  app.get("/identity", async () => ({ participant: participant.id, ...(await participant.identity()) }));

  // As a trusted claim issuer, an administrator revokes the KYC claim it made about a participant or customer.
  app.post("/identity/claims/revoke", async (request, reply) => {
    const body = z.strictObject({ subject: z.string().min(1) }).parse(request.body);
    const change = await participant.proposeChange({ action: "claim", op: "revoke", subject: body.subject }, operatorOf(participant, request));
    return reply.status(202).header("location", `/changes/${change.id}`).send(changeView(change));
  });

  // Administrative changes started here or asked of this participant, newest first.
  app.get("/changes", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query ?? {});
    return { participant: participant.id, changes: (await participant.changes(limit)).map(changeView) };
  });

  app.get("/changes/:id", async (request, reply) => {
    const { id } = z.object({ id: uetrSchema }).parse(request.params);
    const change = await participant.change(id);
    return change ? changeView(change) : notFound(reply, `No change ${id} at ${participant.id}`);
  });

  // Another participant asks for a change this one makes, under this one's policy.
  app.post("/peer/changes", async (request, reply) => {
    const change = await participant.receiveChange(changeRequestSchema.parse(request.body));
    return reply.status(202).header("location", `/changes/${change.id}`).send(changeView(change));
  });

  // The audit log, newest first; `before` is a sequence number from the previous page.
  app.get("/audit", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.string().regex(/^[1-9]\d*$/).optional(),
        subject: z.string().min(1).optional(),
      })
      .parse(request.query ?? {});
    const entries = await participant.audit({
      limit: query.limit,
      ...(query.before ? { before: BigInt(query.before) } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
    });
    const last = entries.at(-1);
    return { participant: participant.id, entries: entries.map(auditView), next: entries.length === query.limit && last ? last.seq.toString() : null };
  });

  // Walk the audit log's hash chain from its first entry.
  app.get("/audit/verify", async () => ({ participant: participant.id, ...(await participant.verifyAudit()) }));

  app.get("/reconciliation", async () => {
    const latest = await participant.reconciliation();
    const breaks = await participant.breaks(20);
    return {
      participant: participant.id,
      block: latest?.block.toString() ?? null,
      ok: latest ? latest.ok && breaks.length === 0 : null,
      checks: latest?.checks ?? [],
      breaks,
    };
  });
}

/**
 * Serve a camt.053 statement: `from` and `to` are ISO instants, from the
 * deployment to now by default.
 */
export async function sendStatement(
  participant: Participant,
  reply: FastifyReply,
  account: { kind: string; owner: string },
  query: unknown,
) {
  const period = z
    .object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() })
    .parse(query ?? {});
  const from = new Date(period.from ?? participant.rt.deployment.deployedAt);
  const to = period.to ? new Date(period.to) : new Date();
  if (!(from < to)) return problem(reply, 400, "validation", "The request is invalid", "`from` must be before `to`");
  const statement = await participant.statement(account, { from, to });
  if (!statement) return notFound(reply, `No ${account.kind} account for ${account.owner} at ${participant.id}`);
  return reply.type("application/xml; charset=utf-8").send(statement.xml);
}

export type RegisterRoutes = (app: FastifyInstance, participant: Participant) => void;

/** A service's HTTP app over an open participant, without listening; tests use it directly. */
export function buildApp(participant: Participant, register: RegisterRoutes): FastifyInstance {
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  commonRoutes(app, participant);
  register(app, participant);
  return app;
}

export interface ServiceConfig {
  readonly scenarioDir: string;
  readonly participant: string;
  readonly databaseUrl: string;
  readonly signer: SignerConfig;
  readonly port?: number;
  readonly host: string;
  readonly pollIntervalMs: number;
  readonly deadlineSeconds: number;
}

/**
 * Configuration from the environment:
 *   OUL_PARTICIPANT   participant id (required), e.g. bank-a
 *   OUL_SCENARIO      scenario id under scenarios/ or a path; ca-interbank
 *   DATABASE_URL      Postgres holding this participant's schema
 *   OUL_SIGNER        local (the sandbox's derived key) or kms
 *   OUL_KMS_KEY_ID    the KMS key id or ARN, with OUL_SIGNER=kms; AWS_REGION as usual
 *   PORT, HOST        where to listen; 7100 + the participant's position by default
 *   OUL_POLL_MS       how often the runtime's loops run; 1000
 *   OUL_DEADLINE_SECONDS  how long an instruction may wait to settle; 600
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const participant = env["OUL_PARTICIPANT"];
  if (!participant) throw new Error("OUL_PARTICIPANT is required, e.g. OUL_PARTICIPANT=bank-a");
  const scenarioArg = env["OUL_SCENARIO"] ?? "ca-interbank";
  const scenarioDir = existsSync(path.join(REPO_ROOT, "scenarios", scenarioArg))
    ? path.join(REPO_ROOT, "scenarios", scenarioArg)
    : path.resolve(scenarioArg);
  let signer: SignerConfig;
  if ((env["OUL_SIGNER"] ?? "local") === "kms") {
    const keyId = env["OUL_KMS_KEY_ID"];
    if (!keyId) throw new Error("OUL_SIGNER=kms needs OUL_KMS_KEY_ID");
    signer = { kind: "kms", keyId, ...(env["AWS_REGION"] ? { region: env["AWS_REGION"] } : {}) };
  } else {
    signer = { kind: "local", privateKey: devKeys.participant(participant) };
  }
  return {
    scenarioDir,
    participant,
    databaseUrl: env["DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul",
    signer,
    ...(env["PORT"] ? { port: Number(env["PORT"]) } : {}),
    host: env["HOST"] ?? "127.0.0.1",
    pollIntervalMs: Number(env["OUL_POLL_MS"] ?? 1000),
    deadlineSeconds: Number(env["OUL_DEADLINE_SECONDS"] ?? 600),
  };
}

/** Run one participant's service until SIGINT or SIGTERM. */
export async function runService(kind: "central-bank" | "bank", register: RegisterRoutes): Promise<void> {
  const config = configFromEnv();
  const scenario = await loadScenario(config.scenarioDir);
  const network = await readNetwork();
  const deployment = await readDeployment(scenario.id);
  if (!deployment) throw new Error(`No deployment of ${scenario.id}: run \`pnpm deploy ${scenario.id}\` first`);
  const meta = scenario.participants.find((p) => p.id === config.participant);
  if (meta?.kind !== kind) throw new Error(`"${config.participant}" is not a ${kind} in ${scenario.id}`);

  const account = await createSigner(config.signer);
  const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
  const participant = await Participant.open({
    scenario,
    deployment,
    network,
    participant: config.participant,
    databaseUrl: config.databaseUrl,
    account,
    peers: new HttpPeers(scenario),
    pollIntervalMs: config.pollIntervalMs,
    deadlineSeconds: config.deadlineSeconds,
    log,
  });
  const app = buildApp(participant, register);
  participant.start();
  const port = config.port ?? servicePort(scenario, config.participant);
  await app.listen({ port, host: config.host });
  log(`[${config.participant}] ${kind} service on http://${config.host}:${port}, signing as ${account.address}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log(`[${config.participant}] stopping`);
    await app.close();
    await participant.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
