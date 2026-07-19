// app/admin/listings/_components/ManualListingForm.tsx — G-T34-3 manual listing-intake
// form. Client component: calls createManualListingAction directly in a transition.
// The field set mirrors StructuredRecord (worker/core/adapter.ts) so a hand-entered
// listing carries the same structured facts an ingested one does.
'use client';

import { useState, useTransition } from 'react';
import { createManualListingAction, type ManualListingActionState } from '../actions';
import { DEFAULT_MANUAL_STATUS_STATE, type ManualListingFieldErrors } from '../_lib/vocab';
import type { SourceOption } from '../_lib/data';

interface ManualListingFormProps {
  sourceOptions: SourceOption[];
  statusOptions: string[];
  confidenceOptions: readonly string[];
  costOptions: readonly string[];
}

export function ManualListingForm({ sourceOptions, statusOptions, confidenceOptions, costOptions }: ManualListingFormProps) {
  const [state, setState] = useState<ManualListingActionState>({});
  const [pending, startTransition] = useTransition();
  const e: ManualListingFieldErrors = state.fieldErrors ?? {};

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await createManualListingAction(formData);
      setState(result ?? {});
    });
  }

  const defaultStatus = statusOptions.includes(DEFAULT_MANUAL_STATUS_STATE) ? DEFAULT_MANUAL_STATUS_STATE : statusOptions[0];

  return (
    <form className="listing-form" onSubmit={onSubmit} noValidate>
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}

      <h3>What &amp; where</h3>
      <div className="form-grid">
        <Text name="title" label="Title" error={e.title} required wide placeholder="e.g. Family Storytime" />
        <Select name="sourceId" label="Source" error={e.sourceId} options={[{ value: '', label: 'Manual Curation (default)' }, ...sourceOptions.map((s) => ({ value: s.id, label: s.label }))]} />
        <Select name="statusState" label="Health state" error={e.statusState} defaultValue={defaultStatus} options={statusOptions.map((v) => ({ value: v, label: v }))} />
        <Select name="confidenceLabel" label="Confidence" error={e.confidenceLabel} defaultValue="unscored" options={confidenceOptions.map((v) => ({ value: v, label: v }))} />
      </div>

      <h3>When</h3>
      <p className="field-hint">
        Give a start date/time (UTC — use a future time so it shows on /search) OR an open-hours description for an
        always-open attraction.
      </p>
      <div className="form-grid">
        <Text name="startDatetimeUtc" label="Start (UTC)" error={e.startDatetimeUtc} type="datetime-local" />
        <Text name="endDatetimeUtc" label="End (UTC, optional)" error={e.endDatetimeUtc} type="datetime-local" />
        <Text name="openHoursState" label="Open hours (instead of a time)" error={e.openHoursState} placeholder="e.g. Daily 9am–5pm" wide />
      </div>

      <h3>Cost</h3>
      <div className="form-grid">
        <Select name="costStatus" label="Cost status" error={e.costStatus} defaultValue="unknown" options={costOptions.map((v) => ({ value: v, label: v }))} />
        <Text name="costMinCad" label="Cost min (CAD)" error={e.costMinCad} type="number" />
        <Text name="costMaxCad" label="Cost max (CAD)" error={e.costMaxCad} type="number" />
      </div>

      <h3>Venue (optional — needed for a distance on /search)</h3>
      <div className="form-grid">
        <Text name="venueName" label="Venue name" error={e.venueName} placeholder="e.g. Central Library" />
        <Text name="venueAddress" label="Address" error={e.venueAddress} />
        <Text name="displayArea" label="Display area" error={e.displayArea} placeholder="e.g. Downtown" />
        <Text name="venueLat" label="Latitude" error={e.venueLat} type="number" placeholder="49.28" />
        <Text name="venueLng" label="Longitude" error={e.venueLng} type="number" placeholder="-123.11" />
      </div>

      <h3>Links &amp; description</h3>
      <div className="form-grid">
        <Text name="sourceUrl" label="Source URL" error={e.sourceUrl} placeholder="https://…" wide />
        <Text name="bookingUrl" label="Booking URL" error={e.bookingUrl} placeholder="https://…" />
        <Text name="locationUrl" label="Location/map URL" error={e.locationUrl} placeholder="https://…" />
        <label className="field wide">
          <span className="field-label">Description snippet</span>
          <textarea name="descriptionSnippet" placeholder="Short factual description (operator-authored)." aria-invalid={e.descriptionSnippet ? true : undefined} />
          {e.descriptionSnippet && <span className="field-error">{e.descriptionSnippet}</span>}
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Creating…' : 'Create listing'}
        </button>
      </div>
    </form>
  );
}

interface Opt {
  value: string;
  label: string;
}

function Text({
  name,
  label,
  error,
  type,
  placeholder,
  required,
  wide,
}: {
  name: string;
  label: string;
  error?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  wide?: boolean;
}) {
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span className="field-label">{label}</span>
      <input
        type={type ?? 'text'}
        name={name}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        {...(type === 'number' ? { step: 'any' } : {})}
        {...(required ? { required: true } : {})}
      />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function Select({
  name,
  label,
  options,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  options: Opt[];
  defaultValue?: string;
  error?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select name={name} defaultValue={defaultValue} aria-invalid={error ? true : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
