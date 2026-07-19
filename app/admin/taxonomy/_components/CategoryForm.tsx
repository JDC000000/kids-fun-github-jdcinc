// app/admin/taxonomy/_components/CategoryForm.tsx — G-T34-4 no-code category add/edit.
// Client component: posts to saveCategoryAction inside a transition. The `key` is what
// live search matches on (aliases expand to a category key), so it is editable but
// slug-validated (lowercase/digits/underscore) by the shared vocab parser.
'use client';

import { useState, useTransition } from 'react';
import { saveCategoryAction, type CategoryActionState } from '../actions';
import type { CategoryFieldErrors } from '../_lib/vocab';
import type { CategoryRow } from '../_lib/data';
import { TextField, CheckboxField } from './fields';

export function CategoryForm({ mode, category }: { mode: 'create' | 'edit'; category?: CategoryRow }) {
  const [state, setState] = useState<CategoryActionState>({});
  const [pending, startTransition] = useTransition();
  const errors: CategoryFieldErrors = state.fieldErrors ?? {};

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveCategoryAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form className="src-form" onSubmit={onSubmit} noValidate>
      {mode === 'edit' && category && <input type="hidden" name="id" value={category.id} />}
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="form-grid">
        <TextField
          name="key"
          label="Key"
          defaultValue={category?.key}
          error={errors.key}
          placeholder="e.g. open_gym"
          required
          hint="Lowercase letters, digits and underscores. Live search matches on this."
        />
        <TextField name="label" label="Label" defaultValue={category?.label} error={errors.label} placeholder="e.g. Open Gym" required />
        <CheckboxField
          name="isPrimaryEligible"
          label="Primary-eligible"
          defaultChecked={category ? category.isPrimaryEligible : true}
          hint="can be a listing's primary category"
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add category'}
        </button>
      </div>
    </form>
  );
}
