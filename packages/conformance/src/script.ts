import { Decimal, minorUnit, parseDecimal } from "@oul/domain";
import { dealerOf, fxRate, type Scenario } from "@oul/scenario";
import type { Capabilities, Directory } from "./adapter.ts";
import type { KitFlow, Step } from "./flows.ts";
import { Generator } from "./generator.ts";
import { Model, Rng } from "./model.ts";
import { roundingProbes } from "./rounding.ts";

/**
 * The kit's scripted run for a scenario (SPEC.md §14): every flow the engine
 * supports, each at least once, then each fault it declares, once. Payments
 * across currencies are made at amounts chosen to land near half a minor
 * unit of the target currency, on both sides of it and on it exactly, so
 * that rounding by any rule but once, half-even, shows. The steps are fixed
 * by the scenario, the engine's capabilities and what its setup funded.
 */
export function scriptedSteps(scenario: Scenario, capabilities: Capabilities, funded?: Directory["funded"]): Step[] {
  const model = new Model(scenario);
  if (funded) model.seed(funded);
  const ids = new Rng(0x5c41);
  const steps: Step[] = [];
  const can = (kind: KitFlow["kind"]) => capabilities.flows.includes(kind);
  const add = (flow: KitFlow) => {
    steps.push({ flow });
    model.apply(flow, { status: "settled" });
  };
  const banks = [...model.banks.keys()];
  const customers = (bank: string) => [...model.bank(bank).deposits.keys()];

  if (can("fund")) {
    for (const bank of banks) {
      for (const currency of model.bank(bank).rtgs.keys()) {
        add({ kind: "fund", id: ids.uetr(), bank, currency, amount: model.bank(bank).rtgs.get(currency)! / 50n });
      }
    }
  }
  if (can("tokenize")) {
    for (const bank of banks) {
      for (const customer of customers(bank).slice(0, 2)) {
        add({ kind: "tokenize", id: ids.uetr(), bank, customer, amount: model.bank(bank).deposits.get(customer)! / 2000n });
      }
    }
  }
  // The payments the engine can make: its routes, or between every two banks, first customer to first customer.
  const routes = (sameCurrency: boolean) =>
    (capabilities.routes ?? banks.flatMap((a) => banks.filter((b) => b !== a).map((b) => ({ payerBank: a, payer: customers(a)[0]!, payeeBank: b, payee: customers(b)[0]! })))).filter(
      (r) => (model.bank(r.payerBank).currency === model.bank(r.payeeBank).currency) === sameCurrency,
    );
  if (can("pay")) {
    for (const { payerBank, payer, payeeBank, payee } of routes(true)) {
      {
        const spendable = min(model.bank(payerBank).tokenized.get(payer)!, model.wholesale(payerBank));
        if (spendable > 10n) add({ kind: "pay", id: ids.uetr(), payerBank, payer, payeeBank, payee, amount: spendable / 10n });
      }
    }
  }
  const dealer = dealerOf(scenario);
  if (can("pay-fx") && dealer) {
    for (const { payerBank, payer, payeeBank, payee } of routes(false).filter((r) => r.payerBank !== dealer && r.payeeBank !== dealer)) {
      {
        const [from, to] = [model.bank(payerBank).currency, model.bank(payeeBank).currency];
        const rate = fxRate(scenario, from, to);
        if (!rate) continue;
        for (const amount of roundingProbes(from, to, rate)) {
          const spendable = min(model.bank(payerBank).tokenized.get(payer)!, model.wholesale(payerBank));
          if (amount > spendable || (model.target(from, to, amount) ?? 0n) > model.wholesale(dealer, to)) continue;
          add({ kind: "pay-fx", id: ids.uetr(), payerBank, payer, payeeBank, payee, amount });
        }
      }
    }
  }
  for (const bond of scenario.instruments.bonds) {
    if (!can("bond-issue")) break;
    const holders = banks.filter((b) => b !== bond.agent).slice(0, 2);
    const face = parseDecimal(bond.face).times(new Decimal(10).toPower(minorUnit(bond.currency)));
    const price = BigInt(face.toFixed(0));
    add({ kind: "bond-issue", id: ids.uetr(), bond: bond.symbol, price, allocations: holders.map((bank) => ({ bank, units: 100n })) });
    if (can("bond-trade") && holders.length === 2) {
      add({ kind: "bond-trade", id: ids.uetr(), bond: bond.symbol, seller: holders[0]!, buyer: holders[1]!, units: 10n, price: (price * 1002n) / 1000n });
    }
    // With repo, every bond is issued first and its payments wait until the repos have closed.
    if (can("bond-payment") && !scenario.repo) {
      // The agent pays from its own wholesale: enough for 200 units' face and every coupon on them.
      add({ kind: "fund", id: ids.uetr(), bank: bond.agent, currency: bond.currency, amount: price * 300n });
      while (!model.redeemed(bond.symbol) && model.nextBondPayment(bond.symbol)) {
        add({ kind: "bond-payment", id: ids.uetr(), bond: bond.symbol });
      }
    }
  }
  if (scenario.repo && can("repo-open")) {
    repoSteps(scenario, model, ids, add);
    for (const bond of scenario.instruments.bonds) {
      if (!can("bond-payment")) break;
      const face = BigInt(parseDecimal(bond.face).times(new Decimal(10).toPower(minorUnit(bond.currency))).toFixed(0));
      add({ kind: "fund", id: ids.uetr(), bank: bond.agent, currency: bond.currency, amount: face * 300n });
      while (!model.redeemed(bond.symbol) && model.nextBondPayment(bond.symbol)) {
        add({ kind: "bond-payment", id: ids.uetr(), bond: bond.symbol });
      }
    }
  }
  if (can("detokenize")) {
    for (const bank of banks) {
      const customer = customers(bank)[0]!;
      const held = model.bank(bank).tokenized.get(customer)!;
      if (held > 2n) add({ kind: "detokenize", id: ids.uetr(), bank, customer, amount: held / 2n });
    }
  }
  if (can("redeem")) {
    for (const bank of banks) {
      for (const currency of model.bank(bank).wholesale.keys()) {
        const held = model.wholesale(bank, currency);
        if (held > 10n) add({ kind: "redeem", id: ids.uetr(), bank, currency, amount: held / 10n });
      }
    }
  }
  const generator = new Generator(model, new Rng(0xfa17), capabilities);
  // Where the kit funds payers itself, it knows what they hold: a payment for more must be refused.
  if (can("pay") && can("tokenize")) {
    const overspend = generator.payment({ feasible: false });
    if (overspend) steps.push({ flow: overspend });
  }
  for (const kind of capabilities.faults) {
    const fault = generator.fault(kind);
    if (!fault) continue;
    steps.push({ fault });
    // Flows a participant-down fault runs settle as any. Whether a fault's own payment settles is the engine's
    // to say: the script counts its payer's side spent and never its payee's credit, so the faults after it
    // propose only what is there either way.
    if ("flows" in fault) for (const flow of fault.flows) model.apply(flow, { status: "settled" });
    else model.spend(fault.flow);
  }
  return steps;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * A repo's whole life (SPEC.md §5.7–§5.10), between the first two banks that
 * hold the collateral bonds: opened against units of the first bond, margined
 * at a mark that falls short, its collateral substituted for the second bond,
 * and closed, principal plus interest.
 */
function repoSteps(scenario: Scenario, model: Model, ids: Rng, add: (flow: KitFlow) => void): void {
  const spec = scenario.repo!;
  const [first, second] = spec.collateral;
  if (!first || !second) return;
  const bonds = scenario.instruments.bonds.filter((b) => spec.collateral.includes(b.symbol));
  const agents = new Set(bonds.map((b) => b.agent));
  const parties = [...model.banks.keys()].filter((b) => !agents.has(b));
  const [lender, borrower] = parties;
  if (!lender || !borrower) return;
  const currency = bonds[0]!.currency;
  const faceOf = (symbol: string) => BigInt(parseDecimal(bonds.find((b) => b.symbol === symbol)!.face).times(new Decimal(10).toPower(minorUnit(currency))).toFixed(0));
  const units = model.freeUnits(borrower, first) / 2n;
  if (units === 0n) return;
  // Cash just under what the units cover at face after the 2% haircut, so a 3% fall calls margin.
  const cash = (units * faceOf(first) * 98n * 99n) / 10_000n;
  const id = ids.uetr();
  add({ kind: "repo-open", id, lender, borrower, bond: first, units, mark: faceOf(first), cash, rate: "0.0275", haircut: "0.02", startDate: "2027-04-26", endDate: "2027-05-10" });
  // The first bond falls 3%: the collateral no longer covers, the borrower delivers more of it.
  add({ kind: "repo-margin", id: ids.uetr(), repo: id, marks: [{ bond: first, price: (faceOf(first) * 97n) / 100n }, { bond: second, price: faceOf(second) }], asOf: "2027-05-03", bond: first });
  const held = model.repo(id)?.collateral.find((c) => c.bond === first);
  if (held) {
    const marks = [{ bond: first, price: faceOf(first) }, { bond: second, price: (faceOf(second) * 99n) / 100n }];
    add({ kind: "repo-substitute", id: ids.uetr(), repo: id, outgoing: held, incoming: second, marks, asOf: "2027-05-05" });
  }
  add({ kind: "repo-close", id: ids.uetr(), repo: id });
}
