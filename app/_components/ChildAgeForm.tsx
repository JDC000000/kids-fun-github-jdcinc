'use client';

// ChildAgeForm — the one age-capture form, used by BOTH the ask-once prompt (a first profile)
// and the header bar's editor (an existing one). Deliberately one component: "add my kids" and
// "change my kids" are the same three controls, and two copies would drift on the first change
// to the caps, the units or the validation — the half that got missed would be the one silently
// dropping a child on write.
//
// WHAT IT CAPTURES, AND WHAT IT REFUSES TO. An age per child, in whole YEARS, and nothing else.
// There is no name field, no birth date, no "anything else we should know" — not because they
// were forgotten but because `ChildEntry` has nowhere to put them, `FORBIDDEN_KEY_RE` refuses to
// persist them, and app/privacy/page.tsx publishes in plain English that we do not collect them
// (design §7 / §9-Q2; Jon 2026-08-19, ages only).
//
// UNITS. Parents think in years; the product stores months (`occurrence_age`'s canonical unit).
// lib/profile/child-age-display.ts is the only place the two meet — this form does no arithmetic
// of its own, so there is no second rounding rule to disagree with the first.
//
// VALIDATION IS NOT THE `<input>`'s JOB. `min`/`max`/`step` on a number input are a hint to a
// browser: they colour a control and gate a native form submit, and they stop nothing that
// arrives by paste, autofill or a non-conforming engine. The submit path re-checks every value
// against the store's own caps (`isStorableAgeYears`), and refuses rather than silently dropping
// a child a parent can see on screen — a form that quietly discards input is how a parent ends
// up with a filter for two children when they entered three.

import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Input } from '@/components/ui';
import { MAX_CHILDREN, type ChildEntry, type ChildInput } from '@/lib/profile/child-profile';
import { MAX_AGE_YEARS, ageMonthsToYears, isStorableAgeYears, yearsToAgeMonths } from '@/lib/profile/child-age-display';
import './child-profile.css';

interface AgeRow {
  /** React key + input id suffix. Local bookkeeping; never stored. */
  key: string;
  /** The stored child's id when this row is an edit, so ids survive a round trip. */
  id?: string;
  /** Raw input text — kept as a string so a half-typed value is not coerced to 0. */
  years: string;
}

export interface ChildAgeFormProps {
  /** Children to pre-fill; empty for the ask-once prompt. */
  initial?: readonly ChildEntry[];
  /** Unique per rendered form, so two forms on one page never share an input id. */
  idPrefix: string;
  submitLabel: string;
  /** Called with the validated children. Never called with an empty list — see `clear`. */
  onSubmit: (children: ChildInput[]) => void;
  /** The caller's own dismiss/erase controls, rendered beside Save at equal weight. */
  children?: ReactNode;
}

function rowsFrom(initial: readonly ChildEntry[]): AgeRow[] {
  if (initial.length === 0) return [{ key: 'r0', years: '' }];
  return initial.map((child, i) => ({
    key: `r${i}`,
    id: child.id,
    years: String(ageMonthsToYears(child.ageMonths)),
  }));
}

export function ChildAgeForm({ initial = [], idPrefix, submitLabel, onSubmit, children }: ChildAgeFormProps) {
  const [rows, setRows] = useState<AgeRow[]>(() => rowsFrom(initial));
  const [error, setError] = useState<string | null>(null);
  // Monotonic, so a removed row's key can never be reused by a later added one (which would let
  // React reconcile a new empty input onto the removed one's DOM node, carrying its value over).
  const nextKey = useRef(rows.length);

  const addRow = () => {
    setRows((current) =>
      current.length >= MAX_CHILDREN ? current : [...current, { key: `r${nextKey.current++}`, years: '' }]
    );
  };

  const removeRow = (key: string) => {
    setRows((current) => (current.length <= 1 ? current : current.filter((row) => row.key !== key)));
    setError(null);
  };

  const setYears = (key: string, years: string) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, years } : row)));
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const filled = rows.filter((row) => row.years.trim() !== '');
    // An unusable value is REFUSED, not dropped: the parent can see what they typed, so a silent
    // skip would leave the form and the stored profile disagreeing about how many children exist.
    if (filled.some((row) => !isStorableAgeYears(Number(row.years)))) {
      setError(`Please enter each age as a whole number of years, from 0 to ${MAX_AGE_YEARS}.`);
      return;
    }
    if (filled.length === 0) {
      setError('Add at least one age.');
      return;
    }
    onSubmit(filled.map((row) => ({ id: row.id, ageMonths: yearsToAgeMonths(Number(row.years)) })));
  };

  return (
    <form className="kf-cprof__form" onSubmit={submit} noValidate>
      <ul className="kf-cprof__rows">
        {rows.map((row, i) => {
          const inputId = `${idPrefix}-age-${row.key}`;
          return (
            <li className="kf-cprof__row" key={row.key}>
              <label className="kf-cprof__row-label" htmlFor={inputId}>
                {rows.length === 1 ? 'Age' : `Age of child ${i + 1}`}
              </label>
              <Input
                id={inputId}
                className="kf-cprof__row-input"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_AGE_YEARS}
                step={1}
                value={row.years}
                placeholder="e.g. 3"
                autoComplete="off"
                onChange={(e) => setYears(row.key, e.target.value)}
              />
              <span className="kf-cprof__row-unit">years</span>
              {rows.length > 1 && (
                <button
                  type="button"
                  className="kf-cprof__btn kf-cprof__btn--muted"
                  onClick={() => removeRow(row.key)}
                  /* The visible "Remove" is ambiguous once there are three of them, and "child 2"
                     is the only handle we have — there is no name to say instead. */
                  aria-label={`Remove child ${i + 1}`}
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {rows.length < MAX_CHILDREN && (
        <button type="button" className="kf-cprof__btn" onClick={addRow}>
          + Add another child
        </button>
      )}

      {/* `role="alert"` rather than a silent red border: the submit did not do what the button
          said it would, and that has to be announced, not just coloured. */}
      {error && (
        <p className="kf-cprof__error" role="alert">
          {error}
        </p>
      )}

      <div className="kf-cprof__actions">
        <Button type="submit" variant="primary">
          {submitLabel}
        </Button>
        {children}
      </div>
    </form>
  );
}
