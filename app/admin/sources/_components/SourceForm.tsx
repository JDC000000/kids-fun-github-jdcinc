// app/admin/sources/_components/SourceForm.tsx — G-T34-3 no-code add/edit form.
// Client component: calls the saveSourceAction server action directly inside a
// transition (react-dom 18.3.1 does not ship useFormState), tracks pending + returns
// validation state locally. On success the action redirects, unmounting this form.
'use client';

import { useState, useTransition } from 'react';
import { saveSourceAction, type SourceActionState } from '../actions';
import type { SourceRow } from '../_lib/data';
import {
  AUTHORITY_TIERS,
  TERMS_STATUSES,
  ROBOTS_STATUSES,
  HEALTH_STATES,
  INGESTION_METHODS,
  SEASON_STATES,
  CADENCE_OPTIONS,
  type SourceFieldErrors,
} from '../_lib/vocab';

interface SourceFormProps {
  mode: 'create' | 'edit';
  /** The row to pre-fill when editing; omitted for create. */
  source?: SourceRow;
}

export function SourceForm({ mode, source }: SourceFormProps) {
  const [state, setState] = useState<SourceActionState>({});
  const [pending, startTransition] = useTransition();
  const errors: SourceFieldErrors = state.fieldErrors ?? {};

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveSourceAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form className="src-form" onSubmit={onSubmit} noValidate>
      {mode === 'edit' && source && <input type="hidden" name="id" value={source.id} />}

      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}

      <div className="form-grid">
        <TextField name="family" label="Family" defaultValue={source?.family} error={errors.family} placeholder="e.g. manual, activenet" required />
        <TextField name="name" label="Name" defaultValue={source?.name} error={errors.name} placeholder="e.g. Manual Curation" required />
        <SelectField name="authorityTier" label="Authority tier" options={AUTHORITY_TIERS} defaultValue={source?.authorityTier ?? 'manual'} error={errors.authorityTier} />
        <SelectField name="ingestionMethod" label="Ingestion method" options={INGESTION_METHODS} defaultValue={source?.ingestionMethod ?? 'manual'} error={errors.ingestionMethod} />
        <SelectField name="termsStatus" label="Terms status" options={TERMS_STATUSES} defaultValue={source?.termsStatus ?? 'pending'} error={errors.termsStatus} />
        <SelectField name="robotsStatus" label="Robots status" options={ROBOTS_STATUSES} defaultValue={source?.robotsStatus ?? 'pending'} error={errors.robotsStatus} />
        <SelectField name="baselineCadence" label="Baseline cadence" options={CADENCE_OPTIONS} defaultValue={cadenceDefault(source?.baselineCadence, '1 day')} error={errors.baselineCadence} />
        <SelectField name="nearDateCadence" label="Near-date cadence" options={CADENCE_OPTIONS} defaultValue={source?.nearDateCadence ?? ''} error={errors.nearDateCadence} allowNone />
        <SelectField name="seasonState" label="Season state" options={SEASON_STATES} defaultValue={source?.seasonState ?? 'unknown'} error={errors.seasonState} />
        <SelectField name="healthState" label="Health state" options={HEALTH_STATES} defaultValue={source?.healthState ?? 'unknown'} error={errors.healthState} />
        <TextField name="platform" label="Platform (optional)" defaultValue={source?.platform ?? ''} error={errors.platform} placeholder="e.g. bibliocommons" />
      </div>

      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add source'}
        </button>
      </div>
    </form>
  );
}

/** Only keep a stored cadence label if it matches a tier option, else use the fallback. */
function cadenceDefault(value: string | undefined, fallback: string): string {
  return value && (CADENCE_OPTIONS as readonly string[]).includes(value) ? value : fallback;
}

function TextField({
  name,
  label,
  defaultValue,
  error,
  placeholder,
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  error?: string;
  placeholder?: string;
  required?: boolean;
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
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
  error,
  allowNone,
}: {
  name: string;
  label: string;
  options: readonly string[];
  defaultValue?: string;
  error?: string;
  allowNone?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select name={name} defaultValue={defaultValue ?? ''} aria-invalid={error ? true : undefined}>
        {allowNone && <option value="">— none —</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
