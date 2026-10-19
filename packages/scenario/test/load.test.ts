import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CurrencyCode, formatMoney, sum } from "@oul/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  centralBankFor,
  depositOf,
  homeCurrency,
  loadScenario,
  registryOperator,
  ScenarioError,
  wholesaleFor,
} from "../src/index.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const scenariosDir = path.join(root, "scenarios");
const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

describe("shipped scenarios", () => {
  it("loads ca-interbank with balanced opening books for every ledger", async () => {
    const scenario = await loadScenario(path.join(scenariosDir, "ca-interbank"));
    expect(scenario.currencies).toEqual(["CAD"]);
    expect(scenario.ledgers.map((l) => l.participant)).toEqual([
      "central-bank",
      "bank-a",
      "bank-b",
      "bank-c",
    ]);
    const bankA = scenario.ledgers.find((l) => l.participant === "bank-a");
    expect(bankA?.chart.map((a) => a.code)).toContain("tokenized-deposits/northwind-freight");
  });

  it("loads ca-bond-dvp with the issuer banking at its agent", async () => {
    const scenario = await loadScenario(path.join(scenariosDir, "ca-bond-dvp"));
    const [bond] = scenario.instruments.bonds;
    expect(bond?.units).toBe(100000n);
    expect(scenario.participants.find((p) => p.id === "issuer")?.agent).toBe("bank-c");
    expect(scenario.ledgers.some((l) => l.participant === "issuer")).toBe(false);
  });

  it("loads ca-repo: two bonds as collateral, and each bank's repo accounts", async () => {
    const scenario = await loadScenario(path.join(scenariosDir, "ca-repo"));
    expect(scenario.repo).toEqual({ dayCount: "ACT/365F", collateral: ["BOND-ISSUER-2031", "BOND-ISSUER-2029"], marginCallSeconds: 300 });
    const chart = scenario.ledgers.find((l) => l.participant === "bank-a")!.chart;
    const codes = chart.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["reverse-repos", "repo-borrowings", "collateral-received/BOND-ISSUER-2029", "collateral-pledged/BOND-ISSUER-2031"]));
    // Collateral at a bank's own address mirrors its units on chain, with its holding; the counterparts do not.
    expect(chart.find((a) => a.code === "collateral-received/BOND-ISSUER-2031")).toMatchObject({ mirrored: true, memorandum: true, type: "asset" });
    expect(chart.find((a) => a.code === "collateral-pledged/BOND-ISSUER-2031")).toMatchObject({ mirrored: true, memorandum: true, type: "liability" });
    expect(chart.find((a) => a.code === "collateral-to-return/BOND-ISSUER-2031")).toMatchObject({ mirrored: false, memorandum: true });
    // Without repo, no repo accounts.
    const bonds = await loadScenario(path.join(scenariosDir, "ca-bond-dvp"));
    expect(bonds.ledgers.find((l) => l.participant === "bank-a")!.chart.some((a) => a.code.startsWith("collateral-"))).toBe(false);
  });

  it("reconciles each central bank's settlement accounts to each bank's RTGS reserves in that currency", async () => {
    for (const id of ["ca-interbank", "ca-bond-dvp", "ca-us-pvp", "ca-repo"]) {
      const scenario = await loadScenario(path.join(scenariosDir, id));
      for (const currency of scenario.currencies) {
        const cb = scenario.ledgers.find((l) => l.participant === centralBankFor(scenario, currency).id)!;
        for (const bank of scenario.participants.filter((p) => p.kind === "bank")) {
          const ledger = scenario.ledgers.find((l) => l.participant === bank.id)!;
          const reserves = ledger.opening.filter((l) => l.account === `rtgs-reserves/${currency}`);
          const settlement = cb.opening.filter((l) => l.account === `settlement-accounts/${bank.id}`);
          expect(bank.reserves.includes(currency) || reserves.length + settlement.length === 0).toBe(true);
          expect(formatMoney(sum(currency, reserves.map((l) => l.amount)))).toBe(
            formatMoney(sum(currency, settlement.map((l) => l.amount))),
          );
        }
      }
    }
  });

  it("loads ca-us-pvp: two central banks, each currency's books apart, and a dealer holding both", async () => {
    const scenario = await loadScenario(path.join(scenariosDir, "ca-us-pvp"));
    expect(scenario.currencies).toEqual(["CAD", "USD"]);
    expect(registryOperator(scenario).id).toBe("cad-central-bank");
    expect(centralBankFor(scenario, "USD").id).toBe("usd-central-bank");
    expect(wholesaleFor(scenario, "USD")).toEqual({ symbol: "wUSD", issuer: "usd-central-bank", currency: "USD" });
    expect(depositOf(scenario, "bank-b").currency).toBe("USD");
    expect(homeCurrency(scenario, "bank-c")).toBe("CAD");

    const chart = (participant: string) => scenario.ledgers.find((l) => l.participant === participant)!.chart;
    const currencyOf = (participant: string, code: string) => chart(participant).find((a) => a.code === code)?.currency;
    // Each central bank keeps an account only for the banks holding its currency.
    expect(chart("usd-central-bank").map((a) => a.code)).toEqual(
      expect.arrayContaining(["settlement-accounts/bank-b", "settlement-accounts/bank-c", "wholesale-outstanding/bank-c"]),
    );
    expect(chart("usd-central-bank").some((a) => a.code.endsWith("/bank-a"))).toBe(false);
    expect(chart("usd-central-bank").every((a) => a.currency === "USD")).toBe(true);
    // A bank's own books are in its deposits' currency; its reserves are in theirs.
    expect(currencyOf("bank-b", "customer-deposits/mesa-solar")).toBe("USD");
    expect(currencyOf("bank-b", "wholesale-reserves/USD")).toBe("USD");
    expect(currencyOf("bank-b", "wholesale-reserves/CAD")).toBeUndefined();
    expect(chart("bank-a").some((a) => a.code.startsWith("fx-position/"))).toBe(false);
    // The dealer: reserves and an FX position in each currency.
    for (const currency of ["CAD", "USD"] as CurrencyCode[]) {
      expect(currencyOf("bank-c", `rtgs-reserves/${currency}`)).toBe(currency);
      expect(currencyOf("bank-c", `wholesale-reserves/${currency}`)).toBe(currency);
      expect(currencyOf("bank-c", `fx-position/${currency}`)).toBe(currency);
    }
    const opening = scenario.ledgers.find((l) => l.participant === "bank-c")!.opening;
    expect(new Set(opening.map((l) => l.amount.currency))).toEqual(new Set(["CAD", "USD"]));
  });
});

describe("currency-agnostic engine", () => {
  it("loads a zero-decimal currency with four banks and no engine change", async () => {
    const scenario = await loadScenario(fixture("jp-interbank"));
    expect(scenario.currencies).toEqual(["JPY"]);
    expect(scenario.ledgers).toHaveLength(5);
    const cb = scenario.ledgers.find((l) => l.participant === "central-bank");
    expect(cb?.chart.every((a) => a.currency === "JPY")).toBe(true);
    expect(cb?.chart.map((a) => a.code)).toContain("wholesale-outstanding/bank-d");
  });
});

describe("invalid scenarios", () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(temps.splice(0).map((t) => rm(t, { recursive: true, force: true })));
  });

  /** Copy a scenario and rewrite one file with a text substitution. */
  async function variant(
    source: string,
    file: "scenario.yaml" | "accounts.yaml",
    from: string,
    to: string,
  ): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "oul-scenario-"));
    temps.push(dir);
    await cp(source, dir, { recursive: true });
    const target = path.join(dir, file);
    const text = await readFile(target, "utf8");
    if (!text.includes(from)) throw new Error(`Fixture text not found: ${from}`);
    await writeFile(target, text.replace(from, to));
    return dir;
  }

  async function issuesOf(dir: string): Promise<string[]> {
    try {
      await loadScenario(dir);
    } catch (error) {
      if (error instanceof ScenarioError) return [...error.issues];
      throw error;
    }
    throw new Error("Scenario loaded but should have been rejected");
  }

  const interbank = path.join(scenariosDir, "ca-interbank");

  it.each([
    ["an unbalanced opening entry", "accounts.yaml", `equity, amount: "250000000.00"`, `equity, amount: "250000000.01"`, /credits exceed debits by 1 minor units of CAD/],
    ["more decimals than the currency has", "accounts.yaml", `"25000000.00"`, `"25000000.001"`, /2 decimal places/],
    ["an opening balance on a mirrored account", "accounts.yaml", "credit: customer-deposits/harbour-foods", "credit: tokenized-deposits/harbour-foods", /must open at zero/],
    ["a posting to a control account", "accounts.yaml", "debit: loans-and-securities", "debit: customer-deposits", /control account/],
    ["an unknown account", "accounts.yaml", "debit: loans-and-securities", "debit: goodwill", /no account "goodwill"/],
    ["an unsupported currency", "scenario.yaml", "currencies: [CAD]", "currencies: [XYZ]", /supported ISO 4217/],
    ["an invalid time zone", "scenario.yaml", "America/Toronto", "Canada/Nowhere", /IANA time zone/],
    ["too few validators", "scenario.yaml", "name: Bank C, kind: bank, reserves: [CAD], validator: true", "name: Bank C, kind: bank, reserves: [CAD], validator: false", /at least 4 validators/],
    ["a bank without a deposit token", "scenario.yaml", "    - { symbol: dCAD-C, issuer: bank-c, currency: CAD }\n", "", /bank-c" must issue exactly one/],
    ["a wholesale token not issued by a central bank", "scenario.yaml", "symbol: wCAD, issuer: central-bank", "symbol: wCAD, issuer: bank-a", /must be issued by a central bank/],
    ["a central bank without a currency", "scenario.yaml", "kind: central-bank, currency: CAD,", "kind: central-bank,", /central bank "central-bank" needs its currency/],
    ["a bank without reserves", "scenario.yaml", "name: Bank B, kind: bank, reserves: [CAD]", "name: Bank B, kind: bank", /bank "bank-b" needs the currencies it holds reserves in/],
    ["reserves in a currency the scenario lacks", "scenario.yaml", "name: Bank B, kind: bank, reserves: [CAD]", "name: Bank B, kind: bank, reserves: [CAD, USD]", /holds reserves in USD, which is not one of the scenario's currencies/],
    ["a deposit token in a currency its bank holds no reserves in", "scenario.yaml", "{ symbol: dCAD-B, issuer: bank-b, currency: CAD }", "{ symbol: dCAD-B, issuer: bank-b, currency: USD }", /issuer "bank-b" must hold reserves in USD/],
  ] as const)("rejects %s", async (_label, file, from, to, expected) => {
    const issues = await issuesOf(await variant(interbank, file, from, to));
    expect(issues.join("\n")).toMatch(expected);
  });

  it("rejects an issuer that does not bank with its agent", async () => {
    const dir = await variant(
      path.join(scenariosDir, "ca-bond-dvp"),
      "accounts.yaml",
      "    - { id: issuer, name: Issuer }\n",
      "",
    );
    // Its opening deposit line now names a missing account as well.
    expect((await issuesOf(dir)).join("\n")).toMatch(/must be a customer of its agent/);
  });

  const pvp = path.join(scenariosDir, "ca-us-pvp");

  it.each([
    ["a currency with two central banks", "kind: central-bank, currency: USD,", "kind: central-bank, currency: CAD,", /CAD needs exactly one central bank, found 2/],
    ["a currency without a wholesale token", "    - { symbol: wUSD, issuer: usd-central-bank, currency: USD }\n", "", /USD needs exactly one wholesale token, found 0/],
    ["a wholesale token in another currency than its issuer's", "{ symbol: wUSD, issuer: usd-central-bank, currency: USD }", "{ symbol: wUSD, issuer: cad-central-bank, currency: USD }", /issuer "cad-central-bank" issues CAD/],
    ["a reserve currency listed twice", "reserves: [CAD, USD]", "reserves: [CAD, CAD]", /bank "bank-c" lists a reserve currency twice/],
    ["more than two currencies", "currencies: [CAD, USD]", "currencies: [CAD, USD, EUR]", /currencies/],
    ["a dealer without reserves in a currency it quotes", "dealer: bank-c", "dealer: bank-a", /the dealer holds no reserves in USD, so it cannot quote CAD\/USD/],
    ["a rate with more than six decimal places", `rate: "0.7315"`, `rate: "0.7315001"`, /at most 6 decimal places/],
    ["a rate quoted twice", "{ from: USD, to: CAD", "{ from: CAD, to: USD", /rate CAD\/USD appears twice/],
    ["an interop ledger without its currency's wholesale token", "  wholesale: [wUSD]\n  deposits: [dUSD-B]", "  deposits: [dUSD-B]", /puts one currency's wholesale token on ledger 2/],
    ["deposits on ledger 2 in the other currency", "  wholesale: [wUSD]\n  deposits: [dUSD-B]", "  wholesale: [wUSD]\n  deposits: [dCAD-A]", /dCAD-A is in CAD, not ledger 2's currency/],
  ] as const)("rejects a two-currency scenario with %s", async (_label, from, to, expected) => {
    const issues = await issuesOf(await variant(pvp, "scenario.yaml", from, to));
    expect(issues.join("\n")).toMatch(expected);
  });

  it("rejects an opening entry that balances overall but not in each currency", async () => {
    const dir = await variant(pvp, "accounts.yaml", `{ credit: fx-position/USD, amount: "300000000.00" }`, `{ credit: fx-position/CAD, amount: "300000000.00" }`);
    expect((await issuesOf(dir)).join("\n")).toMatch(/credits exceed debits by 30000000000 minor units of CAD/);
  });

  it("loads the dealer's rates, and rejects FX in a scenario of one currency", async () => {
    const scenario = await loadScenario(pvp);
    expect(scenario.fx).toEqual({
      dealer: "bank-c",
      quoteSeconds: 120,
      rates: [
        { from: "CAD", to: "USD", rate: "0.7315" },
        { from: "USD", to: "CAD", rate: "1.3642" },
      ],
    });
    const dir = await variant(interbank, "scenario.yaml", "interop:", `fx:\n  dealer: bank-c\n  quoteSeconds: 60\n  rates:\n    - { from: CAD, to: USD, rate: "0.73" }\ninterop:`);
    expect((await issuesOf(dir)).join("\n")).toMatch(/a scenario of one currency has nothing to exchange[\s\S]*names USD, which is not one of the scenario's currencies/);
  });

  it("keeps wholesale on the shared ledger in a scenario of one currency", async () => {
    const dir = await variant(interbank, "scenario.yaml", "  deposits: [dCAD-B]", "  wholesale: [wCAD]\n  deposits: [dCAD-B]");
    expect((await issuesOf(dir)).join("\n")).toMatch(/in a scenario of one currency, wholesale stays on the shared ledger/);
    const pvpInterop = (await loadScenario(pvp)).interop!;
    expect(pvpInterop).toMatchObject({ validators: ["usd-central-bank"], wholesale: ["wUSD"], deposits: ["dUSD-B"] });
  });

  it("rejects bonds in a scenario of two currencies", async () => {
    const bond = (await readFile(path.join(scenariosDir, "ca-bond-dvp", "scenario.yaml"), "utf8")).split("  bonds:\n")[1]!;
    const dir = await variant(pvp, "scenario.yaml", "    - { symbol: dCAD-C, issuer: bank-c, currency: CAD }\n", `    - { symbol: dCAD-C, issuer: bank-c, currency: CAD }\n  bonds:\n${bond.replace("issuer: issuer", "issuer: bank-a")}`);
    expect((await issuesOf(dir)).join("\n")).toMatch(/bonds settle in a scenario of one currency/);
  });

  it("rejects a bond that matures before it is issued", async () => {
    const dir = await variant(
      path.join(scenariosDir, "ca-bond-dvp"),
      "scenario.yaml",
      "maturityDate: 2031-11-02",
      "maturityDate: 2026-01-01",
    );
    expect((await issuesOf(dir)).join("\n")).toMatch(/matures on or before issue/);
  });
  it("rejects repo collateral that is not one of the scenario's bonds, or listed twice", async () => {
    const repo = path.join(scenariosDir, "ca-repo");
    const unknown = await variant(repo, "scenario.yaml", "collateral: [BOND-ISSUER-2031, BOND-ISSUER-2029]", "collateral: [BOND-ISSUER-2031, BOND-OTHER]");
    expect((await issuesOf(unknown)).join("\n")).toMatch(/collateral BOND-OTHER is not one of the scenario's bonds/);
    const twice = await variant(repo, "scenario.yaml", "collateral: [BOND-ISSUER-2031, BOND-ISSUER-2029]", "collateral: [BOND-ISSUER-2031, BOND-ISSUER-2031]");
    expect((await issuesOf(twice)).join("\n")).toMatch(/collateral lists a bond twice/);
    const day = await variant(repo, "scenario.yaml", "  dayCount: ACT/365F\n  # The bonds", "  dayCount: ACT/360\n  # The bonds");
    expect((await issuesOf(day)).join("\n")).toMatch(/repo.dayCount/);
  });
});
