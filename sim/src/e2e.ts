/**
 * Every flow of a scenario (SPEC.md §5), end to end on the running network:
 *   pnpm e2e [scenario] [--verbose]
 *
 * Every participant runs as its own service process; everything below goes
 * through their HTTP APIs, except the deliberate corruption, which writes to
 * one bank's books behind its back the way a bug would.
 *
 *   5.1  two banks fund wholesale tokens from their RTGS accounts
 *   5.2  a customer tokenizes part of a deposit
 *   5.3  an interbank payment each way, co-signed by the payee's bank
 *   §13  for a scenario of two currencies: a payment across currencies each
 *        way, at the dealer's signed quote, co-signed by the dealer and the
 *        payee's bank
 *   5.4–5.6  for a scenario with a bond: an issue and a trade, each matched
 *        against the buyer's affirmation, then every coupon (each holder
 *        verifying its own amount) and redemption
 *   5.7–5.10 for a scenario with repo: a repo opened on terms both banks
 *        affirmed, a margin call met, a coupon on collateral passed on as a
 *        manufactured payment, the collateral substituted, and the repo
 *        closed, principal plus interest; invariant 14 at both banks
 *   §6   invariants 2, 3, 8, 10 and 11 hold at every participant, and across
 *        them: each central bank's line for each bank equals its reserves in
 *        that currency
 *   §8   every participant's ISO 20022 messages for those instructions, and
 *        account statements, are valid against the official XSDs
 *   §6   a corrupted entry shows up as a reconciliation break; a correcting
 *        entry clears it going forward, and the broken blocks stay on record
 *
 * Needs the network up (`pnpm network:generate && pnpm network:up`) and
 * Postgres (`pnpm db:up`). Deploys the scenario if it is not deployed yet.
 */
import { contracts, deployScenario, devKeys, readNetwork, rpcUrlFor, sandboxChain, writeDeployment } from "@oul/chain";
import { bankAccounts, credit, type CurrencyCode, debit, formatMoney, money, parseMoney } from "@oul/domain";
import { randomUUID } from "node:crypto";
import { Ledger } from "@oul/ledger";
import { readMessage, validate } from "@oul/iso20022";
import { booksSchema } from "@oul/participant";
import { centralBankFor, centralBanks, dealerOf, depositOf, operatorToken, registryOperator } from "@oul/scenario";
import { serviceUrl } from "@oul/service";
import { sql } from "drizzle-orm";
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { launchServices, scenarioFromArg } from "./launch.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const { scenario, dir } = await scenarioFromArg(args.find((a) => !a.startsWith("--")));
const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://oul:oul@localhost:55442/oul";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ---------------------------------------------------------------- setup

const network = await readNetwork().catch(() => {
  console.error("No network: run `pnpm network:generate && pnpm network:up` first.");
  process.exit(1);
});
const cb = registryOperator(scenario).id;
const client = createPublicClient({
  chain: sandboxChain(network.chainId, rpcUrlFor(network, cb)),
  transport: http(),
  cacheTime: 0,
});
const { deployment, reused } = await deployScenario(scenario, network, { log: (m) => console.log(dim(m)) });
if (!reused) await writeDeployment(deployment);

const serviceLog: string[] = [];
const services = launchServices(scenario, dir, {
  print: (line) => {
    if (verbose) console.log(line);
    serviceLog.push(line);
    if (serviceLog.length > 300) serviceLog.shift();
  },
});
services.onUnexpectedExit = (participant, code) => fail(`${participant}'s service exited (${code})`);

/** A contract's custom error name from a refused simulation. */
function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? revert.reason) : undefined;
}

async function fail(message: string): Promise<never> {
  console.log(red(`\n✗ ${message}`));
  if (!verbose) console.log(dim(`\nLast service output:\n${serviceLog.slice(-40).join("\n")}`));
  await services.stop();
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

type Json = Record<string, any>;

/** The operator that starts flows at a participant (SPEC.md §15): its first holding the operator role. */
const starter = (participant: string) => {
  const operators = scenario.operators[participant]!.operators;
  return (operators.find((o) => o.roles.includes("operator")) ?? operators[0]!).id;
};

/** A request; a POST outside `/peer/*` comes from one of the participant's operators, its starter unless named. */
async function send(participant: string, method: "GET" | "POST", route: string, body?: unknown, operator?: string) {
  const by = method === "POST" && !route.startsWith("/peer/") ? (operator ?? starter(participant)) : undefined;
  const response = await fetch(`${serviceUrl(scenario, participant)}${route}`, {
    method,
    headers: {
      ...(by ? { authorization: `Bearer ${operatorToken(participant, by)}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function api(participant: string, method: "GET" | "POST", route: string, body?: unknown, operator?: string): Promise<Json> {
  const { status, body: json } = await send(participant, method, route, body, operator);
  if (status >= 400) return fail(`${method} ${participant}${route} → ${status}: ${json["detail"] ?? json["title"]}`);
  return json;
}

/** Approvals given so far by operators other than the initiator, where a policy asked for them. */
const approvalsGiven: { participant: string; subject: string; operator: string }[] = [];

/**
 * Approve what waits for a participant's policy under `subject`, as its
 * approvers would: operators other than the initiator holding a role the
 * policy names, one after another, until it is met.
 */
async function approve(participant: string, subject: string): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const proposal = await send(participant, "GET", `/proposals/${subject}`);
    if (proposal.status !== 200 || proposal.body["status"] !== "open") return;
    const decided = new Set((proposal.body["decisions"] as Json[]).map((d) => d["operator"]));
    const next = scenario.operators[participant]!.operators.find(
      (o) => `operator:${o.id}` !== proposal.body["initiator"] && !decided.has(o.id) && o.roles.some((r) => (proposal.body["roles"] as string[]).includes(r)),
    );
    if (!next) return fail(`No operator of ${participant} is left to approve ${subject}`);
    await api(participant, "POST", `/proposals/${subject}/decisions`, { decision: "approve" }, next.id);
    approvalsGiven.push({ participant, subject, operator: next.id });
  }
}

/** Start a flow at `participant` and approve it wherever a policy holds it: there, and for funding at the central bank. */
async function start(participant: string, route: string, body: unknown, alsoAt: string[] = []): Promise<Json> {
  const instruction = await api(participant, "POST", route, body);
  for (const p of [participant, ...alsoAt]) await approve(p, instruction["uetr"] ?? instruction["affirmed"]);
  return instruction;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return fail(`Timed out waiting for ${what}`);
}

/** Wait until the instruction has settled at every listed participant; returns its block. */
async function settled(uetr: string, ...participants: string[]): Promise<bigint> {
  return waitFor(`instruction ${uetr} to settle at ${participants.join(", ")}`, async () => {
    const views = await Promise.all(participants.map((p) => api(p, "GET", `/instructions/${uetr}`)));
    const bad = views.find((v) => v["status"] === "failed" || v["status"] === "expired");
    if (bad) return fail(`Instruction ${uetr} ${bad["status"]}: ${bad["error"]}`);
    return views.every((v) => v["status"] === "settled") ? BigInt(views[0]!["settledBlock"]) : undefined;
  });
}

async function step(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${bold(title)}`);
  const started = Date.now();
  await body();
  console.log(green(`  ✓ ${((Date.now() - started) / 1000).toFixed(1)}s`));
}

const banks = scenario.ledgers.filter((l) => scenario.participants.find((p) => p.id === l.participant)?.kind === "bank");
const currencyOf = (bank: string) => depositOf(scenario, bank).currency;
const reservesOf = (bank: string) => scenario.participants.find((p) => p.id === bank)!.reserves;
// Two banks whose deposits share a currency pay each other (§5.3); in a scenario of two currencies,
// a bank pays one in the other currency through the dealer (§13).
const [bankA, bankB] = banks.filter((l) => currencyOf(l.participant) === currencyOf(banks[0]!.participant));
if (!bankA?.customers[0] || !bankB?.customers[0]) await fail("The scenario needs two banks in one currency with a customer each");
const a = bankA!.participant;
const b = bankB!.participant;
const ccy: CurrencyCode = currencyOf(a);
const payer = bankA!.customers[0]!.id;
const payee = bankB!.customers[0]!.id;
const dealer = dealerOf(scenario);
const abroad = dealer ? banks.find((l) => currencyOf(l.participant) !== ccy && l.participant !== dealer) : undefined;
const participants = [...centralBanks(scenario).map((p) => p.id), ...banks.map((l) => l.participant)];
let lastBlock = 0n;
/** Instructions whose ISO 20022 messages the §8 step checks, with who to ask. */
const isoChecks: { label: string; uetr: string; participants: string[] }[] = [];

// ---------------------------------------------------------------- run

console.log(bold(`\nOpen Unified Ledger end to end: ${scenario.id} on chain ${network.chainId}`));
console.log(dim(`Services: ${participants.map((p) => `${p} ${serviceUrl(scenario, p)}`).join(", ")}`));
await services.ready;

const funded = [...new Set([a, b, ...(abroad ? [abroad.participant, dealer!] : [])])];
await step(`5.1  ${funded.join(", ")} fund wholesale tokens from their RTGS accounts${abroad ? ", in each currency they hold" : ""}`, async () => {
  for (const bank of funded) {
    for (const currency of reservesOf(bank)) {
      const issuer = centralBankFor(scenario, currency).id;
      const instruction = await start(bank, "/wholesale/fund", { amount: "1000000", currency }, [issuer]);
      isoChecks.push({ label: `5.1 fund ${bank} ${currency}`, uetr: instruction["uetr"], participants: [bank, issuer] });
      const block = await settled(instruction["uetr"], bank, issuer);
      lastBlock = block > lastBlock ? block : lastBlock;
      console.log(`  ${bank} funded ${instruction["amount"]} ${currency}, minted by ${issuer} in block ${block}`);
    }
  }
});

await step(`5.2  ${payer} tokenizes part of a deposit at ${a}`, async () => {
  const instruction = await start(a, `/customers/${payer}/tokenize`, { amount: "5000" });
  isoChecks.push({ label: "5.2 tokenize", uetr: instruction["uetr"], participants: [a] });
  lastBlock = await settled(instruction["uetr"], a);
  const customer = await api(a, "GET", `/customers/${payer}`);
  console.log(`  ${payer}: deposit ${customer["deposit"].posted}, tokenized ${customer["tokenized"].posted} ${ccy} (block ${lastBlock})`);
});

await step(`5.3  ${payer} at ${a} pays ${payee} at ${b}, then ${payee} pays part back`, async () => {
  const there = await start(a, "/payments", { payer, payeeBank: b, payee, amount: "2500" });
  isoChecks.push({ label: "5.3 payment", uetr: there["uetr"], participants: [a, b] });
  const thereBlock = await settled(there["uetr"], a, b);
  console.log(`  ${payer} → ${payee} ${there["amount"]} ${ccy}: burn, wholesale move, mint in block ${thereBlock}`);
  const back = await start(b, "/payments", { payer: payee, payeeBank: a, payee: payer, amount: "1000" });
  lastBlock = await settled(back["uetr"], b, a);
  console.log(`  ${payee} → ${payer} ${back["amount"]} ${ccy} in block ${lastBlock}`);
  console.log(`  ${payer} holds ${(await api(a, "GET", `/customers/${payer}`))["tokenized"].posted}, ${payee} holds ${(await api(b, "GET", `/customers/${payee}`))["tokenized"].posted} ${ccy}`);
});

// §15: above its policy's threshold a payment waits, booked but unsigned and unsent, for an approver.
const paymentRule = scenario.operators[a]!.policy.find((r) => r.actions.includes("interbank") && r.over !== undefined && r.approvals > 0);
if (paymentRule) {
  await step(`§15  above ${paymentRule.over} ${ccy} a payment at ${a} waits for ${paymentRule.approvals} approval from ${paymentRule.by.join(" or ")}`, async () => {
    const over = parseMoney(ccy, paymentRule.over!).minor;
    const size = formatMoney(money(ccy, over + parseMoney(ccy, "2000").minor));
    const funds = await start(a, `/customers/${payer}/tokenize`, { amount: formatMoney(money(ccy, 2n * (over + parseMoney(ccy, "2000").minor))) });
    lastBlock = await settled(funds["uetr"], a);

    const held = await api(a, "POST", "/payments", { payer, payeeBank: b, payee, amount: size });
    if (held["status"] !== "proposed") return fail(`A payment of ${size} was ${held["status"]}, not held for approval`);
    const own = await send(a, "POST", `/proposals/${held["uetr"]}/decisions`, { decision: "approve" }, starter(a));
    if (own.status !== 403) return fail(`Its initiator approving its own payment was answered ${own.status}, not 403`);
    const atPayee = await send(b, "GET", `/instructions/${held["uetr"]}`);
    if (atPayee.status !== 404) return fail(`${b} knew of the payment before it was approved`);
    console.log(`  ${size} ${ccy}: proposed by ${starter(a)}, funds held, nothing signed or sent; ${starter(a)} cannot approve it (403); ${b} has not heard of it`);
    await approve(a, held["uetr"]);
    const by = approvalsGiven.filter((x) => x.subject === held["uetr"]).map((x) => x.operator).join(", ");
    lastBlock = await settled(held["uetr"], a, b);
    isoChecks.push({ label: "§15 approved payment", uetr: held["uetr"], participants: [a, b] });
    console.log(`  approved by ${by}, then co-signed by ${b} and final in block ${lastBlock}`);

    const refused = await api(a, "POST", "/payments", { payer, payeeBank: b, payee, amount: size });
    const approver = scenario.operators[a]!.operators.find((o) => o.roles.some((r) => paymentRule.by.includes(r)))!.id;
    await api(a, "POST", `/proposals/${refused["uetr"]}/decisions`, { decision: "reject" }, approver);
    const view = await api(a, "GET", `/instructions/${refused["uetr"]}`);
    if (view["status"] !== "rejected" || view["entry"] !== "voided") return fail(`A rejected payment is ${view["status"]} with its entry ${view["entry"]}`);
    console.log(`  a second one rejected by ${approver}: its pending entry voided, nothing sent`);
  });
}

if (abroad && dealer) {
  const there = abroad.participant;
  const thereCcy = currencyOf(there);
  const recipient = abroad.customers[0]!.id;
  /** Ask the dealer for a quote through the payer's bank, then pay at it. */
  const payAcross = async (from: string, fromCustomer: string, to: string, toCustomer: string, amount: string) => {
    const quote = await api(from, "POST", "/fx/quotes", { to: currencyOf(to), amount });
    const paid = await start(from, "/payments", { payer: fromCustomer, payeeBank: to, payee: toCustomer, quote: quote["id"] });
    isoChecks.push({ label: `§13 ${currencyOf(from)}→${currencyOf(to)}`, uetr: paid["uetr"], participants: [from, dealer, to] });
    const block = await settled(paid["uetr"], from, dealer, to);
    lastBlock = block > lastBlock ? block : lastBlock;
    console.log(
      `  ${fromCustomer} → ${toCustomer}: ${quote["source"].amount} ${quote["source"].currency} at ${quote["rate"]} = ${quote["target"].amount} ${quote["target"].currency}, four legs in block ${block}`,
    );
  };
  await step(`§13  ${payer} at ${a} pays ${recipient} at ${there} in ${thereCcy} through ${dealer}, then ${recipient} pays part back in ${ccy}`, async () => {
    await payAcross(a, payer, there, recipient, "1500");
    const tokens = await api(there, "GET", `/customers/${recipient}`);
    console.log(`  ${recipient} holds ${tokens["tokenized"].posted} ${thereCcy}`);
    await payAcross(there, recipient, a, payer, "500");
    console.log(`  ${payer} holds ${(await api(a, "GET", `/customers/${payer}`))["tokenized"].posted} ${ccy}, ${recipient} ${(await api(there, "GET", `/customers/${recipient}`))["tokenized"].posted} ${thereCcy}`);
    const quotes = (await api(dealer, "GET", "/fx/quotes"))["quotes"] as Json[];
    console.log(`  ${dealer} gave ${quotes.length} quotes, each settling one payment: ${quotes.every((q) => q["uetr"]) ? "yes" : "no"}`);
  });
}

const bondSpec = scenario.instruments.bonds.find((bond) => bond.agent !== a && bond.agent !== b);
const clients = scenario.custody.find((c) => c.bank === a)?.clients ?? [];
if (bondSpec) {
  const bond = bondSpec.symbol;
  const agent = bondSpec.agent;
  const face = parseMoney(ccy, bondSpec.face);
  const units = bondSpec.units;
  const status = await api(agent, "GET", `/bonds/${bond}`);
  if (BigInt(status["outstandingUnits"]) === 0n && status["schedule"][0]["paid"]) {
    console.log(dim(`\n5.4–5.6  ${bond} was already issued, paid and redeemed in this deployment; skipped.`));
    console.log(dim("         Run against a fresh network (pnpm network:down && pnpm network:up) to see its life again."));
  } else {
    await step(`5.4  ${agent} issues ${bond} to ${a} and ${b}, each matched against the buyer's affirmation`, async () => {
      // Buyers need wholesale for the price; the agent needs some to pay out what issue proceeds do not cover.
      const need = (share: bigint) => formatMoney(money(ccy, (face.minor * units * share) / 100n + face.minor * units / 5n));
      for (const [bank, share] of [[a, 60n], [b, 40n], [agent, 0n]] as const) {
        const funded = await start(bank, "/wholesale/fund", { amount: need(share) }, [cb]);
        await settled(funded["uetr"], bank, cb);
      }
      const uetr = randomUUID();
      const price = formatMoney(face);
      // A custodian (§15) buys part of its share for its clients, at its omnibus wallet, from their deposits.
      const clientUnits = clients.map((client, index) => ({ bank: a, units: (index === 0 ? 3000n : 2001n).toString(), client }));
      const own = (units * 60n) / 100n - clientUnits.reduce((t, c) => t + BigInt(c.units), 0n);
      const allocations = [{ bank: a, units: own.toString() }, ...clientUnits, { bank: b, units: ((units * 40n) / 100n).toString() }];
      for (const bank of [a, b]) {
        const mine = allocations.filter((x) => x.bank === bank).map(({ units: u, ...x }) => ({ units: u, ...("client" in x ? { client: x.client } : {}) }));
        await start(bank, `/bonds/${bond}/affirmations`, { kind: "issue", uetr, allocations: mine, price });
      }
      const issued = await start(agent, `/bonds/${bond}/issue`, { uetr, price, allocations });
      isoChecks.push({ label: "5.4 bond issue", uetr: issued["uetr"], participants: [agent, a, b] });
      lastBlock = await settled(issued["uetr"], agent, a, b);
      console.log(`  issued ${units} units at ${price}: ${issued["amount"]} ${ccy} paid to ${agent} in block ${lastBlock}`);
      if (clientUnits.length > 0) {
        console.log(`  ${a} took ${own} for its own book and ${clientUnits.map((c) => `${c.units} for ${c.client}`).join(", ")} at its omnibus wallet`);
      }
    });

    await step(`5.5  ${a} sells to ${b}, delivery versus payment`, async () => {
      const uetr = randomUUID();
      const tradeUnits = ((units * 7n) / 100n).toString();
      const price = formatMoney(money(ccy, (face.minor * 10015n) / 10000n));
      await start(b, `/bonds/${bond}/affirmations`, { kind: "trade", uetr, seller: a, units: tradeUnits, price });
      const traded = await start(a, `/bonds/${bond}/trades`, { uetr, buyer: b, units: tradeUnits, price });
      isoChecks.push({ label: "5.5 bond trade", uetr: traded["uetr"], participants: [a, b] });
      lastBlock = await settled(traded["uetr"], a, b);
      console.log(`  ${tradeUnits} units at ${price}: units and ${traded["amount"]} ${ccy} swapped in block ${lastBlock}`);
    });

    const repoSpec = scenario.repo;
    const other = repoSpec?.collateral.find((symbol) => symbol !== bond);
    if (repoSpec && other) {
      const rate = "0.0275";
      const [startDate, endDate, markDate] = ["2027-04-26", "2027-05-10", "2027-05-03"];
      let repo = "";
      const repoParties = [a, b];
      const repoView = (bank: string) => api(bank, "GET", `/repos/${repo}`);

      await step(`5.7  ${a} lends ${ccy} to ${b} against ${bond}: a repo both affirmed, opened in one instruction`, async () => {
        // The borrower also buys the other bond the repo accepts, to substitute later, and keeps cash to repay with.
        const funded = await start(b, "/wholesale/fund", { amount: "25000000.00" }, [cb]);
        await settled(funded["uetr"], b, cb);
        const issueUetr = randomUUID();
        const price = formatMoney(face);
        await start(b, `/bonds/${other}/affirmations`, { kind: "issue", uetr: issueUetr, units: "20000", price });
        const issued = await start(agent, `/bonds/${other}/issue`, { uetr: issueUetr, price, allocations: [{ bank: b, units: "20000" }] });
        await settled(issued["uetr"], agent, b);
        console.log(`  ${b} bought 20000 units of ${other} at issue, the other bond the repo accepts`);

        repo = randomUUID();
        const terms = { uetr: repo, bond, units: "10300", mark: "1000.00", cash: "10000000.00", rate, haircut: "0.02", startDate, endDate };
        const affirmed = await api(a, "POST", "/repos/affirmations", { ...terms, borrower: b });
        await approve(a, repo);
        console.log(`  ${a} affirmed the terms: 10300 units at 1000.00, 2% haircut, 10,000,000.00 ${ccy} at ${rate} from ${startDate} to ${endDate} (${affirmed["status"]})`);
        const opened = await start(b, "/repos", { ...terms, lender: a });
        isoChecks.push({ label: "5.7 repo open", uetr: opened["uetr"], participants: repoParties });
        lastBlock = await settled(repo, a, b);
        const [lent, borrowed] = [await repoView(a), await repoView(b)];
        console.log(`  units B→A and cash A→B in block ${lastBlock}; repurchase price ${lent["repurchasePrice"]} ${ccy}`);
        const accounts = async (bank: string, codes: string[]) => {
          const all = (await api(bank, "GET", "/accounts"))["accounts"] as Json[];
          return codes.map((code) => `${code} ${all.find((x) => x["account"] === code)?.["posted"] ?? "?"}`).join(", ");
        };
        console.log(`  ${a} (${lent["role"]}): ${await accounts(a, ["reverse-repos", `collateral-received/${bond}`, `bond-holdings/${bond}`])}`);
        console.log(`  ${b} (${borrowed["role"]}): ${await accounts(b, ["repo-borrowings", `bond-holdings/${bond}`, `collateral-pledged/${bond}`])}`);
      });

      await step(`5.8  ${a} calls margin at an agreed mark; ${b} delivers it on the call`, async () => {
        const called = await api(a, "POST", `/repos/${repo}/margin-calls`, { marks: [{ bond, price: "990.00" }], asOf: markDate, bond });
        await approve(a, called["call"]);
        console.log(`  at 990.00 on ${markDate} the collateral is short: ${a} calls ${called["units"]} more units, due by ${called["dueBy"]}`);
        const atBorrower = ((await repoView(b))["calls"] as Json[]).find((c) => c["uetr"] === called["call"]);
        if (atBorrower?.["status"] !== "open") return fail(`${b} does not see the call open: ${JSON.stringify(atBorrower)}`);
        const delivered = await start(b, `/repos/${repo}/margin`, { call: called["call"] });
        isoChecks.push({ label: "5.8 repo margin", uetr: delivered["uetr"], participants: repoParties });
        lastBlock = await settled(delivered["uetr"], a, b);
        const met = ((await repoView(a))["calls"] as Json[]).find((c) => c["uetr"] === called["call"]);
        console.log(`  delivered in block ${lastBlock}: the call is ${met?.["status"]} at both banks; collateral now ${((await repoView(a))["collateral"] as Json[]).map((c) => `${c["units"]} ${c["bond"]}`).join(", ")}`);
      });

      await step(`5.10 ${agent} pays a coupon on ${bond}: ${a} received it on the collateral, and passes it on to ${b}`, async () => {
        const coupon = await start(agent, `/bonds/${bond}/payments/next`, {});
        lastBlock = await settled(coupon["uetr"], agent, a, b);
        const toLender = (coupon["payments"] as Json[]).find((x) => x["bank"] === a);
        console.log(`  coupon ${coupon["period"]}: ${a} paid on ${toLender?.["units"]} units, its own and the collateral, in block ${lastBlock}`);
        const manufactured = await start(a, `/repos/${repo}/manufactured`, { bond, period: coupon["period"] });
        isoChecks.push({ label: "5.10 manufactured", uetr: manufactured["uetr"], participants: repoParties });
        lastBlock = await settled(manufactured["uetr"], a, b);
        console.log(`  ${a} passed on ${manufactured["amount"]} ${ccy}, the coupon on the collateral at the record block, in block ${lastBlock}`);
      });

      await step(`5.9  ${b} substitutes ${other} for ${bond} at marks both affirmed, in one instruction`, async () => {
        const held = ((await repoView(a))["collateral"] as Json[]).find((c) => c["bond"] === bond)!;
        const uetr = randomUUID();
        const swap = { uetr, outgoing: { bond, units: held["units"] }, incoming: other, marks: [{ bond, price: "1001.50" }, { bond: other, price: "987.25" }], asOf: markDate };
        const affirmed = await api(a, "POST", `/repos/${repo}/substitutions/affirmations`, swap);
        await approve(a, uetr);
        const swapped = await start(b, `/repos/${repo}/substitutions`, swap);
        isoChecks.push({ label: "5.9 repo substitution", uetr: swapped["uetr"], participants: repoParties });
        lastBlock = await settled(uetr, a, b);
        console.log(`  ${held["units"]} ${bond} back to ${b}, ${affirmed["incoming"]["units"]} ${other} to ${a}, both in block ${lastBlock}`);
      });

      await step(`5.10 ${b} closes the repo at its end date: every unit back, principal plus interest repaid`, async () => {
        const closed = await start(b, `/repos/${repo}/close`, {});
        isoChecks.push({ label: "5.10 repo close", uetr: closed["uetr"], participants: repoParties });
        lastBlock = await settled(closed["uetr"], a, b);
        const [lent, borrowed] = [await repoView(a), await repoView(b)];
        if (lent["status"] !== "closed" || borrowed["status"] !== "closed") return fail(`The repo is ${lent["status"]} at ${a} and ${borrowed["status"]} at ${b}`);
        console.log(`  repaid ${closed["amount"]} ${ccy} (interest ${lent["interestAtEnd"]}) in block ${lastBlock}; closed at both banks, no collateral left`);
        for (const bank of repoParties) {
          const reconciliation = await waitFor(`${bank} to reconcile the repo`, async () => {
            const r = await api(bank, "GET", "/reconciliation");
            return r["block"] !== null && BigInt(r["block"]) >= lastBlock && r["ok"] ? r : undefined;
          });
          const checks = (reconciliation["checks"] as Json[]).filter((c) => c["invariant"] === 14);
          console.log(`  inv 14 at ${bank}: ${checks.length} checks hold (record, books, margin cover, substitution value, close)`);
        }
      });
    }

    if (clients.length > 0) {
      await step(`§15  ${a} buys and sells for its custody clients at its omnibus wallet; their positions equal its units on chain`, async () => {
        const [seller, buyer] = [clients[0]!, clients[1] ?? clients[0]!];
        const price = formatMoney(face);
        const buyUetr = randomUUID();
        await start(a, `/bonds/${bond}/affirmations`, { kind: "trade", uetr: buyUetr, seller: b, units: "1000", client: buyer, price });
        const bought = await start(b, `/bonds/${bond}/trades`, { uetr: buyUetr, buyer: a, units: "1000", price, buyerClient: buyer });
        isoChecks.push({ label: "§15 custody buy", uetr: bought["uetr"], participants: [a, b] });
        const sellUetr = randomUUID();
        await start(b, `/bonds/${bond}/affirmations`, { kind: "trade", uetr: sellUetr, seller: a, units: "508", price });
        const sold = await start(a, `/bonds/${bond}/trades`, { uetr: sellUetr, buyer: b, units: "508", price, client: seller });
        await settled(bought["uetr"], a, b);
        lastBlock = await settled(sold["uetr"], a, b);
        console.log(`  ${b} sold 1000 units to ${buyer} and ${seller} sold 508 to ${b}, each delivery versus payment at ${a}'s omnibus wallet`);
        const custody = await waitFor(`${a} to reconcile its custody`, async () => {
          const r = await api(a, "GET", "/reconciliation");
          return r["block"] !== null && BigInt(r["block"]) >= lastBlock && r["ok"] ? r : undefined;
        });
        const view = await api(a, "GET", "/custody");
        const positions = (view["bonds"] as Json[])[0]!["positions"] as Json[];
        console.log(`  positions: ${positions.map((p) => `${p["client"]} ${p["units"]}`).join(", ")}; omnibus ${String(view["wallets"][0]["address"]).slice(0, 10)}… holds ${(view["bonds"] as Json[])[0]!["onChain"]}`);
        for (const check of (custody["checks"] as Json[]).filter((c) => c["invariant"] === 13)) {
          console.log(`  inv 13  ${check["account"]}: books ${check["books"]} = chain ${check["chain"]}`);
        }
      });
    }

    await step(`§15  ${bond} is an ERC-3643 token: a direct transfer is not compliant, and ${cb} revoking ${b}'s KYC claim stops ${b} receiving it`, async () => {
      const token = deployment.tokens[bond]!.address;
      const seller = createWalletClient({ account: privateKeyToAccount(devKeys.participant(a)), chain: client.chain, transport: http() });
      const direct = await client
        .simulateContract({ address: token, abi: contracts.Bond.abi, functionName: "transfer", args: [deployment.participants[b]!.address, 1n], account: seller.account })
        .then(() => "accepted", (error: unknown) => revertName(error) ?? String(error));
      if (direct !== "TransferNotCompliant") return fail(`A direct transfer of ${bond} was ${direct}, not refused as not compliant`);
      console.log(`  ${a} transferring a unit directly: refused, ${direct} (only the settlement engine's movements are compliant)`);
      const before = await api(b, "GET", `/bonds/${bond}`);
      if (before["verified"] !== true) return fail(`${b} is not verified before the revocation`);

      const administrator = scenario.operators[cb]!.operators.find((o) => o.roles.includes("administrator"))!.id;
      const change = await api(cb, "POST", "/identity/claims/revoke", { subject: b }, administrator);
      await approve(cb, change["id"]);
      const revoked = await api(cb, "GET", `/changes/${change["id"]}`);
      if (revoked["status"] !== "applied") return fail(`The revocation is ${revoked["status"]}: ${revoked["error"]}`);
      const after = await api(b, "GET", `/bonds/${bond}`);
      if (after["verified"] !== false) return fail(`${b} still verifies after its claim was revoked`);
      console.log(`  ${cb} revoked its KYC claim on ${b}'s identity in block ${revoked["result"]["block"]}: ${b} no longer verifies`);

      const uetr = randomUUID();
      const price = formatMoney(face);
      await start(b, `/bonds/${bond}/affirmations`, { kind: "trade", uetr, seller: a, units: "10", price });
      const refused = await start(a, `/bonds/${bond}/trades`, { uetr, buyer: b, units: "10", price });
      const outcome = await waitFor(`the trade to ${b} to be refused`, async () => {
        const view = await api(a, "GET", `/instructions/${refused["uetr"]}`);
        return view["status"] === "failed" || view["status"] === "settled" ? view : undefined;
      });
      if (outcome["status"] !== "failed" || !String(outcome["error"]).includes("ReceiverNotVerified")) {
        return fail(`A trade to ${b} after the revocation was ${outcome["status"]}: ${outcome["error"]}`);
      }
      console.log(`  a trade of 10 units to ${b}: ${outcome["error"]}; voided in both books`);
      console.log(`  ${b} keeps its ${after["holdingUnits"]} units: it is still paid each coupon and redeemed below`);
    });

    if (clients.length > 0) {
      await step(`§15  ${a} reports its omnibus wallet lost: ${agent} recovers its units to a new wallet (ERC-3643), ${cb} binds it to ${a}`, async () => {
        const administrator = scenario.operators[a]!.operators.find((o) => o.roles.includes("administrator"))!.id;
        const before = await api(a, "GET", "/custody");
        const lost = String((before["wallets"] as Json[]).find((w) => w["status"] === "active")!["address"]);
        const change = await api(a, "POST", "/custody/recover", {}, administrator);
        await approve(a, change["id"]);
        // The registry's operator binds the new wallet to the custodian; the agent recovers to it: each under its policy.
        for (const [participant, action] of [[cb, "bind-address"], [agent, "recovery"]] as const) {
          const asked = await waitFor(`${participant} to hear of the recovery`, async () =>
            ((await api(participant, "GET", "/changes"))["changes"] as Json[]).find((c) => c["action"] === action && c["status"] === "proposed"),
          );
          await approve(participant, asked["id"]);
        }
        const done = await waitFor(`${a}'s recovery to finish`, async () => {
          const view = await api(a, "GET", `/changes/${change["id"]}`);
          return view["status"] === "applied" ? view : view["status"] === "failed" ? fail(`The recovery failed: ${view["error"]}`) : undefined;
        });
        const after = await api(a, "GET", "/custody");
        const active = String((after["wallets"] as Json[]).find((w) => w["status"] === "active")!["address"]);
        const onChain = (after["bonds"] as Json[])[0]!["onChain"];
        console.log(`  ${lost.slice(0, 10)}… lost; ${onChain} units recovered to ${active.slice(0, 10)}… (${done["status"]}); clients' positions untouched`);
        lastBlock = await client.getBlockNumber();
      });
    }

    await step(`5.6  ${agent} pays every coupon, each checked by the holders, then redeems`, async () => {
      for (;;) {
        const payment = await start(agent, `/bonds/${bond}/payments/next`, {});
        if (payment["period"] === 1 || payment["kind"] === "bond-redeem") {
          isoChecks.push({ label: `5.6 bond ${payment["kind"] === "bond-redeem" ? "redemption" : "coupon 1"}`, uetr: payment["uetr"], participants: [agent, a, b] });
        }
        lastBlock = await settled(payment["uetr"], agent, a, b);
        const payments = payment["payments"] as { bank: string; amount?: string; coupon?: string }[];
        const paidMinor = payments.reduce((t, p) => t + BigInt(p.amount ?? p.coupon ?? "0"), 0n);
        const couponDebit = BigInt(payment["issuerDebit"]) - (payment["kind"] === "bond-redeem" ? face.minor * units : 0n);
        const residual = formatMoney(money(ccy, couponDebit - paidMinor));
        const label = payment["kind"] === "bond-redeem" ? "redemption + final coupon" : `coupon ${payment["period"]}`;
        console.log(
          `  ${label.padEnd(26)} ${payment["amount"].padStart(16)} ${ccy}  residual ${residual.padStart(5)}  block ${lastBlock}`,
        );
        const custodyPaid = payments.find((x) => (x as Json)["wallet"]) as Json | undefined;
        if (custodyPaid && payment["period"] === 1) {
          const entry = (await api(a, "GET", `/instructions/${payment["uetr"]}`))["journal"] as Json;
          const credits = (entry["lines"] as Json[]).filter((l) => String(l["account"]).startsWith("customer-deposits/") && l["side"] === "credit");
          const residual = (entry["lines"] as Json[]).find((l) => l["account"] === "rounding-residual");
          console.log(
            `    ${a}'s omnibus received ${formatMoney(money(ccy, BigInt(custodyPaid["amount"])))}: ${credits.map((l) => `${String(l["account"]).slice("customer-deposits/".length)} ${l["amount"]}`).join(", ")}${residual ? `, residual ${residual["side"] === "credit" ? "" : "-"}${residual["amount"]}` : ", no residual"}`,
          );
          isoChecks.push({ label: "5.6 custody coupon", uetr: payment["uetr"], participants: [a] });
        }
        if (payment["kind"] === "bond-redeem") break;
      }
      const after = await api(agent, "GET", `/bonds/${bond}`);
      console.log(`  outstanding after maturity: ${after["outstandingUnits"]} units`);
    });
  }
}

await step("§6   invariants hold at every participant and across them", async () => {
  for (const participant of participants) {
    const reconciliation = await waitFor(`${participant} to reconcile past block ${lastBlock}`, async () => {
      const r = await api(participant, "GET", "/reconciliation");
      return r["block"] !== null && BigInt(r["block"]) >= lastBlock && r["ok"] ? r : undefined;
    });
    const checks = reconciliation["checks"] as Json[];
    const byInvariant = [...new Set(checks.map((c) => c["invariant"]))].sort().map((i) => `${checks.filter((c) => c["invariant"] === i).length}× inv ${i}`);
    console.log(`  ${participant.padEnd(14)} block ${reconciliation["block"]}: ${byInvariant.join(", ")}, all hold`);
    for (const check of checks.filter((c) => c["invariant"] !== 8 && c["books"] !== "0.00" && c["books"] !== "0")) {
      console.log(dim(`    inv ${check["invariant"]}  ${String(check["account"]).padEnd(36)} ${check["books"].padStart(16)} = ${check["chain"]}`));
    }
    for (const check of checks.filter((c) => c["invariant"] === 8).slice(0, 2)) {
      console.log(dim(`    inv 8  ${String(check["account"]).padEnd(36)} ${check["books"].padStart(16)} = ${check["chain"]}`));
    }
  }
  for (const issuer of centralBanks(scenario)) {
    const wholesale = await api(issuer.id, "GET", "/wholesale");
    for (const line of wholesale["lines"] as Json[]) {
      const accounts = (await api(line["bank"], "GET", "/accounts").catch(() => undefined)) as Json | undefined;
      if (!accounts) continue;
      const reserves = (accounts["accounts"] as Json[]).find((x) => x["account"] === bankAccounts.wholesaleReserves(wholesale["currency"]));
      if (reserves && reserves["posted"] !== line["outstanding"]) {
        return fail(`${issuer.id}'s line for ${line["bank"]} is ${line["outstanding"]} but its reserves are ${reserves["posted"]}`);
      }
      console.log(`  ${issuer.id}'s line for ${line["bank"]} = ${line["bank"]}'s wholesale reserves = ${line["outstanding"]} ${wholesale["currency"]}`);
    }
  }
});

await step("§8   every participant's ISO 20022 messages validate against the official XSDs", async () => {
  let checked = 0;
  for (const check of isoChecks) {
    const names: string[] = [];
    for (const participant of check.participants) {
      const list = await api(participant, "GET", `/instructions/${check.uetr}/messages`);
      for (const message of list["messages"] as Json[]) {
        const xml = await (await fetch(`${serviceUrl(scenario, participant)}${message["href"]}`)).text();
        const result = await validate(xml, message["version"]);
        if (!result.valid) return fail(`${participant} ${message["name"]} for ${check.label} is invalid: ${result.errors[0]}`);
        if (!readMessage(xml).uetrs.includes(check.uetr)) return fail(`${participant} ${message["name"]} does not name ${check.uetr}`);
        names.push(String(message["type"]));
        checked++;
      }
    }
    const counts = [...new Set(names)].sort().map((t) => `${names.filter((n) => n === t).length}× ${t}`);
    console.log(`  ${check.label.padEnd(22)} ${counts.join(", ")}`);
  }
  const statements = [
    [a, `/customers/${payer}/statement?account=tokenized`],
    ...centralBanks(scenario).map((issuer) => [issuer.id, `/banks/${funded.find((bank) => reservesOf(bank).includes(issuer.currency!))}/statement?account=wholesale`] as const),
    ...(abroad ? [[abroad.participant, `/customers/${abroad.customers[0]!.id}/statement?account=tokenized`] as const] : []),
  ] as const;
  for (const [participant, route] of statements) {
    const xml = await (await fetch(`${serviceUrl(scenario, participant)}${route}`)).text();
    const result = await validate(xml, "camt.053.001.08");
    if (!result.valid) return fail(`${participant} statement ${route} is invalid: ${result.errors[0]}`);
    const closingBalance = xml.match(/<Cd>CLBD<\/Cd>[\s\S]*?<Amt Ccy="([A-Z]{3})">([\d.]+)<\/Amt>/);
    const [currency, closing] = [closingBalance?.[1], closingBalance?.[2]];
    console.log(`  camt.053 from ${participant.padEnd(16)} ${route.split("?")[0]}: closing ${closing} ${currency}`);
    checked++;
  }
  console.log(`  ${checked} messages, every one valid`);
});

await step(`§15  ${b} moves to a new signing key, admitted by ${cb} under both policies, and settles with it`, async () => {
  const administrator = scenario.operators[b]!.operators.find((o) => o.roles.includes("administrator"))!.id;
  const before = await api(b, "GET", "/keys");
  const change = await api(b, "POST", "/keys/rotate", {}, administrator);
  console.log(`  ${administrator} at ${b} asks for a new key: ${change["status"]}`);
  await approve(b, change["id"]);
  const asked = await api(b, "GET", `/changes/${change["id"]}`);
  if (asked["status"] !== "requested" && asked["status"] !== "applied") return fail(`${b}'s rotation is ${asked["status"]}: ${asked["error"]}`);
  const binding = ((await api(cb, "GET", "/changes"))["changes"] as Json[]).find((c) => c["action"] === "bind-address" && c["request"]["participant"] === b);
  if (!binding) return fail(`${cb} never heard of ${b}'s new key`);
  await approve(cb, binding["id"]);
  const applied = await api(cb, "GET", `/changes/${binding["id"]}`);
  if (applied["status"] !== "applied") return fail(`${cb} did not admit the key: ${applied["status"]} ${applied["error"]}`);
  console.log(`  ${cb} allowlisted ${String(applied["result"]["newKey"]).slice(0, 10)}… on ${applied["result"]["allowlistedOn"]} validators and rotated it in block ${applied["result"]["block"]}, retiring ${String(before["current"]).slice(0, 10)}…`);
  const after = await waitFor(`${b} to sign with its new key`, async () => {
    const keys = await api(b, "GET", "/keys");
    return keys["current"] !== before["current"] ? keys : undefined;
  });
  const there = await start(a, "/payments", { payer, payeeBank: b, payee, amount: "100" });
  const thereBlock = await settled(there["uetr"], a, b);
  const signedBy = ((await api(a, "GET", `/instructions/${there["uetr"]}`))["approvals"] as Json[])[0]?.["signer"];
  if (String(signedBy).toLowerCase() !== String(after["current"]).toLowerCase()) return fail(`${b} co-signed with ${signedBy}, not its new key`);
  const back = await start(b, "/payments", { payer: payee, payeeBank: a, payee: payer, amount: "50" });
  lastBlock = await settled(back["uetr"], b, a);
  console.log(`  ${b} co-signed a payment with key ${(after["keys"] as Json[]).find((k) => k["status"] === "active")?.["generation"]} (block ${thereBlock}) and sent one (block ${lastBlock}); its balances never left its address`);
});

await step("§15  every participant's audit log proves invariant 12, and its hash chain shows an edited entry", async () => {
  for (const participant of participants) {
    const reconciliation = await api(participant, "GET", "/reconciliation");
    const policy = (reconciliation["checks"] as Json[]).filter((c) => c["invariant"] === 12);
    if (policy.length === 0 || policy.some((c) => !c["ok"])) return fail(`${participant}'s reconciler does not hold invariant 12: ${JSON.stringify(policy)}`);
    const chain = await api(participant, "GET", "/audit/verify");
    if (!chain["ok"]) return fail(`${participant}'s audit chain breaks at entry ${chain["brokenAt"]?.seq}`);
    console.log(`  ${participant.padEnd(14)} ${String(chain["entries"]).padStart(4)} entries, chain verifies to ${String(chain["head"]).slice(0, 12)}; ${policy[0]!["chain"]}`);
  }
  console.log(`  ${approvalsGiven.length} approval${approvalsGiven.length === 1 ? "" : "s"} given in this run, each by an operator other than the initiator`);

  // Behind the service's back, as someone with database access could: the table refuses the edit,
  // so its rules are switched off first. The chain still shows where the log was changed.
  const books = await Ledger.open({ connectionString: DATABASE_URL, schema: booksSchema(a, deployment) });
  const db = books.database;
  const target = (await db.execute(sql`SELECT seq::text AS seq, actor FROM audit_log WHERE action = 'approved' ORDER BY audit_log.seq LIMIT 1`)).rows[0] as
    | { seq: string; actor: string }
    | undefined;
  if (target) {
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`);
    await db.execute(sql`UPDATE audit_log SET actor = 'operator:someone-else' WHERE seq = ${target.seq}::bigint`);
    const broken = await api(a, "GET", "/audit/verify");
    if (broken["ok"] || broken["brokenAt"]?.seq !== target.seq) return fail(`An edited audit entry ${target.seq} was not caught: ${JSON.stringify(broken)}`);
    console.log(red(`  edited entry ${target.seq} (who approved): the chain breaks there, "${broken["brokenAt"].reason}"`));
    await db.execute(sql`UPDATE audit_log SET actor = ${target.actor} WHERE seq = ${target.seq}::bigint`);
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change`);
    const restored = await api(a, "GET", "/audit/verify");
    if (!restored["ok"]) return fail("The restored audit log does not verify");
    console.log(green("  put back exactly as it was, it verifies again: the chain proves content, not who holds the database"));
  }
  await books.close();
});

await step(`§6   a corrupted entry in ${a}'s books shows up as a break`, async () => {
  const books = await Ledger.open({ connectionString: DATABASE_URL, schema: booksSchema(a, deployment) });
  const one = parseMoney(ccy, "1");
  const at = await client.getBlockNumber();
  // Balanced, and wrong: it claims tokens moved that never moved on chain.
  await books.post({
    idempotencyKey: `e2e-corruption-${at}`,
    description: "Deliberately wrong entry (end-to-end test)",
    status: "posted",
    at: new Date(),
    ledgerBlock: at,
    lines: [debit(bankAccounts.tokenizedDeposit(payer), one), credit(bankAccounts.customerDeposit(payer), one)],
  });
  console.log(`  wrote a balanced but false entry to ${a}'s journal at block ${at}`);
  const broken = await waitFor(`${a} to report the break`, async () => {
    const r = await api(a, "GET", "/reconciliation");
    return r["block"] !== null && BigInt(r["block"]) > at && r["ok"] === false ? r : undefined;
  });
  for (const check of (broken["checks"] as Json[]).filter((c) => !c["ok"])) {
    console.log(red(`  break at block ${broken["block"]}: ${check["account"]} books ${check["books"]}, chain ${check["chain"]}`));
  }

  // The journal is append-only: the fix is a new entry, not an edit.
  const fixAt = await client.getBlockNumber();
  await books.post({
    idempotencyKey: `e2e-correction-${fixAt}`,
    description: "Correction of the deliberately wrong entry",
    status: "posted",
    at: new Date(),
    ledgerBlock: fixAt,
    lines: [debit(bankAccounts.customerDeposit(payer), one), credit(bankAccounts.tokenizedDeposit(payer), one)],
  });
  await books.close();
  const fixed = await waitFor(`${a} to reconcile again`, async () => {
    const r = await api(a, "GET", "/reconciliation");
    return r["block"] !== null && BigInt(r["block"]) > fixAt && r["ok"] === true ? r : undefined;
  });
  console.log(green(`  corrected by a reversing entry at block ${fixAt}; reconciles again at block ${fixed["block"]}`));
  console.log(dim(`  blocks ${at + 1n}–${fixAt} stay recorded as broken in ${a}'s reconciliation history`));
});

await services.stop();
console.log(green(bold("\nEnd to end: every flow settled, every participant reconciled, the corruption was caught.\n")));
process.exit(0);
