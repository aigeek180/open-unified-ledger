"use client";

import Link from "next/link";
import { type ReactNode, startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/lib/actions";

/**
 * A form that starts something at one participant's service and says, in
 * place, what the service answered: the instruction it accepted, with a
 * link to its timeline, or why it refused.
 */
export function ActionForm({
  action,
  participant,
  submit,
  pendingLabel,
  children,
  className,
  disabled = false,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  participant: string;
  submit: string;
  pendingLabel: string;
  children: ReactNode;
  className?: string;
  /** While something else must finish first; the button says so in `submit`. */
  disabled?: boolean;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  // Clear the fields only once the service accepted; a refusal keeps what was typed, to correct and resend.
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <form
      ref={form}
      className={`op-form ${className ?? ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => dispatch(data));
      }}
    >
      <div className="op-fields">{children}</div>
      <div className="op-submit">
        <button type="submit" disabled={pending || disabled}>
          {pending ? pendingLabel : submit}
        </button>
        <output aria-live="polite" className={state && !state.ok ? "op-result is-error" : "op-result"}>
          {state?.ok ? (
            <>
              {state.message}
              {state.uetr && state.follow ? (
                <>
                  {" · "}
                  <Link href={`/p/${participant}/i/${state.uetr}`}>follow {state.uetr.slice(0, 8)}</Link>
                </>
              ) : state.uetr ? (
                <>
                  {" "}
                  <code>{state.uetr}</code>
                </>
              ) : null}
            </>
          ) : state ? (
            state.error
          ) : null}
        </output>
      </div>
    </form>
  );
}

/**
 * The UETR an affirmation is given under, which the seller or issuing agent
 * then uses: generated here once, editable, and copyable to pass on.
 */
export function UetrField({ name = "uetr", label = "UETR", generate = true }: { name?: string; label?: string; generate?: boolean }) {
  const [value, setValue] = useState(() => (generate ? crypto.randomUUID() : ""));
  const [copied, setCopied] = useState(false);
  return (
    <label className="op-field op-uetr">
      <span>{label}</span>
      <span className="op-uetr-row">
        <input
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value.trim().toLowerCase())}
          placeholder="paste the UETR the buyer affirmed"
          required
          pattern="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
          spellCheck={false}
          autoComplete="off"
        />
        {generate ? (
          <button type="button" className="op-mini" onClick={() => setValue(crypto.randomUUID())}>
            New
          </button>
        ) : null}
        <button
          type="button"
          className="op-mini"
          disabled={!value}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
}
