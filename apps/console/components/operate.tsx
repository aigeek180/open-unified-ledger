import { ActionForm } from "@/components/action-form";
import { moveWholesale, pay, tokenize } from "@/lib/actions";
import type { Network, NetworkParticipant } from "@/lib/services";

/** What a bank's operator starts, in the order the flows build on each other (SPEC.md §5.1–§5.3). */
export function Operate({ bank, network }: { bank: NetworkParticipant; network: Network }) {
  const currency = bank.currency ?? network.scenario.currencies[0]!;
  const reserves = bank.reserves ?? [currency];
  const symbolOf = (code: string) => network.instruments.wholesale.find((w) => w.currency === code)?.symbol ?? `w${code}`;
  const wholesale = reserves.map(symbolOf).join(" or ");
  const dealer = network.fx ? network.participants.find((p) => p.id === network.fx!.dealer) : undefined;
  // A payee in this bank's currency, or, through a dealer that is neither party, in another.
  const others = network.participants.filter(
    (p) => p.kind === "bank" && p.id !== bank.id && (p.currency === currency || (dealer && dealer.id !== bank.id && dealer.id !== p.id)),
  );
  return (
    <section className="panel operate" aria-labelledby="operate">
      <div className="panel-head">
        <h2 id="operate">Operate {bank.name}</h2>
        <p className="panel-note">Sent to {bank.name}'s own service, which books and signs</p>
      </div>

      <details className="op" open>
        <summary>Move reserves into {wholesale}</summary>
        <ActionForm action={moveWholesale.bind(null, bank.id)} participant={bank.id} submit="Send" pendingLabel="Sending…">
          <fieldset className="op-field op-choice">
            <legend>Direction</legend>
            <label>
              <input type="radio" name="direction" value="fund" defaultChecked /> Fund {wholesale} from reserves
            </label>
            <label>
              <input type="radio" name="direction" value="redeem" /> Redeem {wholesale} to reserves
            </label>
          </fieldset>
          {reserves.length > 1 ? (
            <fieldset className="op-field op-choice">
              <legend>Currency</legend>
              {reserves.map((code, index) => (
                <label key={code}>
                  <input type="radio" name="currency" value={code} defaultChecked={index === 0} /> {symbolOf(code)}, at the {code} central bank
                </label>
              ))}
            </fieldset>
          ) : null}
          <Amount currency={reserves.length > 1 ? "" : currency} />
        </ActionForm>
      </details>
      <details className="op">
        <summary>Tokenize a deposit</summary>
        <ActionForm action={tokenize.bind(null, bank.id)} participant={bank.id} submit="Send" pendingLabel="Sending…">
          <label className="op-field">
            <span>Customer</span>
            <select name="customer" required>
              {bank.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="op-field op-choice">
            <legend>Direction</legend>
            <label>
              <input type="radio" name="direction" value="tokenize" defaultChecked /> Deposit to tokens
            </label>
            <label>
              <input type="radio" name="direction" value="detokenize" /> Tokens to deposit
            </label>
          </fieldset>
          <Amount currency={currency} />
        </ActionForm>
      </details>

      <details className="op">
        <summary>Send a payment</summary>
        <ActionForm action={pay.bind(null, bank.id)} participant={bank.id} submit="Send payment" pendingLabel={dealer ? "Asking for the quote and the co-signatures…" : "Asking the payee's bank to co-sign…"}>
          <label className="op-field">
            <span>From</span>
            <select name="payer" required>
              {bank.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="op-field">
            <span>To</span>
            <select name="payee" required>
              {others.map((b) => (
                <optgroup key={b.id} label={b.currency && b.currency !== currency ? `${b.name}, in ${b.currency} at ${dealer?.name}'s quote` : b.name}>
                  {b.customers.map((c) => (
                    <option key={c.id} value={`${b.id}/${c.id}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <Amount currency={currency} />
        </ActionForm>
      </details>

    </section>
  );
}

export function Amount({ currency, name = "amount", label = "Amount" }: { currency: string; name?: string; label?: string }) {
  return (
    <label className="op-field op-amount">
      <span>
        {label} <span className="unit">{currency}</span>
      </span>
      <input name={name} inputMode="decimal" placeholder="2,500.00" required autoComplete="off" pattern="[0-9][0-9,]*(\.[0-9]{1,2})?" />
    </label>
  );
}
