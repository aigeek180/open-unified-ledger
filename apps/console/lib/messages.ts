import type { MessageRef } from "./services";

/**
 * Where an ISO 20022 message sits beside the instruction it documents: the
 * legs on the shared ledger, the entries in this participant's books, or
 * the outcome. The names are the services' own (SPEC.md §8).
 */
export type Place = "ledger" | "books" | "outcome";

export function placeOf(m: MessageRef): Place {
  if (m.type === "camt.054") return "books";
  if (m.type === "pacs.002") return "outcome";
  return "ledger";
}

/** Which kind of leg a ledger message documents. */
export function legKindOf(m: MessageRef): "deposit" | "wholesale" | "bond" | null {
  if (m.type === "pacs.008") return "deposit";
  if (m.type === "pacs.009") return "wholesale";
  if (m.type.startsWith("sese.")) return "bond";
  return null;
}

const BASE: Record<string, string> = {
  "pacs.008": "Customer credit transfer",
  "pacs.009-cover": "Cover for the wholesale leg",
  "pacs.002": "Payment status report",
  "sese.023-deliver": "Deliver against payment",
  "sese.023-receive": "Receive against payment",
  "sese.025-deliver": "Delivery confirmed",
  "sese.025-receive": "Receipt confirmed",
};

const NOTIFICATION: Record<string, string> = {
  "payer-debit": "Payer's account debited",
  "payee-credit": "Payee's account credited",
  "settlement-debit": "Settlement account debited",
  "settlement-credit": "Settlement account credited",
  "wholesale-credit": "Wholesale line credited",
  "wholesale-debit": "Wholesale line debited",
  "deposit-debit": "Deposit debited",
  "deposit-credit": "Deposit credited",
  "tokenized-credit": "Tokenized deposit credited",
  "tokenized-debit": "Tokenized deposit debited",
  "issuer-credit": "Issuer's deposit credited",
  "issuer-debit": "Issuer's deposit debited",
};

/** A message's name in words, with the participant it is for when the name carries one. */
export function labelOf(m: MessageRef, nameOf: (id: string) => string): string {
  if (BASE[m.name]) return BASE[m.name]!;
  for (const prefix of ["sese.023-deliver-", "sese.023-receive-", "sese.025-deliver-", "sese.025-receive-"]) {
    if (m.name.startsWith(prefix)) return `${BASE[prefix.slice(0, -1)]}, ${nameOf(m.name.slice(prefix.length))}`;
  }
  // Across currencies, a cover for each currency's wholesale leg.
  if (m.name.startsWith("pacs.009-cover-")) return `Cover for the ${m.name.slice("pacs.009-cover-".length)} wholesale leg`;
  if (m.name.startsWith("camt.054-holder-credit-")) {
    return `Holder credited: ${nameOf(m.name.slice("camt.054-holder-credit-".length))}`;
  }
  if (m.name.startsWith("camt.054-")) return NOTIFICATION[m.name.slice("camt.054-".length)] ?? m.name;
  return m.name;
}

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The XML as HTML with tags and values told apart. Everything is escaped
 * first; only the spans added here are markup.
 */
export function highlightXml(xml: string): string {
  return escape(xml).replace(
    /(&lt;\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)(\s*\/?&gt;)/g,
    (_all, open: string, tag: string, attrs: string, close: string) =>
      `<span class="x-tag">${open}${tag}</span>${attrs.replace(/([\w:.-]+)="([^"]*)"/g, '<span class="x-attr">$1</span>="<span class="x-val">$2</span>"')}<span class="x-tag">${close}</span>`,
  );
}
