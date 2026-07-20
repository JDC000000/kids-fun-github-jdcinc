// app/admin/qa-queue/_components/DedupReviewForm.tsx — G-T34-6 dedup-pair decision form.
// Client component: two submit buttons share one form; the clicked button's intent
// ('merge' | 'reject_merge') is posted to dedupReviewAction inside a transition. Mirrors
// ReviewForm (G-T34-5) exactly — same note field, same transition/error posture — but for
// the dedup pair: "Confirm merge" runs the real provenance-preserving merge (G-T14-3);
// "Not a duplicate" keeps both records live and separate.
'use client';

import { useRef, useState, useTransition } from 'react';
import { dedupReviewAction, type ReviewActionState } from '../actions';

export function DedupReviewForm({ duplicateId, canonicalId }: { duplicateId: string; canonicalId: string }) {
  const [state, setState] = useState<ReviewActionState>({});
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function submitWith(intent: 'merge' | 'reject_merge') {
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    formData.set('intent', intent);
    startTransition(async () => {
      const result = await dedupReviewAction(formData);
      setState(result ?? {});
    });
  }

  return (
    <form ref={formRef} className="resolve-form" onSubmit={(e) => e.preventDefault()} noValidate>
      <input type="hidden" name="duplicateId" value={duplicateId} />
      <input type="hidden" name="canonicalId" value={canonicalId} />
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="form-grid">
        <label className="field wide">
          <span className="field-label">Reviewer note (optional)</span>
          <textarea
            name="note"
            placeholder="Why merge / why keep separate? Recorded in the audit log."
            aria-invalid={state.noteError ? true : undefined}
          />
          {state.noteError && <span className="field-error">{state.noteError}</span>}
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" disabled={pending} onClick={() => submitWith('merge')}>
          {pending ? 'Working…' : '⇔ Confirm merge'}
        </button>
        <button type="button" className="btn secondary" disabled={pending} onClick={() => submitWith('reject_merge')}>
          {pending ? 'Working…' : '✂ Not a duplicate (keep separate)'}
        </button>
      </div>
    </form>
  );
}
