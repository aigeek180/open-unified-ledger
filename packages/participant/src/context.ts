import { contracts, type Deployment, type Network } from "@oul/chain";
import { bankAccounts, centralBankAccounts, type CurrencyCode, parseMoney } from "@oul/domain";
import type { Ledger } from "@oul/ledger";
import { depositOf, type Scenario, wholesaleFor } from "@oul/scenario";
import type { Address, LocalAccount, PublicClient, WalletClient } from "viem";
import type { Defect } from "./defects.ts";
import type { FlowContext } from "./flows.ts";

/** Everything the runtime's loops and operations share for one participant. */
export interface RuntimeContext {
  readonly scenario: Scenario;
  readonly deployment: Deployment;
  readonly network: Network;
  readonly participant: string;
  readonly kind: "central-bank" | "bank";
  /** The currency of this participant's own books: a central bank's currency, a bank's deposits'. */
  readonly currency: CurrencyCode;
  /** The currencies a bank holds reserves in; empty for a central bank. */
  readonly reserves: readonly CurrencyCode[];
  readonly books: Ledger;
  readonly lock: Mutex;
  readonly client: PublicClient;
  /** Its signing key and a wallet over it: replaced when the participant moves to a new key (SPEC.md §15). */
  wallet: WalletClient;
  account: LocalAccount;
  readonly flows: FlowContext;
  readonly log: (message: string) => void;
  /** Tokens whose movements this participant books. */
  readonly watchedTokens: readonly Address[];
  /**
   * The account a token balance mirrors in this participant's books, if any,
   * and what one token unit is worth there: 1 for cash, face for a bond.
   */
  readonly accountFor: (token: Address, holder: Address) => Mirror | undefined;
  /** Watch another omnibus wallet of this custodian: its units of each bond mirror `custody-holdings/<bond>` (§15). */
  readonly watchCustodyWallet: (wallet: Address) => void;
  /** Deliberate defects, set only by the conformance kit's broken engines; empty otherwise. */
  readonly defects: ReadonlySet<Defect>;
}

/**
 * Serializes this participant's ledger writes. Instants in the journal never
 * go backwards, so writes must happen in the order their instants were taken.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export const engineEvents = contracts.SettlementEngine.abi.filter((item) => item.type === "event");
export const tokenEvents = contracts.WholesaleToken.abi.filter((item) => item.type === "event");

export interface Mirror {
  readonly account: string;
  readonly factor: bigint;
}

/**
 * Which on-chain balances mirror which accounts:
 *   - a bank: its balance of each currency's wholesale token it holds reserves
 *     in is `wholesale-reserves/<currency>`; each customer's balance of the
 *     bank's own deposit token is `tokenized-deposits/<customer>`; its units
 *     of each bond, times face, are `bond-holdings/<symbol>`;
 *   - a central bank: the balance of its own wholesale token held by each
 *     bank with reserves in it is `wholesale-outstanding/<bank>`.
 */
export function mirrorMap(scenario: Scenario, deployment: Deployment, participant: string) {
  const lower = (a: string) => a.toLowerCase();
  const map = new Map<string, Mirror>();
  const key = (token: string, holder: string) => `${lower(token)}:${lower(holder)}`;
  const cash = (account: string): Mirror => ({ account, factor: 1n });
  const wholesale = (currency: CurrencyCode) => lower(deployment.tokens[wholesaleFor(scenario, currency).symbol]!.address);
  const self = scenario.participants.find((p) => p.id === participant);

  if (self?.kind === "central-bank") {
    const token = wholesale(self.currency!);
    for (const bank of scenario.participants) {
      if (!bank.reserves.includes(self.currency!)) continue;
      map.set(key(token, deployment.participants[bank.id]!.address), cash(centralBankAccounts.wholesaleLine(bank.id)));
    }
    return { watched: [token as Address], accountFor: (t: Address, h: Address) => map.get(key(t, h)), watchCustodyWallet: () => {} };
  }

  const address = deployment.participants[participant]?.address;
  if (self?.kind !== "bank" || !address) throw new Error(`"${participant}" is not a bank in deployment ${deployment.scenario}`);
  const deposit = lower(deployment.tokens[depositOf(scenario, participant).symbol]!.address);
  const reserves = self.reserves.map((currency) => {
    const token = wholesale(currency);
    map.set(key(token, address), cash(bankAccounts.wholesaleReserves(currency)));
    return token as Address;
  });
  for (const [ref, customer] of Object.entries(deployment.customers)) {
    if (customer.bank !== participant) continue;
    const customerId = ref.slice(participant.length + 1);
    map.set(key(deposit, customer.address), cash(bankAccounts.tokenizedDeposit(customerId)));
  }
  const bonds: Address[] = [];
  for (const spec of scenario.instruments.bonds) {
    const token = deployment.tokens[spec.symbol];
    if (token?.kind !== "bond") continue;
    bonds.push(token.address);
    map.set(key(token.address, address), {
      account: bankAccounts.bondHolding(spec.symbol),
      factor: parseMoney(spec.currency, spec.face).minor,
    });
  }
  // A custodian's omnibus wallets (SPEC.md §15): its clients' units, at face, off its balance sheet.
  const watchCustodyWallet = (wallet: Address) => {
    for (const spec of scenario.instruments.bonds) {
      const token = deployment.tokens[spec.symbol];
      if (token?.kind !== "bond") continue;
      map.set(key(token.address, wallet), { account: bankAccounts.custodyHolding(spec.symbol), factor: parseMoney(spec.currency, spec.face).minor });
    }
  };
  return {
    watched: [...reserves, deposit as Address, ...bonds],
    accountFor: (t: Address, h: Address) => map.get(key(t, h)),
    watchCustodyWallet,
  };
}
