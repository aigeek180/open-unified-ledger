import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Who sees what, as `pnpm confidential:compare` measured it (SPEC.md §10):
 * the same payment in each mode, and what each observer could actually read.
 * The console draws the file; it runs nothing itself.
 */

const RUNS =
  process.env["OUL_CONFIDENTIAL_RUNS"] ?? path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../sim/runs/confidential");

export type FactKey = "payer" | "payee" | "amount" | "wholesale" | "payerBalance" | "payeeBalance";

export interface Seen {
  visible: boolean;
  value?: string;
  how: string;
}

export interface Observer {
  id: string;
  label: string;
  facts: Record<FactKey, Seen>;
}

export interface ModeReport {
  tx: string;
  block: string;
  observers: Observer[];
}

export interface VisibilityReport {
  scenario: string;
  at: string;
  payment: {
    payerBank: string;
    payer: string;
    payeeBank: string;
    payee: string;
    names?: { payerBank: string; payer: string; payeeBank: string; payee: string };
    amount: string;
    currency: string;
  };
  modes: { plain: ModeReport; confidential: ModeReport };
}

export const confidentialRunsDir = RUNS;

export async function readVisibility(): Promise<VisibilityReport | undefined> {
  try {
    return JSON.parse(await readFile(path.join(/* turbopackIgnore: true */ RUNS, "latest.json"), "utf8")) as VisibilityReport;
  } catch {
    return undefined;
  }
}

export const FACTS: { key: FactKey; label: string }[] = [
  { key: "payer", label: "Who paid" },
  { key: "payee", label: "Who was paid" },
  { key: "amount", label: "How much" },
  { key: "wholesale", label: "Wholesale between banks" },
  { key: "payerBalance", label: "Payer's balance" },
  { key: "payeeBalance", label: "Payee's balance" },
];
