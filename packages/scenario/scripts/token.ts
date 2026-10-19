/**
 * Print an operator's sandbox token (SPEC.md §15), to call a service by hand:
 *   pnpm -s operator:token <participant> <operator>
 * The token is derived from public labels: public, and for the sandbox only.
 */
import { operatorToken } from "../src/operators.ts";

const [participant, operator] = process.argv.slice(2);
if (!participant || !operator) {
  console.error("usage: pnpm -s operator:token <participant> <operator>, e.g. bank-a ops-1");
  process.exit(1);
}
console.log(operatorToken(participant, operator));
