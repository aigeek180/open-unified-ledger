/**
 * Deliberate defects, for the conformance kit's broken engines only
 * (SPEC.md §14): each is a small change to this runtime that breaks one
 * invariant, so the kit can be shown to catch it. The real engine runs with
 * none, and nothing outside the kit ever sets one.
 *
 *   - `book-refused`: when the engine refuses an instruction, post its
 *     pending entry as if it had settled, instead of voiding it (books equal
 *     the ledger);
 *   - `round-fx-twice`: price a quote's target amount by rounding twice, to
 *     a tenth of the minor unit and then to the unit, instead of once (FX
 *     consistency); every party, and its reconciler, prices the same way;
 *   - `split-legs`: send an instruction one leg per transaction, through the
 *     broken SplitLegsEngine's `settleLeg` (atomicity);
 *   - `repo-interest-360`: compute a repo's interest over a 360-day year
 *     instead of 365 (repo collateral); every party, and its reconciler,
 *     computes the same way.
 */
export type Defect = "book-refused" | "round-fx-twice" | "split-legs" | "repo-interest-360";
