// app/admin/taxonomy/_components/RegionForm.tsx — G-T34-4 no-code region add/edit form.
// Client component: calls saveRegionAction directly inside a transition (react-dom
// 18.3.1 ships no useFormState), tracks pending + validation state locally. On success
// the action redirects, unmounting this form.
'use client';

import { useState, useTransition } from 'react';
import { saveRegionAction, type RegionActionState } from '../actions';
import { REGION_LEVELS, type RegionFieldErrors } from '../_lib/vocab';
import type { RegionRow } from '../_lib/data';
import { TextField, SelectField, type Option } from './fields';

export function RegionForm({
  mode,
  region,
  parentOptions,
}: {
  mode: 'create' | 'edit';
  region?: RegionRow;
  /** Candidate parent regions (the row being edited is filtered out by the page). */
  parentOptions: Option[];
}) {
  const [state, setState] = useState<RegionActionState>({});
  const [pending, startTransition] = useTransition();
  const errors: RegionFieldErrors = state.fieldErrors ?? {};

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveRegionAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form className="src-form" onSubmit={onSubmit} noValidate>
      {mode === 'edit' && region && <input type="hidden" name="id" value={region.id} />}
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="form-grid">
        <TextField name="name" label="Region name" defaultValue={region?.name} error={errors.name} placeholder="e.g. Burnaby" required />
        <SelectField
          name="level"
          label="Level"
          options={REGION_LEVELS.map((l) => ({ value: l, label: l }))}
          defaultValue={region?.level ?? 'municipality'}
          error={errors.level}
        />
        <SelectField
          name="parentId"
          label="Parent region"
          options={parentOptions}
          defaultValue={region?.parentId ?? ''}
          error={errors.parentId}
          noneLabel="— none (top level) —"
          hint="Sub-areas roll up into their municipality; a metro root has no parent."
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add region'}
        </button>
      </div>
    </form>
  );
}
