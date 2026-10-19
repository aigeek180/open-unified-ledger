"use client";

/** A select that submits its form as soon as another operator is chosen. */
export function ChooseOperator({ name, value, options }: { name: string; value: string; options: { id: string; label: string }[] }) {
  return (
    <label className="op-field">
      <span className="visually-hidden">Operator</span>
      <select key={value} name={name} defaultValue={value} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
