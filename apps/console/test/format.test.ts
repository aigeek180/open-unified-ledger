import { describe, expect, it } from "vitest";
import { count, describe as describeInstruction, kindLabel, terms } from "../lib/format";
import type { Instruction, Network } from "../lib/services";

const network = {
  participants: [
    { id: "bank-a", name: "Bank A", kind: "bank" },
    { id: "bank-b", name: "Bank B", kind: "bank" },
  ],
  instruments: { wholesale: [{ symbol: "wCAD", issuer: "central-bank", currency: "CAD" }], deposits: [], bonds: [] },
} as unknown as Network;

const repo = "b1577889-81b4-40d0-ab5f-4a31fc4d7636";
const base = { amount: "0", currency: "CAD", role: "approver", status: "settled", entry: "posted", deadline: "", settledBlock: "1", txHash: null, error: null, createdAt: "" } as const;
const flow = (kind: Instruction["kind"], fields: Partial<Instruction>): Instruction => ({ ...base, uetr: repo, kind, lender: "bank-a", borrower: "bank-b", repo, ...fields });

// The services report a repo's flows as instructions like any other (SPEC.md §5.7–§5.10); each needs a name and a line in the console.
describe("repo instructions in the console", () => {
  it("names each repo flow and says what it moves", () => {
    const lines = [
      flow("repo-open", { bond: "BOND-ISSUER-2031", units: "10300" }),
      flow("repo-margin", { bond: "BOND-ISSUER-2031", units: "13", direction: "deliver" }),
      flow("repo-margin", { bond: "BOND-ISSUER-2031", units: "13", direction: "return" }),
      flow("repo-substitute", { outgoing: { bond: "BOND-ISSUER-2031", units: "10313" }, incoming: { bond: "BOND-ISSUER-2029", units: "10462" } }),
      flow("repo-close", {}),
      flow("repo-manufactured", { bond: "BOND-ISSUER-2031", period: 1 }),
    ].map((i) => `${kindLabel(i.kind)}: ${describeInstruction(i, network)}`);
    expect(lines).toEqual([
      "Repo opened: Bank A lends to Bank B against 10,300 BOND-ISSUER-2031",
      "Repo margin: Bank B delivers 13 BOND-ISSUER-2031 to Bank A, repo b1577889",
      "Repo margin: Bank A returns 13 BOND-ISSUER-2031 to Bank B, repo b1577889",
      "Repo substitution: Bank B takes back 10,313 BOND-ISSUER-2031 for 10,462 BOND-ISSUER-2029, repo b1577889",
      "Repo closed: Bank B repays Bank A principal plus interest, every unit back, repo b1577889",
      "Manufactured payment: Bank A passes BOND-ISSUER-2031 coupon 1 on to Bank B, repo b1577889",
    ]);
  });

  it("gives an opening its terms, and only a payment across currencies a dealer's quote", () => {
    const open = flow("repo-open", { bond: "BOND-ISSUER-2031", units: "10300", rate: "0.0275", haircut: "0.02", startDate: "2027-04-26", endDate: "2027-05-10" });
    expect(terms(open)).toBe("At 0.0275 a year, haircut 0.02, from 2027-04-26 to 2027-05-10");
    const pvp: Instruction = { ...base, uetr: repo, kind: "pvp", rate: "0.7300", target: { amount: "730.00", currency: "USD" } };
    expect(terms(pvp)).toBe("At the dealer's quote of 0.7300 USD per CAD");
    expect(terms(flow("repo-close", { rate: "0.0275" }))).toBeNull();
  });
});

describe("counts", () => {
  it("puts one thing in the singular", () => {
    expect([count(1, "overspend", "overspends"), count(0, "fault", "faults"), count(4, "fault", "faults")]).toEqual(["1 overspend", "0 faults", "4 faults"]);
  });
});
