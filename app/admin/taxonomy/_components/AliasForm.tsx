// app/admin/taxonomy/_components/AliasForm.tsx — G-T34-4 no-code alias (synonym_alias)
// add/edit/delete. Client component: posts to saveAliasAction (and, in edit mode,
// deleteAliasAction) inside a transition. An alias maps a free-text parent phrase to
// exactly one canonical category OR tag; the target <select> carries both, value-encoded
// as 'category:<uuid>' / 'tag:<uuid>' (decoded by the shared vocab parser). Saving an
// alias applies at query time immediately — the server action drops the alias-resolver
// cache so the very next live search reflects it (no re-index).
'use client';

import { useState, useTransition } from 'react';
import { saveAliasAction, deleteAliasAction, type AliasActionState } from '../actions';
import { encodeAliasTarget, type AliasFieldErrors } from '../_lib/vocab';
import type { AliasRow } from '../_lib/data';
import { TextField, SelectField, type Option } from './fields';

export function AliasForm({
  mode,
  alias,
  targetOptions,
}: {
  mode: 'create' | 'edit';
  alias?: AliasRow;
  /** Combined category + tag options, value 'category:<uuid>' / 'tag:<uuid>'. */
  targetOptions: Option[];
}) {
  const [state, setState] = useState<AliasActionState>({});
  const [pending, startTransition] = useTransition();
  const errors: AliasFieldErrors = state.fieldErrors ?? {};

  const currentTarget = alias ? encodeAliasTarget({ kind: alias.targetKind, id: alias.targetId }) : '';

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveAliasAction(formData);
      setState(result ?? {});
    });
  }

  function onDelete(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!alias) return;
    const formData = new FormData();
    formData.set('id', alias.id);
    startTransition(async () => {
      const result = await deleteAliasAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form className="src-form" onSubmit={onSubmit} noValidate>
      {mode === 'edit' && alias && <input type="hidden" name="id" value={alias.id} />}
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="form-grid">
        <TextField
          name="aliasText"
          label="Alias phrase"
          defaultValue={alias?.aliasText}
          error={errors.aliasText}
          placeholder="e.g. family drop-in"
          required
          hint="What a parent might type; mapped to a canonical term at search time."
        />
        <SelectField
          name="target"
          label="Maps to (canonical)"
          options={targetOptions}
          defaultValue={currentTarget}
          error={errors.target}
          noneLabel="— choose a category or tag —"
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add alias'}
        </button>
        {mode === 'edit' && alias && (
          <button type="button" className="btn secondary" disabled={pending} onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
