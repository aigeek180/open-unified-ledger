import { centralBankAccounts, formatMoney } from "@oul/domain";
import type { Participant } from "@oul/participant";
import { flowSchema, instructionView, sendStatement } from "@oul/service";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * A central bank's API (SPEC.md §4.4): banks holding reserves in its currency
 * ask it to fund wholesale tokens from their RTGS settlement accounts;
 * operators read the settlement accounts (the RTGS simulator) and the
 * wholesale lines, all in its currency.
 */
export function centralBankRoutes(app: FastifyInstance, participant: Participant): void {
  const { books, scenario, deployment, currency } = participant.rt;
  const [symbol] = Object.entries(deployment.tokens).find(([, t]) => t.kind === "wholesale" && t.issuer === participant.id)!;
  const banks = scenario.participants.filter((p) => p.kind === "bank" && p.reserves.includes(currency)).map((p) => p.id);

  // A bank asks to move reserves into wholesale tokens; the central bank checks and mints.
  app.post("/peer/funding", async (request, reply) => {
    const row = await participant.receiveFunding(flowSchema.parse(request.body));
    const view = await participant.instruction(row.uetr);
    return reply.status(202).send(instructionView(participant, view!));
  });

  app.get("/rtgs", async () => {
    const accounts = [];
    for (const bank of banks) {
      const balance = await books.balance(centralBankAccounts.settlementAccount(bank));
      accounts.push({ bank, posted: formatMoney(balance.posted), available: formatMoney(balance.available) });
    }
    return { currency, settlementAccounts: accounts };
  });

  // camt.053 for a bank's settlement account or wholesale line (SPEC.md §8).
  app.get("/banks/:bank/statement", async (request, reply) => {
    const { bank } = z.object({ bank: z.string().min(1) }).parse(request.params);
    const { account } = z
      .object({ account: z.enum(["settlement", "wholesale"]).default("wholesale") })
      .parse(request.query ?? {});
    return sendStatement(participant, reply, { kind: account, owner: bank }, { ...(request.query as object), account: undefined });
  });

  app.get("/wholesale", async () => {
    const lines = [];
    for (const bank of banks) {
      const balance = await books.balance(centralBankAccounts.wholesaleLine(bank));
      lines.push({ bank, outstanding: formatMoney(balance.posted) });
    }
    const total = await books.balance(centralBankAccounts.wholesaleOutstanding);
    return {
      currency,
      symbol,
      outstanding: formatMoney(total.posted),
      lines,
    };
  });
}
