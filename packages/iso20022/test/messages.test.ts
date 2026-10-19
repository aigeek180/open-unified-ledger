import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { money } from "@oul/domain";
import { describe, expect, it } from "vitest";
import { buildFixtures, FIXTURES_DIR } from "../scripts/fixtures.ts";
import { MESSAGES, pacs008, readMessage, SCHEMAS_DIR, validate } from "../src/index.ts";

const fixtures = Object.entries(buildFixtures());

describe("ISO 20022 fixtures", () => {
  it.each(fixtures)("%s is what the builders produce now", (file, built) => {
    // Regenerate with `pnpm --filter @oul/iso20022 fixtures` after changing a builder.
    expect(readFileSync(path.join(FIXTURES_DIR, file), "utf8")).toBe(built.xml);
  });

  it.each(fixtures)("%s names its version, identifier, UETR and amounts", (file, built) => {
    const info = readMessage(built.xml);
    expect(info.version).toBe(built.version);
    expect(info.msgId).toBe(built.msgId);
    expect(info.msgId!.length).toBeLessThanOrEqual(35);
    expect(info.uetrs.length, `${file} carries the instruction's UETR`).toBeGreaterThan(0);
    for (const a of info.amounts) {
      expect(["CAD", "USD"]).toContain(a.currency);
      expect(a.value).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("matches the customer payment, its cover and its status report by one UETR", () => {
    const byFile = Object.fromEntries(fixtures.map(([file, built]) => [file, readMessage(built.xml)]));
    const uetr = byFile["5.3-interbank/pacs.008.xml"]!.uetrs[0];
    expect(byFile["5.3-interbank/pacs.009-cover.xml"]!.uetrs).toEqual([uetr]);
    expect(byFile["5.3-interbank/pacs.002-accepted.xml"]!.uetrs).toEqual([uetr]);
    expect(byFile["5.3-interbank/camt.054-payee-credit.xml"]!.uetrs).toEqual([uetr]);
  });
});

describe("a payment across currencies", () => {
  const byFile = Object.fromEntries(fixtures.map(([file, built]) => [file, readMessage(built.xml)]));
  const files = fixtures.map(([file]) => file).filter((file) => file.startsWith("15-pvp/"));

  it("names the whole atomic instruction by one UETR, with a cover for each currency's leg", () => {
    expect(files).toHaveLength(6);
    const uetr = byFile["15-pvp/pacs.008.xml"]!.uetrs[0];
    for (const file of files) expect(byFile[file]!.uetrs, file).toEqual([uetr]);
    expect(byFile["15-pvp/pacs.009-cover-CAD.xml"]!.msgId).not.toBe(byFile["15-pvp/pacs.009-cover-USD.xml"]!.msgId);
  });

  it("instructs in the payer's currency and settles in the payee's, at the dealer's rate", () => {
    const xml = fixtures.find(([f]) => f === "15-pvp/pacs.008.xml")![1].xml;
    const amounts = byFile["15-pvp/pacs.008.xml"]!.amounts.map((a) => `${a.element} ${a.value} ${a.currency}`);
    expect(amounts).toEqual(["TtlIntrBkSttlmAmt 1828.75 USD", "IntrBkSttlmAmt 1828.75 USD", "InstdAmt 2500.00 CAD"]);
    expect(xml).toContain("<XchgRate>0.7315</XchgRate>");
    // Each cover settles its own currency and carries the instructed amount of the payment it covers.
    for (const [leg, settled] of [["CAD", "2500.00 CAD"], ["USD", "1828.75 USD"]]) {
      const cover = byFile[`15-pvp/pacs.009-cover-${leg}.xml`]!.amounts.map((a) => `${a.element} ${a.value} ${a.currency}`);
      expect(cover).toEqual([`TtlIntrBkSttlmAmt ${settled}`, `IntrBkSttlmAmt ${settled}`, "InstdAmt 2500.00 CAD"]);
    }
  });

  it("refuses a rate an ISO 20022 BaseOneRate cannot carry", () => {
    const party = { owner: "A", servicer: { id: "bank-a", name: "Bank A" }, currency: "CAD" as const };
    const build = (rate: string) =>
      pacs008({
        uetr: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
        createdAt: new Date("2026-11-02T15:00:00Z"),
        settlementDate: new Date("2026-11-02T15:00:04Z"),
        amount: money("USD", 100n),
        instructed: { amount: money("CAD", 137n), rate },
        debtor: { ...party, id: "a" },
        creditor: { ...party, id: "b", currency: "USD" },
      });
    expect(build("12345.123456").xml).toContain("<XchgRate>12345.123456</XchgRate>");
    expect(() => build("1234567.123456")).toThrow(/more digits than an ISO 20022 BaseOneRate holds/);
  });
});

describe("securities settlement matching", () => {
  it("matches the seller's delivery to the buyer's receipt the way a settlement system would", () => {
    const xml = (file: string) => fixtures.find(([f]) => f === file)![1].xml;
    const field = (doc: string, tag: string) => doc.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`))?.[1];
    const deliver = xml("5.5-bond-trade/sese.023-seller-deliver.xml");
    const receive = xml("5.5-bond-trade/sese.023-buyer-receive.xml");
    for (const tag of ["CmonId", "Unit", "Amt", "SctiesTxTp", "Id"]) {
      expect(field(deliver, tag), tag).toBe(field(receive, tag));
    }
    expect([field(deliver, "SctiesMvmntTp"), field(receive, "SctiesMvmntTp")]).toEqual(["DELI", "RECE"]);
    expect([field(deliver, "CdtDbtInd"), field(receive, "CdtDbtInd")]).toEqual(["CRDT", "DBIT"]);
    expect(readMessage(deliver).uetrs).toEqual(readMessage(receive).uetrs);
  });
});

describe("XML writing", () => {
  it("escapes what names may contain, and refuses account ids ISO 20022 cannot carry", () => {
    const party = { owner: 'Smith & Sons <"Ltd">', servicer: { id: "bank-a", name: "Bank A" }, currency: "CAD" as const };
    const built = pacs008({
      uetr: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      createdAt: new Date("2026-11-02T15:00:00Z"),
      settlementDate: new Date("2026-11-02T15:00:04Z"),
      amount: money("CAD", 100n),
      debtor: { ...party, id: "a" },
      creditor: { ...party, id: "b" },
    });
    expect(built.xml).toContain("Smith &amp; Sons &lt;&quot;Ltd&quot;&gt;");
    expect(() =>
      pacs008({
        uetr: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
        createdAt: new Date(),
        settlementDate: new Date(),
        amount: money("CAD", 100n),
        debtor: { ...party, id: "x".repeat(35) },
        creditor: { ...party, id: "b" },
      }),
    ).toThrow(/longer than 34/);
  });
});

describe("validation against the official XSDs", () => {
  const hasSchema = (version: string) => existsSync(path.join(SCHEMAS_DIR, `${version}.xsd`));

  it.for(fixtures)("%s is valid", async ([file, built], context) => {
    if (!hasSchema(built.version)) {
      context.skip(`${built.version}.xsd is missing: see schemas/README.md`);
      return;
    }
    const result = await validate(built.xml, built.version);
    expect(result.errors, file).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a message that breaks its schema", async (context) => {
    if (!hasSchema(MESSAGES["pacs.008"])) return context.skip();
    const [, built] = fixtures.find(([file]) => file.endsWith("pacs.008.xml"))!;
    const broken = built.xml.replace("<ChrgBr>SLEV</ChrgBr>", "<ChrgBr>NOPE</ChrgBr>");
    expect((await validate(broken, built.version)).valid).toBe(false);
  });

  it("has every schema the adapter writes", () => {
    const missing = Object.values(MESSAGES).filter((version) => !hasSchema(version));
    expect(missing, "download these into schemas/ (see schemas/README.md)").toEqual([]);
  });
});
