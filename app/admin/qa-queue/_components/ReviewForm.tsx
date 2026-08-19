// app/admin/qa-queue/_components/ReviewForm.tsx — G-T34-5 per-record confirm/reject form.
// Client component: posts to reviewAction inside a transition. Two submit buttons share
// one form; the clicked button's name="intent" (confirm|reject) tells the action which
// terminal decision to apply. An optional note is recorded in the audit after_json.
'use client';

import { useRef, useState, useTransition } from 'react';
import { reviewAction, type ReviewActionState } from '../actions';

export function ReviewForm({ occurrenceId, page }: { occurrenceId: string; page: number }) {
  const [state, setState] = useState<ReviewActionState>({});
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function submitWith(intent: 'confirm' | 'reject') {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    formData.set('intent', intent);
    startTransition(async () => {
      const result = await reviewAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form ref={formRef} className="resolve-form" onSubmit={(e) => e.preventDefault()} noValidate>
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      {/* The queue page this row was reviewed from, so the post-action redirect returns here
          instead of dumping the reviewer back on page 1 after every single decision. */}
      <input type="hidden" name="page" value={page} />
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="form-grid">
        <label className="field wide">
          <span className="field-label">Reviewer note (optional)</span>
          <textarea name="note" placeholder="What did you check? Recorded in the audit log." aria-invalid={state.noteError ? true : undefined} />
          {state.noteError && <span className="field-error">{state.noteError}</span>}
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" disabled={pending} onClick={() => submitWith('confirm')}>
          {pending ? 'Working…' : '✓ Confirm'}
        </button>
        <button type="button" className="btn secondary" disabled={pending} onClick={() => submitWith('reject')}>
          {pending ? 'Working…' : '✕ Reject (archive)'}
        </button>
      </div>
    </form>
  );
}
