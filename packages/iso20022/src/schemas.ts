import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateXML } from "xmllint-wasm";

/**
 * The ISO 20022 message definitions this adapter writes, and validation of a
 * message against its official XSD (schemas/, see schemas/README.md).
 *
 * pacs.008, pacs.009 and camt.053 are at the versions Lynx and CBPR+ use;
 * pacs.002 and camt.054 at the versions Payments Canada documents; sese at
 * version 13 (docs/design.md §3.13).
 */
export const MESSAGES = {
  "pacs.008": "pacs.008.001.08",
  "pacs.009": "pacs.009.001.08",
  "pacs.002": "pacs.002.001.10",
  "camt.054": "camt.054.001.08",
  "camt.053": "camt.053.001.08",
  "sese.023": "sese.023.001.13",
  "sese.025": "sese.025.001.13",
} as const;

export type MessageType = keyof typeof MESSAGES;
export type MessageVersion = (typeof MESSAGES)[MessageType];

export const namespace = (version: MessageVersion) => `urn:iso:std:iso:20022:tech:xsd:${version}`;

export const SCHEMAS_DIR = path.resolve(import.meta.dirname, "../schemas");

export class SchemaMissing extends Error {
  override readonly name = "SchemaMissing";
}

async function schema(version: MessageVersion): Promise<string> {
  const file = path.join(SCHEMAS_DIR, `${version}.xsd`);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new SchemaMissing(`${version}.xsd is not in ${SCHEMAS_DIR}; see schemas/README.md for where to get it`);
  }
}

export interface Validation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Validate a message against the official XSD of its version. */
export async function validate(xml: string, version: MessageVersion): Promise<Validation> {
  const result = await validateXML({
    xml: [{ fileName: "message.xml", contents: xml }],
    schema: [{ fileName: `${version}.xsd`, contents: await schema(version) }],
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.rawMessage) };
}
