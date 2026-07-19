// app/admin/taxonomy/_components/fields.tsx — small presentational form-field helpers
// shared by the three taxonomy forms (Region/Category/Alias). Client-safe: pure markup
// over the shared ADMIN_CONSOLE_CSS classes; no state, no DB. Kept local to this stream.
'use client';

import type { ReactNode } from 'react';

export function TextField({
  name,
  label,
  defaultValue,
  error,
  placeholder,
  required,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  error?: string;
  placeholder?: string;
  required?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        name={name}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        {...(required ? { required: true } : {})}
      />
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  error,
  noneLabel,
  hint,
}: {
  name: string;
  label: string;
  options: readonly Option[];
  defaultValue?: string;
  error?: string;
  /** When set, prepends a blank "— none —"-style option with this label (value=""). */
  noneLabel?: string;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select name={name} defaultValue={defaultValue ?? ''} aria-invalid={error ? true : undefined}>
        {noneLabel !== undefined && <option value="">{noneLabel}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function CheckboxField({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <input type="checkbox" name={name} defaultChecked={defaultChecked} value="true" style={{ width: 'auto' }} />
      <span className="field-label" style={{ fontWeight: 400 }}>
        {label}
        {hint && <span className="field-hint"> — {hint}</span>}
      </span>
    </label>
  );
}
