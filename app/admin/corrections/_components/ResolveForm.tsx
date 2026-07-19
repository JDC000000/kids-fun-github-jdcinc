// app/admin/corrections/_components/ResolveForm.tsx — G-T34-7 per-report resolve form.
// Client component: calls resolveCorrectionAction directly in a transition. Defaults the
// health state + confidence selects to the occurrence's CURRENT values so "resolve
// without changing state" is one click, while still recording a re-check (last_checked_at
// is bumped and the action is audited).
'use client';

import { useState, useTransition } from 'react';
import { resolveCorrectionAction, type ResolveActionState } from '../actions';
import type { ResolveFieldErrors } from '../_lib/vocab';

interface ResolveFormProps {
  reportId: string;
  currentStatusState: string;
  currentConfidenceLabel: string;
  statusOptions: string[];
  confidenceOptions: readonly string[];
}

export function ResolveForm({
  reportId,
  currentStatusState,
  currentConfidenceLabel,
  statusOptions,
  confidenceOptions,
}: ResolveFormProps) {
  const [state, setState] = useState<ResolveActionState>({});
  const [pending, startTransition] = useTransition();
  const errors: ResolveFieldErrors = state.fieldErrors ?? {};

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await resolveCorrectionAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form className="resolve-form" onSubmit={onSubmit} noValidate>
      <input type="hidden" name="reportId" value={reportId} />

      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Set health state</span>
          <select name="statusState" defaultValue={currentStatusState} aria-invalid={errors.statusState ? true : undefined}>
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
                {opt === currentStatusState ? ' (current)' : ''}
              </option>
            ))}
          </select>
          {errors.statusState && <span className="field-error">{errors.statusState}</span>}
        </label>

        <label className="field">
          <span className="field-label">Set confidence</span>
          <select name="confidenceLabel" defaultValue={currentConfidenceLabel} aria-invalid={errors.confidenceLabel ? true : undefined}>
            {confidenceOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
                {opt === currentConfidenceLabel ? ' (current)' : ''}
              </option>
            ))}
          </select>
          {errors.confidenceLabel && <span className="field-error">{errors.confidenceLabel}</span>}
        </label>

        <label className="field wide">
          <span className="field-label">Resolution note (optional)</span>
          <textarea name="resolutionNote" placeholder="What did you check / change? Recorded in the audit log." aria-invalid={errors.resolutionNote ? true : undefined} />
          {errors.resolutionNote && <span className="field-error">{errors.resolutionNote}</span>}
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Resolving…' : 'Resolve report'}
        </button>
      </div>
    </form>
  );
}
