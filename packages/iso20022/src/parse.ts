import { XMLParser } from "fast-xml-parser";

/**
 * Read back what matters about a message: its version, its identifier, and
 * every UETR it names, so a message can be matched to its settlement
 * instruction on the shared ledger (and an instruction to its messages).
 */
export interface MessageInfo {
  readonly version: string;
  readonly root: string;
  readonly msgId: string | undefined;
  readonly uetrs: readonly string[];
  /** Every amount in the message, with its element name and currency. */
  readonly amounts: readonly { element: string; currency: string; value: string }[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false });

export function readMessage(xml: string): MessageInfo {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const documentNode = parsed["Document"] as Record<string, unknown> | undefined;
  if (!documentNode) throw new Error("Not an ISO 20022 message: no Document element");
  const ns = String(documentNode["@xmlns"] ?? "");
  const version = ns.replace("urn:iso:std:iso:20022:tech:xsd:", "");
  const root = Object.keys(documentNode).find((k) => !k.startsWith("@"));
  if (!root) throw new Error("Empty Document");

  const uetrs = new Set<string>();
  const amounts: { element: string; currency: string; value: string }[] = [];
  let msgId: string | undefined;
  const walk = (node: unknown, name: string) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, name));
    if (node === null || typeof node !== "object") {
      if (typeof node !== "string") return;
      if (name === "UETR" || name === "OrgnlUETR") uetrs.add(node);
      // Securities messages carry the instruction's UETR as the counterparties' common reference.
      if (name === "CmonId" && /^[0-9a-f]{32}$/.test(node)) {
        uetrs.add(`${node.slice(0, 8)}-${node.slice(8, 12)}-${node.slice(12, 16)}-${node.slice(16, 20)}-${node.slice(20)}`);
      }
      // Payments and cash messages have a MsgId; securities messages identify themselves by transaction id.
      if (msgId === undefined && (name === "MsgId" || name === "TxId" || name === "AcctSvcrTxId")) msgId = node;
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record["@Ccy"] === "string") {
      amounts.push({ element: name, currency: record["@Ccy"], value: String(record["#text"]) });
    }
    for (const [key, value] of Object.entries(record)) if (!key.startsWith("@") && key !== "#text") walk(value, key);
  };
  walk(documentNode[root], root);
  return { version, root, msgId, uetrs: [...uetrs], amounts };
}
