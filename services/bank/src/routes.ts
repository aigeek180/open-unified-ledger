import { bankAccounts, formatMoney, money } from "@oul/domain";
import {
  FlowRejected,
  type FlowRequest,
  getMarginCall,
  type Participant,
  planClose,
  planManufactured,
  planMargin,
  planSubstitution,
} from "@oul/participant";
import {
  amountSchema,
  changeView,
  currencySchema,
  flowSchema,
  formatAmount,
  marginCallSchema,
  instructionView,
  operatorOf,
  quoteRequestSchema,
  sendStatement,
  uetrSchema,
  unitsSchema,
} from "@oul/service";
import type { Quote, QuoteRow } from "@oul/participant";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

/**
 * A bank's API (SPEC.md §4.3). Operators start flows for the bank and its
 * customers; other participants reach `/peer/*`. Starting a flow answers 202
 * with the instruction: it settles when the shared ledger commits it, which
 * `GET /instructions/:uetr` shows. Bond prices are in major units per unit;
 * units are whole numbers.
 */
export function bankRoutes(app: FastifyInstance, participant: Participant): void {
  const { currency } = participant.rt;
  const self = participant.id;
  const amount = amountSchema(currency);
  const withUetr = { uetr: uetrSchema.optional() };
  const customerParams = z.object({ customer: z.string().min(1) });

  // Every flow is started by one of this bank's operators, who waits for its policy's approvals (SPEC.md §15).
  const accepted = async (reply: FastifyReply, request: FlowRequest, by: string) => {
    const row = await participant.initiate(request, by);
    const view = await participant.instruction(row.uetr);
    return reply.status(202).header("location", `/instructions/${row.uetr}`).send(instructionView(participant, view!));
  };
  const uetrOf = (body: { uetr?: string | undefined }) => (body.uetr ? { uetr: body.uetr } : {});

  // §5.1: move reserves into wholesale tokens, or back, in any currency the bank holds
  // reserves in; its own currency unless the request names another.
  for (const kind of ["fund", "redeem"] as const) {
    app.post(`/wholesale/${kind}`, async (request, reply) => {
      const body = z.strictObject({ amount: z.string(), currency: currencySchema.optional(), ...withUetr }).parse(request.body);
      const inCurrency = body.currency ?? currency;
      const minor = amountSchema(inCurrency).parse(body.amount);
      return accepted(reply, { kind, bank: self, currency: inCurrency, amount: minor, ...uetrOf(body) }, operatorOf(participant, request));
    });
  }

  // §5.2: tokenize part of a customer's deposit, or detokenize it.
  for (const kind of ["tokenize", "detokenize"] as const) {
    app.post(`/customers/:customer/${kind}`, async (request, reply) => {
      const { customer } = customerParams.parse(request.params);
      const body = z.strictObject({ amount, ...withUetr }).parse(request.body);
      return accepted(reply, { kind, bank: self, customer, amount: body.amount, ...uetrOf(body) }, operatorOf(participant, request));
    });
  }

  // §5.3: a customer pays a customer of another bank, in one currency; or, §13,
  // in the payee's currency at a quote this bank asked the dealer for.
  app.post("/payments", async (request, reply) => {
    const parties = { payer: z.string().min(1), payeeBank: z.string().min(1), payee: z.string().min(1), ...withUetr };
    const body = z
      .union([z.strictObject({ ...parties, amount }), z.strictObject({ ...parties, quote: uetrSchema })])
      .parse(request.body);
    const { payer, payeeBank, payee } = body;
    if ("quote" in body) {
      const quote = await participant.heldQuote(body.quote);
      return accepted(reply, { kind: "pvp", payerBank: self, payer, payeeBank, payee, quote, ...uetrOf(body) }, operatorOf(participant, request));
    }
    return accepted(reply, { kind: "interbank", payerBank: self, payer, payeeBank, payee, amount: body.amount, ...uetrOf(body) }, operatorOf(participant, request));
  });

  // §13: ask the dealer what an amount in this bank's currency buys in another.
  app.post("/fx/quotes", async (request, reply) => {
    const body = z.strictObject({ to: currencySchema, amount }).parse(request.body);
    operatorOf(participant, request);
    const quote = await participant.requestQuote(body.to, body.amount);
    return reply.status(201).send(quoteView({ role: "requester", quote, uetr: null, createdAt: new Date() }));
  });

  // The quotes this bank gave as dealer, or asked for, newest first.
  app.get("/fx/quotes", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query ?? {});
    return { participant: self, quotes: (await participant.quotes(limit)).map(quoteView) };
  });

  // As dealer: a bank asks for a signed quote.
  app.post("/peer/quotes", async (request) => participant.quote(quoteRequestSchema.parse(request.body)));

  // Every customer of this bank with its deposit and tokenized deposit.
  app.get("/customers", async () => {
    const { books, scenario, deployment } = participant.rt;
    const customers = scenario.ledgers.find((l) => l.participant === self)!.customers;
    const rows = [];
    for (const c of customers) {
      const deposit = await books.balance(bankAccounts.customerDeposit(c.id));
      const tokenized = await books.balance(bankAccounts.tokenizedDeposit(c.id));
      rows.push({
        customer: c.id,
        name: c.name,
        address: deployment.customers[`${self}/${c.id}`]?.address ?? null,
        deposit: { posted: formatMoney(deposit.posted), available: formatMoney(deposit.available) },
        tokenized: { posted: formatMoney(tokenized.posted), available: formatMoney(tokenized.available) },
      });
    }
    return { bank: self, currency, customers: rows };
  });

  app.get("/customers/:customer", async (request) => {
    const { customer } = customerParams.parse(request.params);
    if (!participant.rt.deployment.customers[`${self}/${customer}`]) {
      throw new FlowRejected("unknown-customer", `"${customer}" is not a customer of ${self}`);
    }
    const deposit = await participant.rt.books.balance(bankAccounts.customerDeposit(customer));
    const tokenized = await participant.rt.books.balance(bankAccounts.tokenizedDeposit(customer));
    return {
      bank: self,
      customer,
      currency,
      address: participant.rt.deployment.customers[`${self}/${customer}`]!.address,
      deposit: { posted: formatMoney(deposit.posted), available: formatMoney(deposit.available) },
      tokenized: { posted: formatMoney(tokenized.posted), available: formatMoney(tokenized.available) },
    };
  });

  // camt.053 for a customer's deposit or tokenized deposit (SPEC.md §8).
  app.get("/customers/:customer/statement", async (request, reply) => {
    const { customer } = customerParams.parse(request.params);
    const { account } = z
      .object({ account: z.enum(["deposit", "tokenized"]).default("tokenized") })
      .parse(request.query ?? {});
    return sendStatement(participant, reply, { kind: account, owner: customer }, { ...(request.query as object), account: undefined });
  });

  // §5.4–§5.6 Bonds.
  const bondParams = z.object({ bond: z.string().min(1) });
  const price = amountSchema(currency);

  // §15 Client custody: the omnibus wallet its clients' units go to now, and a client's custody leg there.
  const custodyOf = async (client: string | undefined) => (client ? { custody: { client, wallet: await participant.custodyWallet() } } : {});
  const clientSchema = z.string().min(1).optional();

  // This bank agrees to buy in an issue or a trade, for its own book or for a custody client; it co-signs
  // only what it affirmed. An issue may give several allocations: its own and its clients'.
  app.post("/bonds/:bond/affirmations", async (request, reply) => {
    const { bond } = bondParams.parse(request.params);
    const body = z
      .discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("issue"),
          uetr: uetrSchema,
          units: unitsSchema.optional(),
          client: clientSchema,
          allocations: z.array(z.strictObject({ units: unitsSchema, client: clientSchema })).min(1).optional(),
          price,
        }),
        z.strictObject({ kind: z.literal("trade"), uetr: uetrSchema, seller: z.string().min(1), units: unitsSchema, client: clientSchema, price }),
      ])
      .parse(request.body);
    let affirmation;
    if (body.kind === "issue") {
      const wanted = body.allocations ?? (body.units ? [{ units: body.units, client: body.client }] : []);
      if (wanted.length === 0) throw new FlowRejected("invalid-flow", "An issue affirmation names its units, or its allocations");
      const allocations = await Promise.all(wanted.map(async (a) => ({ bank: self, units: a.units, ...(await custodyOf(a.client)) })));
      affirmation = { kind: "bond-issue" as const, uetr: body.uetr, bond, price: body.price, allocations };
    } else {
      const buyerCustody = (await custodyOf(body.client)).custody;
      affirmation = {
        kind: "bond-trade" as const,
        uetr: body.uetr,
        bond,
        seller: body.seller,
        buyer: self,
        units: body.units,
        price: body.price,
        ...(buyerCustody ? { buyerCustody } : {}),
      };
    }
    const { status } = await participant.affirm(affirmation, operatorOf(participant, request));
    // Proposed: it counts once this bank's approvers have approved it under the same UETR.
    return reply.status(201).send({ affirmed: body.uetr, bond, kind: body.kind, status });
  });

  /** A buyer's custody leg, with the wallet its custodian names now. */
  const custodyAt = async (bank: string, client: string | undefined) =>
    client ? { client, wallet: bank === self ? await participant.custodyWallet() : await participant.peerCustodyWallet(bank) } : undefined;

  // As issuing agent, issue units to buyers that have affirmed their allocations; an allocation for a
  // buyer's custody client goes to that buyer's omnibus wallet.
  app.post("/bonds/:bond/issue", async (request, reply) => {
    const { bond } = bondParams.parse(request.params);
    const body = z
      .strictObject({
        uetr: uetrSchema,
        price,
        allocations: z.array(z.strictObject({ bank: z.string().min(1), units: unitsSchema, client: clientSchema })).min(1),
      })
      .parse(request.body);
    const allocations = await Promise.all(
      body.allocations.map(async (a) => {
        const custody = await custodyAt(a.bank, a.client);
        return { bank: a.bank, units: a.units, ...(custody ? { custody } : {}) };
      }),
    );
    return accepted(reply, { kind: "bond-issue", bond, uetr: body.uetr, price: body.price, allocations }, operatorOf(participant, request));
  });

  // Sell units, its own or a custody client's, to a bank that has affirmed the same trade under the same
  // UETR, for its own book or for its custody client.
  app.post("/bonds/:bond/trades", async (request, reply) => {
    const { bond } = bondParams.parse(request.params);
    const body = z
      .strictObject({ uetr: uetrSchema, buyer: z.string().min(1), units: unitsSchema, price, client: clientSchema, buyerClient: clientSchema })
      .parse(request.body);
    const [sellerCustody, buyerCustody] = [await custodyAt(self, body.client), await custodyAt(body.buyer, body.buyerClient)];
    return accepted(
      reply,
      {
        kind: "bond-trade",
        bond,
        uetr: body.uetr,
        seller: self,
        buyer: body.buyer,
        units: body.units,
        price: body.price,
        ...(sellerCustody ? { sellerCustody } : {}),
        ...(buyerCustody ? { buyerCustody } : {}),
      },
      operatorOf(participant, request),
    );
  });

  // As a custodian (SPEC.md §15): its omnibus wallets, each client's position in each bond, and the units on chain.
  app.get("/custody", async () => {
    const view = await participant.custody();
    return {
      bank: self,
      ...view,
      block: view.block.toString(),
      bonds: view.bonds.map((b) => ({ ...b, onChain: b.onChain.toString(), positions: b.positions.map((p) => ({ ...p, units: p.units.toString() })) })),
    };
  });

  // An administrator reports the omnibus wallet lost: the bond's agent recovers its units to the next one.
  app.post("/custody/recover", async (request, reply) => {
    z.strictObject({}).parse(request.body ?? {});
    const change = await participant.proposeChange({ action: "recovery", op: "custody-wallet" }, operatorOf(participant, request));
    return reply.status(202).header("location", `/changes/${change.id}`).send(changeView(change));
  });

  // As paying agent, pay the next scheduled coupon, or redeem if it is the last.
  app.post("/bonds/:bond/payments/next", async (request, reply) => {
    const { bond } = bondParams.parse(request.params);
    const body = z.strictObject({ ...withUetr }).parse(request.body ?? {});
    const row = await participant.payNextBondPayment(bond, operatorOf(participant, request), body.uetr);
    const view = await participant.instruction(row.uetr);
    return reply.status(202).header("location", `/instructions/${row.uetr}`).send(instructionView(participant, view!));
  });

  app.get("/bonds/:bond", async (request) => {
    const { bond } = bondParams.parse(request.params);
    const summary = await participant.bond(bond);
    return {
      ...summary,
      terms: { ...summary.terms, face: formatMoney(summary.terms.face), currency },
      outstandingUnits: summary.outstandingUnits.toString(),
      holdingUnits: summary.holdingUnits?.toString() ?? null,
      faceOutstanding: formatMoney(money(currency, summary.outstandingUnits * summary.terms.face.minor)),
    };
  });

  // §5.7–§5.10 Repo. Amounts and marks are in major units (a mark per unit); units are whole numbers; dates
  // YYYY-MM-DD. The lender affirms an open or a substitution, the side receiving units calls a margin, and the
  // other side starts each under the same UETR; a close and a manufactured payment are computed from the record.
  const repoParams = z.object({ repo: uetrSchema });
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
  const fraction = z.string().regex(/^0(\.\d{1,18})?$/, "a fraction in [0, 1), e.g. \"0.02\"");
  const marksSchema = z.array(z.strictObject({ bond: z.string().min(1), price })).min(1);
  const openTerms = { uetr: uetrSchema, bond: z.string().min(1), units: unitsSchema, mark: price, cash: amount, rate: fraction, haircut: fraction, startDate: date, endDate: date };
  const repoView = async (id: string) => {
    const view = await participant.repo(id);
    if (!view) throw new FlowRejected("not-found", `${self} has no repo ${id}`);
    return view;
  };
  /** A repo's view over HTTP: its terms and every amount in major units. */
  const repoOut = (view: NonNullable<Awaited<ReturnType<Participant["repo"]>>>) => ({
    ...view,
    terms: { ...view.terms, ...formatAmount(view.currency, view.terms.cash) },
    calls: view.calls.map((c) => ({ ...c, dueBy: new Date(c.dueBy * 1000).toISOString() })),
  });

  app.get("/repos", async () => ({ bank: self, repos: (await participant.repos()).map(repoOut) }));
  app.get("/repos/:repo", async (request) => repoOut(await repoView(repoParams.parse(request.params).repo)));

  // As lender: agree the terms of a repo the borrower will open under the same UETR.
  app.post("/repos/affirmations", async (request, reply) => {
    const body = z.strictObject({ ...openTerms, borrower: z.string().min(1) }).parse(request.body);
    const { status } = await participant.affirm({ kind: "repo-open", lender: self, ...body }, operatorOf(participant, request));
    return reply.status(201).send({ affirmed: body.uetr, kind: "repo-open", status });
  });

  // As borrower: open a repo the lender affirmed: its units against the purchase price.
  app.post("/repos", async (request, reply) => {
    const body = z.strictObject({ ...openTerms, lender: z.string().min(1) }).parse(request.body);
    return accepted(reply, { kind: "repo-open", borrower: self, ...body }, operatorOf(participant, request));
  });

  // Call the margin agreed marks give on a date: the lender calls a shortfall, the borrower an excess.
  app.post("/repos/:repo/margin-calls", async (request, reply) => {
    const { repo } = repoParams.parse(request.params);
    const body = z.strictObject({ marks: marksSchema, asOf: date, bond: z.string().min(1), ...withUetr }).parse(request.body);
    const plan = await planMargin(participant.rt, repo, body.marks, body.asOf, body.bond);
    const caller = plan.direction === "deliver" ? plan.lender : plan.borrower;
    if (caller !== self) {
      throw new FlowRejected("invalid-flow", `At these marks ${plan.direction === "deliver" ? `${plan.borrower} owes ${plan.units} units: ${plan.lender} calls it` : `${plan.lender} owes back ${plan.units} units: ${plan.borrower} calls it`}`);
    }
    const uetr = body.uetr ?? randomUUID();
    const { status } = await participant.affirm({ ...plan, uetr }, operatorOf(participant, request));
    const call = await getMarginCall(participant.rt.books.database, uetr);
    return reply.status(201).send({ call: uetr, repo, direction: plan.direction, bond: plan.bond, units: plan.units, status, dueBy: call ? new Date(call.dueBy * 1000).toISOString() : null });
  });

  // Deliver the margin the other side called.
  app.post("/repos/:repo/margin", async (request, reply) => {
    const { repo } = repoParams.parse(request.params);
    const body = z.strictObject({ call: uetrSchema }).parse(request.body);
    const call = await getMarginCall(participant.rt.books.database, body.call);
    if (!call || call.repo !== repo || call.caller === self) throw new FlowRejected("not-found", `No margin call ${body.call} on repo ${repo} for ${self} to meet`);
    const { deadline: _d, ...flow } = call.flow;
    return accepted(reply, flow, operatorOf(participant, request));
  });

  // As lender: agree a substitution at marks; as borrower: make it under the same UETR.
  const substitution = { uetr: uetrSchema, outgoing: z.strictObject({ bond: z.string().min(1), units: unitsSchema }), incoming: z.string().min(1), marks: marksSchema, asOf: date };
  app.post("/repos/:repo/substitutions/affirmations", async (request, reply) => {
    const { repo } = repoParams.parse(request.params);
    const body = z.strictObject(substitution).parse(request.body);
    const plan = await planSubstitution(participant.rt, repo, body.outgoing, body.incoming, body.marks, body.asOf);
    const { status } = await participant.affirm({ ...plan, uetr: body.uetr }, operatorOf(participant, request));
    return reply.status(201).send({ affirmed: body.uetr, kind: "repo-substitute", incoming: plan.incoming, status });
  });
  app.post("/repos/:repo/substitutions", async (request, reply) => {
    const { repo } = repoParams.parse(request.params);
    const body = z.strictObject(substitution).parse(request.body);
    const plan = await planSubstitution(participant.rt, repo, body.outgoing, body.incoming, body.marks, body.asOf);
    return accepted(reply, { ...plan, uetr: body.uetr }, operatorOf(participant, request));
  });

  // As borrower, at the end date: every collateral unit back against the purchase price plus interest.
  app.post("/repos/:repo/close", async (request, reply) => {
    const { repo } = repoParams.parse(request.params);
    const body = z.strictObject({ ...withUetr }).parse(request.body ?? {});
    return accepted(reply, { ...(await planClose(participant.rt, repo)), ...uetrOf(body) }, operatorOf(participant, request));
  });

  // As lender: pass on a coupon received on collateral.
  app.post("/repos/:repo/manufactured", async (request, reply) => {
    const { repo } = repoParams.parse(request.params);
    const body = z.strictObject({ bond: z.string().min(1), period: z.number().int().positive(), ...withUetr }).parse(request.body);
    return accepted(reply, { ...(await planManufactured(participant.rt, repo, body.bond, body.period)), ...uetrOf(body) }, operatorOf(participant, request));
  });

  // The other side of a repo calls a margin this bank is to meet.
  app.post("/peer/repos/calls", async (request) => participant.receiveMarginCall(marginCallSchema.parse(request.body) as never));

  // Another bank asks this one to co-sign: a payment to its customer, or, as a
  // buyer or holder, an issue, trade, coupon or redemption it checks itself.
  app.post("/peer/approvals", async (request) => participant.approve(flowSchema.parse(request.body)));
}

/** A quote over HTTP: amounts in major units with their currencies, the expiry as an instant. */
function quoteView(row: QuoteRow): Record<string, unknown> {
  const q: Quote = row.quote;
  return {
    id: q.id,
    role: row.role,
    dealer: q.dealer,
    requester: q.requester,
    source: formatAmount(q.from, q.sourceAmount),
    target: formatAmount(q.to, q.targetAmount),
    rate: q.rate,
    expiresAt: new Date(q.expiresAt * 1000).toISOString(),
    uetr: row.uetr,
    createdAt: row.createdAt.toISOString(),
  };
}
