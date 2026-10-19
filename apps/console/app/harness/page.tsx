import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Live } from "@/components/live";
import { checkRun, injectFault, runFlows } from "@/lib/actions";
import { block, count, time } from "@/lib/format";
import { attempt, type HarnessCheck, harnessUrl, readHarness, readNetwork } from "@/lib/services";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Harness · Open Unified Ledger" };

/** Each fault of SPEC.md §9: what it does, and what must hold through it. */
const FAULTS: Record<string, { title: string; does: string; holds: string }> = {
  "validator-down": {
    title: "Stop a validator",
    does: "One bank's Besu node stops while two flows settle among the other banks, then restarts.",
    holds: "QBFT keeps committing with three validators of four; the node resyncs and its bank catches up.",
  },
  "service-crash": {
    title: "Kill a service mid-payment",
    does: "The payer's or payee's service is killed with SIGKILL the moment a payment is accepted, then restarted.",
    holds: "The payment settles exactly once.",
  },
  "listener-behind": {
    title: "Leave a participant behind",
    does: "A service, often the central bank's, stops while three flows settle, then restarts.",
    holds: "It catches up block by block and reconciles at the head.",
  },
  "duplicate-submission": {
    title: "Submit a payment three times",
    does: "The same payment is requested three times at once, then resubmitted on chain after it settled.",
    holds: "One instruction settles; the resubmission is refused with AlreadySettled.",
  },
  "stale-signature": {
    title: "Submit a stale signature",
    does: "An instruction goes to the engine with an approval for other legs, and another past its deadline.",
    holds: "The engine refuses them: InvalidApproval and InstructionExpired.",
  },
  "frozen-counterparty": {
    title: "Freeze the payer's tokens",
    does: "A bank freezes its customer's tokens on chain behind its own books, then the customer pays.",
    holds: "The engine refuses; the payer voids its entry with a pacs.002 RJCT; the payee's side expires.",
  },
};

export default async function HarnessPage() {
  const status = await attempt(readHarness());
  if (!status.ok) {
    const network = await attempt(readNetwork());
    const scenario = network.ok ? network.value.scenario.id : "ca-interbank";
    return (
      <article className="harness">
        <header className="ledger-head">
          <div>
            <p className="eyebrow">Simulation harness</p>
            <h1>Harness</h1>
          </div>
        </header>
        <section className="offline">
          <p>
            No harness is serving at <code>{harnessUrl}</code>. Started in serve mode, it deploys the scenario afresh,
            runs every participant's service, checks every block against the invariants, and takes flows and faults
            from this page:
          </p>
          <pre>{`pnpm sim ${scenario} --serve`}</pre>
          <p>Stop any services you started yourself first: the harness runs its own on the same ports.</p>
        </section>
      </article>
    );
  }

  const s = status.value;
  const busy = s.busy !== null;
  const verdict = s.ok ? "Every invariant held" : "Invariant broken";
  return (
    <article className="harness">
      <header className="ledger-head">
        <div>
          <p className="eyebrow">
            Simulation harness · {s.scenario.name} · seed {s.seed}
          </p>
          <h1>Harness</h1>
        </div>
        <div className="ledger-head-side">
          <span className={`seal ${s.ok ? "seal-ok" : "seal-break"}`}>
            <span className="seal-word">{verdict}</span>
            <span className="seal-block">
              {s.blocksChecked} blocks checked through block {block(s.checkedThrough)} · {s.checksRun} checks
            </span>
          </span>
          <Live />
        </div>
      </header>

      {s.failures.length > 0 ? (
        <section className="panel failures" aria-labelledby="failures">
          <h2 id="failures">What failed</h2>
          <ul className="checks-list">
            {s.failures.map((f, index) => (
              <Check key={index} check={f} />
            ))}
          </ul>
        </section>
      ) : null}

      <p className={`harness-now ${busy ? "is-busy" : ""}`} aria-live="polite">
        {busy ? (
          <>
            Running <strong>{s.busy!.label}</strong> since {time(s.busy!.since, "UTC")} UTC. Everything waits for it.
          </>
        ) : (
          <>
            Idle. {count(s.counts.settled, "flow", "flows")} settled, {count(s.counts.refused, "overspend", "overspends")} refused,{" "}
            {count(s.counts.faults, "fault", "faults")} survived.
          </>
        )}
      </p>

      <div className="ledger-grid">
        <div className="ledger-books">
          <section className="panel" aria-labelledby="faults">
            <div className="panel-head">
              <h2 id="faults">Inject a fault</h2>
              <p className="panel-note">The per-block checks run underneath every one</p>
            </div>
            <ul className="fault-list">
              {s.faults.map((kind) => {
                const f = FAULTS[kind] ?? { title: kind, does: "", holds: "" };
                return (
                  <li key={kind} className="fault">
                    <div>
                      <h3>{f.title}</h3>
                      <p>{f.does}</p>
                      <p className="fault-holds">{f.holds}</p>
                    </div>
                    <ActionForm
                      action={injectFault.bind(null, kind)}
                      participant=""
                      submit={busy ? "Busy" : "Inject"}
                      pendingLabel="Starting…"
                      className="fault-form"
                      disabled={busy}
                    >
                      {null}
                    </ActionForm>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel" aria-labelledby="flows">
            <div className="panel-head">
              <h2 id="flows">Run flows</h2>
              <p className="panel-note">Seeded random funding, tokenizing and payments, some for more than the payer holds</p>
            </div>
            <ActionForm action={runFlows} participant="" submit={busy ? "Busy" : "Run"} pendingLabel="Starting…" disabled={busy}>
              <label className="op-field">
                <span>Flows</span>
                <select name="count" defaultValue="10">
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                </select>
              </label>
              <label className="op-field">
                <span>Faults mixed in</span>
                <select name="faults" defaultValue="0">
                  <option value="0">none</option>
                  <option value="0.1">one in ten</option>
                  <option value="0.25">one in four</option>
                </select>
              </label>
            </ActionForm>
          </section>

          <section className="panel" aria-labelledby="whole-run">
            <div className="panel-head">
              <h2 id="whole-run">Check the whole run</h2>
              <p className="panel-note">
                {s.lastGlobal?.at ? `Last checked ${time(s.lastGlobal.at, "UTC")} UTC` : "Exactly once, atomicity, authority and more, over every block so far"}
              </p>
            </div>
            <ActionForm action={checkRun} participant="" submit={busy ? "Busy" : "Check now"} pendingLabel="Starting…" disabled={busy}>
              {null}
            </ActionForm>
            {s.lastGlobal ? (
              <ul className="checks-list">
                {s.lastGlobal.checks.map((c, index) => (
                  <Check key={index} check={c} />
                ))}
              </ul>
            ) : null}
          </section>
        </div>

        <section className="panel instructions" aria-labelledby="steps">
          <div className="panel-head">
            <h2 id="steps">Steps</h2>
            <p className="panel-note">Newest first · from block {block(s.deployment.startBlock)}</p>
          </div>
          {s.steps.length === 0 ? (
            <p className="empty">Nothing yet. Run some flows first: most faults need balances to act on.</p>
          ) : (
            <ol className="steps">
              {s.steps.map((step) => (
                <li key={step.n} className={`step is-${step.kind} ${step.ok ? "" : "is-failed"} ${step.skipped ? "is-skipped" : ""}`}>
                  <span className="step-n">{step.n}</span>
                  <span className="step-what">
                    <span className="step-label">{step.kind === "fault" ? step.label.replace(/^FAULT /, "Fault: ") : step.label}</span>
                    <span className="step-outcome">{step.outcome}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </article>
  );
}

function Check({ check }: { check: HarnessCheck }) {
  return (
    <li className={check.ok ? "check-ok" : "check-failed"}>
      <span className="check-inv">{check.invariant === "-" ? "" : `inv ${check.invariant}`}</span>
      <span>
        {check.what}
        {check.detail ? <span className="check-detail">: {check.detail}</span> : null}
      </span>
    </li>
  );
}
