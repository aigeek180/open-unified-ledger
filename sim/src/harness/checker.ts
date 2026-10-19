import { contracts, type Deployment, type Network, rpcUrlFor, sandboxChain } from "@oul/chain";
import {
  bankAccounts,
  type CollateralLine,
  centralBankAccounts,
  convert,
  formatMoney,
  isCovered,
  money,
  moveCollateral,
  type RepoTerms,
  repurchasePrice,
} from "@oul/domain";
import { Ledger } from "@oul/ledger";
import { allAudit, booksSchema, type FxFlow, policyViolations, type RepoFlow, verifyAudit } from "@oul/participant";
import { centralBankFor, centralBanks, depositOf, registryOperator, type Scenario, wholesaleFor } from "@oul/scenario";
import { sql } from "drizzle-orm";
import { type Address, createPublicClient, type Hex, http, parseEventLogs, type PublicClient } from "viem";

/**
 * Every invariant of SPEC.md §6, checked from outside the services: each
 * participant's books read straight from Postgres, the chain read straight
 * from a node. Nothing a service reports about itself is taken on trust.
 */

export interface Check {
  readonly invariant: string;
  readonly what: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const pass = (invariant: string, what: string): Check => ({ invariant, what, ok: true });
const failed = (invariant: string, what: string, detail: string): Check => ({ invariant, what, ok: false, detail });

export class Checker {
  private readonly books = new Map<string, Ledger>();
  private readonly client: PublicClient;
  private readonly scenario: Scenario;
  private readonly deployment: Deployment;
  private readonly centralBanks: string[];
  private readonly banks: string[];

  constructor(scenario: Scenario, deployment: Deployment, network: Network) {
    this.scenario = scenario;
    this.deployment = deployment;
    this.centralBanks = centralBanks(scenario).map((p) => p.id);
    this.banks = scenario.participants.filter((p) => p.kind === "bank").map((p) => p.id);
    this.client = createPublicClient({
      chain: sandboxChain(network.chainId, rpcUrlFor(network, registryOperator(scenario).id)),
      transport: http(),
      cacheTime: 0,
    }) as PublicClient;
  }

  async open(databaseUrl: string): Promise<void> {
    for (const id of [...this.centralBanks, ...this.banks]) {
      this.books.set(id, await Ledger.open({ connectionString: databaseUrl, schema: booksSchema(id, this.deployment) }));
    }
  }

  async close(): Promise<void> {
    for (const ledger of this.books.values()) await ledger.close();
  }

  head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  /** The last block each participant's listener has fully processed. */
  async cursors(): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const [id, ledger] of this.books) {
      const rows = (await ledger.database.execute(sql`SELECT last_block::text AS b FROM chain_cursor`)).rows;
      out.set(id, rows[0] ? BigInt(String(rows[0]["b"])) : -1n);
    }
    return out;
  }

  /** What must hold at `block` for every participant that has processed it. */
  async atBlock(block: bigint): Promise<Check[]> {
    const cursors = await this.cursors();
    const caughtUp = (id: string) => (cursors.get(id) ?? -1n) >= block;
    const checks: Check[] = [];
    for (const [id, ledger] of this.books) {
      if (!caughtUp(id)) continue;
      const totals = (await ledger.trialBalance()).totals;
      const imbalance = [...totals].find(([, t]) => t !== 0n);
      checks.push(
        imbalance === undefined
          ? pass("1", `${id} books balance in each currency`)
          : failed("1", `${id} books balance`, `off by ${imbalance[1]} minor units of ${imbalance[0]}`),
      );

      const runs = (
        await ledger.database.execute(sql`SELECT count(*) FILTER (WHERE NOT ok)::int AS bad, count(*)::int AS n FROM reconciliation_runs`)
      ).rows[0]!;
      checks.push(
        Number(runs["bad"]) === 0
          ? pass("2,3,8,10,12,13,14", `${id} every reconciliation held (${runs["n"]} runs)`)
          : failed("2,3,8,10,12,13,14", `${id} reconciliation`, `${runs["bad"]} of ${runs["n"]} runs found a break`),
      );

      const breaks = (await ledger.database.execute(sql`SELECT kind, count(*)::int AS n FROM chain_breaks GROUP BY kind`)).rows;
      checks.push(
        breaks.length === 0
          ? pass("5,7", `${id} listener booked every movement it saw`)
          : failed("5,7", `${id} listener breaks`, breaks.map((b) => `${b["n"]} ${b["kind"]}`).join(", ")),
      );
    }

    // Invariant 2 across participants, in each currency: its central bank's line for each bank
    // holding it is that bank's reserves in it.
    for (const currency of this.scenario.currencies) {
      const cb = centralBankFor(this.scenario, currency).id;
      if (!caughtUp(cb)) continue;
      for (const bank of this.scenario.participants.filter((p) => p.kind === "bank" && p.reserves.includes(currency))) {
        if (!caughtUp(bank.id)) continue;
        const line = await this.books.get(cb)!.balanceAtBlock(centralBankAccounts.wholesaleLine(bank.id), block);
        const reserves = await this.books.get(bank.id)!.balanceAtBlock(bankAccounts.wholesaleReserves(currency), block);
        checks.push(
          line.minor === reserves.minor
            ? pass("2", `${cb}'s line for ${bank.id} = ${bank.id}'s ${currency} reserves at block ${block}`)
            : failed("2", `${cb}'s line for ${bank.id} at block ${block}`, `${formatMoney(line)} vs ${formatMoney(reserves)}`),
        );
      }
    }
    return checks;
  }

  /** What must hold over the whole run: conservation, atomicity, exactly once, eligibility, authority. */
  async global(): Promise<Check[]> {
    const checks: Check[] = [];
    const engine = this.deployment.contracts.engine;
    const logs = await this.client.getLogs({ address: engine, fromBlock: BigInt(this.deployment.startBlock), toBlock: "latest" });
    const settledEvents = parseEventLogs({ abi: contracts.SettlementEngine.abi, logs, eventName: "InstructionSettled" });
    const settledCount = new Map<string, number>();
    for (const event of settledEvents) {
      const id = (event.args as { id: Hex }).id;
      settledCount.set(id, (settledCount.get(id) ?? 0) + 1);
    }

    // Invariant 6: each instruction id settled at most once on chain.
    const twice = [...settledCount].filter(([, n]) => n > 1);
    checks.push(
      twice.length === 0
        ? pass("6", `${settledEvents.length} instructions settled, each exactly once`)
        : failed("6", "exactly once", `${twice.length} ids settled more than once`),
    );

    // Invariants 5 and 9, per participant row.
    const submitterOf = new Map<string, string>();
    for (const [id, ledger] of this.books) {
      const rows = (await ledger.database.execute(sql`SELECT uetr, role, status, entry_key, settled_block::text AS block FROM instructions`)).rows;
      let wrong = 0;
      for (const row of rows) {
        const uetr = String(row["uetr"]);
        const chainId = `0x${uetr.replaceAll("-", "")}${"0".repeat(32)}` as Hex;
        const onChain = (await this.client.readContract({
          address: engine,
          abi: contracts.SettlementEngine.abi,
          functionName: "settledAt",
          args: [chainId],
        })) as bigint;
        const entry = await ledger.entryByKey(String(row["entry_key"]));
        const status = String(row["status"]);
        if (status === "settled" && (onChain === 0n || onChain.toString() !== row["block"] || entry?.status !== "posted")) wrong++;
        if ((status === "failed" || status === "expired") && (onChain !== 0n || entry?.status !== "voided")) wrong++;
        if (row["role"] === "submitter") submitterOf.set(chainId, id);
      }
      checks.push(
        wrong === 0
          ? pass("5", `${id}: every settled instruction is posted at its block, every refused one voided with nothing on chain`)
          : failed("5", `${id} atomicity`, `${wrong} instructions where books and chain disagree`),
      );
    }

    // Invariant 9: whatever settled was submitted by the participant that recorded itself as its submitter.
    let unauthored = 0;
    for (const event of settledEvents) {
      const id = (event.args as { id: Hex }).id;
      const tx = await this.client.getTransaction({ hash: event.transactionHash! });
      // Whose signing key sent it, as the registry had it in that block: a participant may have moved keys since.
      const signer = (await this.client.readContract({
        address: this.deployment.contracts.registry,
        abi: contracts.ParticipantRegistry.abi,
        functionName: "signerOf",
        args: [tx.from],
        blockNumber: event.blockNumber! - 1n,
      })) as Hex;
      const sender = Object.entries(this.deployment.participants).find(([, p]) => p.idHash === signer)?.[0];
      if (!sender || submitterOf.get(id) !== sender) unauthored++;
    }
    checks.push(
      unauthored === 0
        ? pass("9", "every settlement was sent by the participant that submitted it")
        : failed("9", "authority", `${unauthored} settlements without a matching submitter`),
    );

    // Invariant 4: tokenizing never changes a bank's deposits; only settled payments to or from its
    // customers move them, in one currency or across two.
    for (const bank of this.banks) {
      const ledger = this.books.get(bank)!;
      const deposits =
        (await ledger.balance(bankAccounts.customerDeposits)).posted.minor + (await ledger.balance(bankAccounts.tokenizedDeposits)).posted.minor;
      const opening = this.scenario.ledgers
        .find((l) => l.participant === bank)!
        .opening.filter((l) => l.account.startsWith(`${bankAccounts.customerDeposits}/`))
        .reduce((t, l) => t + l.amount.minor, 0n);
      const flows = (
        await ledger.database.execute(sql`
          SELECT coalesce(sum(CASE
                   WHEN flow->>'payeeBank' = ${bank} THEN coalesce(flow->'quote'->>'targetAmount', flow->>'amount')::numeric
                   WHEN flow->>'payerBank' = ${bank} THEN -coalesce(flow->'quote'->>'sourceAmount', flow->>'amount')::numeric
                   ELSE 0 END), 0)::text AS net
            FROM instructions WHERE flow->>'kind' IN ('interbank', 'pvp') AND status = 'settled'`)
      ).rows[0]!;
      // At a bond's agent the issuer's deposit is credited with issue proceeds and debited for payments (SPEC.md §5.4, §5.6).
      const bondFlows = (
        await ledger.database.execute(sql`
          SELECT flow FROM instructions WHERE role = 'submitter' AND status = 'settled' AND flow->>'kind' IN ('bond-issue', 'bond-coupon', 'bond-redeem')`)
      ).rows.map((r) => r["flow"] as Record<string, any>);
      const issuer = bondFlows.reduce(
        (t, f) =>
          t +
          (f["kind"] === "bond-issue"
            ? (f["allocations"] as { units: string }[]).reduce((u, a) => u + BigInt(a.units) * BigInt(f["price"]), 0n)
            : -BigInt(f["issuerDebit"])),
        0n,
      );
      const expected = opening + BigInt(String(flows["net"])) + issuer;
      const currency = depositOf(this.scenario, bank).currency;
      checks.push(
        deposits === expected
          ? pass("4", `${bank} deposits moved only by payments${issuer !== 0n ? " and its issuer's bond proceeds and payments" : ""}`)
          : failed("4", `${bank} deposit conservation`, `${formatMoney(money(currency, deposits))} vs ${formatMoney(money(currency, expected))}`),
      );
    }

    // Invariant 7: every holder of a deposit token is allowlisted, and only banks with a reserve
    // account in a currency hold its wholesale token.
    let ineligible = 0;
    for (const customer of Object.values(this.deployment.customers)) {
      const symbol = this.scenario.instruments.deposits.find((d) => d.issuer === customer.bank)!.symbol;
      const token = this.deployment.tokens[symbol]!.address;
      const read = (functionName: string, args: readonly unknown[]) =>
        this.client.readContract({ address: token, abi: contracts.DepositToken.abi, functionName, args } as never);
      if (((await read("balanceOf", [customer.address])) as bigint) > 0n && !((await read("canReceive", [customer.address])) as boolean)) {
        ineligible++;
      }
    }
    for (const spec of this.scenario.instruments.wholesale) {
      const token = this.deployment.tokens[spec.symbol]!.address;
      const read = (functionName: string, holder: Address) =>
        this.client.readContract({ address: token, abi: contracts.WholesaleToken.abi, functionName, args: [holder] } as never);
      for (const p of Object.values(this.deployment.participants)) {
        if (((await read("balanceOf", p.address)) as bigint) > 0n && !((await read("canReceive", p.address)) as boolean)) ineligible++;
      }
    }
    checks.push(ineligible === 0 ? pass("7", "every holder is eligible") : failed("7", "eligibility", `${ineligible} ineligible holders`));
    if (this.scenario.fx) checks.push(await this.fxConsistency());
    if (this.scenario.repo) checks.push(await this.repoCollateral());
    checks.push(...(await this.policies()));
    return checks;
  }

  /**
   * Invariant 12 from each participant's audit log, read straight from its
   * schema: nothing was released or submitted before the approvals its policy
   * required, by operators other than its initiator; and the log's hash chain
   * verifies, so the log is the evidence it claims to be.
   */
  private async policies(): Promise<Check[]> {
    const checks: Check[] = [];
    for (const [id, ledger] of this.books) {
      const entries = await allAudit(ledger.database);
      const chain = await verifyAudit(ledger.database, entries);
      const violations = policyViolations(entries);
      const approved = entries.filter((e) => e.action === "approved").length;
      checks.push(
        !chain.ok
          ? failed("12", `${id} audit log`, `the chain breaks at entry ${chain.brokenAt!.seq}: ${chain.brokenAt!.reason}`)
          : violations.length > 0
            ? failed("12", `${id} policy`, violations.slice(0, 3).map((v) => `${v.subject}: ${v.problem}`).join("; "))
            : pass("12", `${id} released nothing before its policy's approvals (${approved} approvals, ${entries.length} audit entries, chain verifies)`),
      );
    }
    return checks;
  }

  /**
   * Invariant 14 from the chain and the borrowers' instructions: replaying
   * each repo's settled flows, every movement on chain is exactly the units
   * and cash its flow names; the lender's units of each bond on chain are
   * what it owns plus the collateral it holds in open repos; every margin
   * left the collateral covering cash plus interest at its marks; and every
   * close moved back every unit and exactly the purchase price plus interest.
   */
  private async repoCollateral(): Promise<Check> {
    const problems: string[] = [];
    let flows = 0;
    let repos = 0;
    const address = (ref: string) => this.deployment.participants[ref]!.address.toLowerCase();
    const token = (symbol: string) => this.deployment.tokens[symbol]!.address.toLowerCase();
    for (const bank of this.banks) {
      // Each repo once, from its borrower's books: every flow of it is booked there.
      const rows = (
        await this.books.get(bank)!.database.execute(sql`
          SELECT uetr, flow, settled_block::text AS block FROM instructions
           WHERE flow->>'kind' LIKE 'repo-%' AND flow->>'borrower' = ${bank} AND status = 'settled'
           ORDER BY settled_block, uetr`)
      ).rows.map((r) => ({ uetr: String(r["uetr"]), flow: r["flow"] as RepoFlow, block: BigInt(String(r["block"])) }));
      const opens = rows.filter((r) => r.flow.kind === "repo-open");
      for (const open of opens) {
        repos++;
        const o = open.flow as Extract<RepoFlow, { kind: "repo-open" }>;
        const currency = this.scenario.instruments.bonds[0]!.currency;
        const terms: RepoTerms = { cash: money(currency, BigInt(o.cash)), rate: o.rate, haircut: o.haircut, startDate: o.startDate, endDate: o.endDate, dayCount: "ACT/365F" };
        let collateral: CollateralLine[] = [];
        for (const { flow, block, uetr } of rows.filter((r) => r.uetr === open.uetr || (r.flow as { repo?: string }).repo === open.uetr)) {
          flows++;
          // The transaction that settled it, from the engine's own event: the borrower did not send every one.
          const [settled] = await this.client.getContractEvents({
            address: this.deployment.contracts.engine,
            abi: contracts.SettlementEngine.abi,
            eventName: "InstructionSettled",
            args: { id: `0x${uetr.replaceAll("-", "")}${"0".repeat(32)}` as Hex },
            fromBlock: block,
            toBlock: block,
          });
          if (!settled?.transactionHash) {
            problems.push(`${uetr} (${flow.kind}) is booked settled in block ${block}, which shows no such settlement`);
            continue;
          }
          const receipt = await this.client.getTransactionReceipt({ hash: settled.transactionHash });
          const moved = parseEventLogs({ abi: contracts.WholesaleToken.abi, logs: receipt.logs, eventName: "Transfer" }).map(
            (t) => `${t.address.toLowerCase()}|${t.args.from.toLowerCase()}|${t.args.to.toLowerCase()}|${t.args.value}`,
          );
          const expected: string[] = [];
          const units = (bond: string, from: string, to: string, n: bigint) => expected.push(`${token(bond)}|${address(from)}|${address(to)}|${n}`);
          const cash = (from: string, to: string, n: bigint) => expected.push(`${token(this.scenario.instruments.wholesale[0]!.symbol)}|${address(from)}|${address(to)}|${n}`);
          if (flow.kind === "repo-open") {
            units(flow.bond, flow.borrower, flow.lender, BigInt(flow.units));
            cash(flow.lender, flow.borrower, BigInt(flow.cash));
            collateral = [{ bond: flow.bond, units: BigInt(flow.units) }];
          } else if (flow.kind === "repo-margin") {
            const [from, to] = flow.direction === "deliver" ? [flow.borrower, flow.lender] : [flow.lender, flow.borrower];
            units(flow.bond, from, to, BigInt(flow.units));
            collateral = moveCollateral(collateral, flow.bond, (flow.direction === "deliver" ? 1n : -1n) * BigInt(flow.units));
            const marks = flow.marks.map((m) => ({ bond: m.bond, price: money(currency, BigInt(m.price)) }));
            if (!isCovered(terms, collateral, marks, flow.asOf)) problems.push(`${uetr}: margin left the repo uncovered at its marks`);
          } else if (flow.kind === "repo-substitute") {
            units(flow.outgoing.bond, flow.lender, flow.borrower, BigInt(flow.outgoing.units));
            units(flow.incoming.bond, flow.borrower, flow.lender, BigInt(flow.incoming.units));
            collateral = moveCollateral(moveCollateral(collateral, flow.outgoing.bond, -BigInt(flow.outgoing.units)), flow.incoming.bond, BigInt(flow.incoming.units));
          } else if (flow.kind === "repo-close") {
            for (const line of collateral) units(line.bond, flow.lender, flow.borrower, line.units);
            cash(flow.borrower, flow.lender, repurchasePrice(terms).minor);
            collateral = [];
          } else {
            cash(flow.lender, flow.borrower, BigInt(flow.amount));
          }
          const [a, b] = [[...moved].sort().join(","), [...expected].sort().join(",")];
          if (a !== b) problems.push(`${uetr} (${flow.kind}) moved ${moved.length} legs not as its repo requires`);
        }
      }
    }
    return problems.length === 0
      ? pass("14", `${repos} repos, ${flows} flows: each moved on chain exactly its collateral and cash, margins left them covered, closes repaid principal plus interest`)
      : failed("14", "repo collateral", problems.slice(0, 3).join("; "));
  }

  /**
   * Invariant 11 from the chain: for every payment across currencies the
   * payer's bank recorded as settled, the transaction moved the quote's
   * source amount out of the payer and into the dealer in one currency and
   * its target amount out of the dealer and into the payee in the other, and
   * the target is the source at the quoted rate, rounded once, half-even.
   */
  private async fxConsistency(): Promise<Check> {
    let checked = 0;
    const wrong: string[] = [];
    for (const bank of this.banks) {
      const rows = (
        await this.books.get(bank)!.database.execute(sql`
          SELECT uetr, flow, tx_hash FROM instructions WHERE flow->>'kind' = 'pvp' AND role = 'submitter' AND status = 'settled'`)
      ).rows;
      for (const row of rows) {
        const flow = row["flow"] as FxFlow;
        const { quote } = flow;
        const receipt = await this.client.getTransactionReceipt({ hash: String(row["tx_hash"]) as Hex });
        const transfers = parseEventLogs({ abi: contracts.WholesaleToken.abi, logs: receipt.logs, eventName: "Transfer" });
        const party = (ref: string) => (this.deployment.participants[ref] ?? this.deployment.customers[ref])!.address.toLowerCase();
        const token = (symbol: string) => this.deployment.tokens[symbol]!.address.toLowerCase();
        const moved = (symbol: string, from: string, to: string) =>
          transfers
            .filter((t) => t.address.toLowerCase() === token(symbol) && t.args.from.toLowerCase() === from && t.args.to.toLowerCase() === to)
            .reduce((total, t) => total + t.args.value, 0n);
        const zero = "0x0000000000000000000000000000000000000000";
        const source = BigInt(quote.sourceAmount);
        const target = BigInt(quote.targetAmount);
        const legs = [
          moved(depositOf(this.scenario, flow.payerBank).symbol, party(`${flow.payerBank}/${flow.payer}`), zero) === source,
          moved(wholesaleFor(this.scenario, quote.from).symbol, party(flow.payerBank), party(quote.dealer)) === source,
          moved(wholesaleFor(this.scenario, quote.to).symbol, party(quote.dealer), party(flow.payeeBank)) === target,
          moved(depositOf(this.scenario, flow.payeeBank).symbol, zero, party(`${flow.payeeBank}/${flow.payee}`)) === target,
        ];
        const priced = convert(money(quote.from, source), quote.rate, quote.to).minor === target;
        checked++;
        if (!legs.every(Boolean) || !priced) wrong.push(String(row["uetr"]));
      }
    }
    return wrong.length === 0
      ? pass("11", `${checked} payments across currencies moved, on chain, exactly the dealer's quoted amounts`)
      : failed("11", "FX consistency", `${wrong.length} payments differ from their quotes: ${wrong.join(", ")}`);
  }
}

