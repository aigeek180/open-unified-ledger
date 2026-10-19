import { contracts } from "@oul/chain";
import type { Defect } from "@oul/participant";
import type { Abi, Hex } from "viem";
import type { CheckName } from "../checks.ts";

/**
 * The deliberately broken engines of SPEC.md §14, each a small change to
 * this sandbox's own: a contract deployed in place of the real one
 * (contracts/src/broken), a defect in the participant runtime
 * (packages/participant/src/defects.ts), or both. The kit must fail each on
 * the check named for it, in the scenario given, and pass the real engine.
 */
export interface BrokenEngine {
  readonly name: BrokenEngineName;
  /** The check the kit must fail it on. */
  readonly check: CheckName;
  /** What is broken, in a phrase. */
  readonly breaks: string;
  /** A scenario where its break can show. */
  readonly scenario: string;
  readonly replace?: { readonly engine?: { abi: Abi; bytecode: Hex }; readonly deposit?: { abi: Abi; bytecode: Hex } };
  readonly defects?: readonly Defect[];
}

export type BrokenEngineName = "split-legs" | "no-once" | "lax-mint" | "open-deposit" | "book-refused" | "round-fx-twice" | "repo-interest-360";

const as = (c: { abi: unknown; bytecode: string }) => ({ abi: c.abi as Abi, bytecode: c.bytecode as Hex });

export const BROKEN_ENGINES: readonly BrokenEngine[] = [
  {
    name: "split-legs",
    check: "atomicity",
    breaks: "legs settled in separate transactions",
    scenario: "ca-interbank",
    replace: { engine: as(contracts.SplitLegsEngine) },
    defects: ["split-legs"],
  },
  { name: "no-once", check: "exactly-once", breaks: "no once-only check on the instruction id", scenario: "ca-interbank", replace: { engine: as(contracts.NoOnceEngine) } },
  { name: "lax-mint", check: "authority", breaks: "a mint accepted without the issuer's approval", scenario: "ca-interbank", replace: { engine: as(contracts.LaxMintEngine) } },
  { name: "open-deposit", check: "eligibility", breaks: "a transfer to an address the token does not allow", scenario: "ca-interbank", replace: { deposit: as(contracts.OpenDepositToken) } },
  { name: "book-refused", check: "books-equal-ledger", breaks: "a payment booked when the chain refused it", scenario: "ca-interbank", defects: ["book-refused"] },
  { name: "round-fx-twice", check: "fx-consistency", breaks: "an FX leg rounded twice", scenario: "ca-us-pvp", defects: ["round-fx-twice"] },
  { name: "repo-interest-360", check: "repo-collateral", breaks: "repo interest over a 360-day year", scenario: "ca-repo", defects: ["repo-interest-360"] },
];

export function brokenEngine(name: string): BrokenEngine {
  const engine = BROKEN_ENGINES.find((b) => b.name === name);
  if (!engine) throw new RangeError(`No broken engine "${name}": ${BROKEN_ENGINES.map((b) => b.name).join(", ")}`);
  return engine;
}
