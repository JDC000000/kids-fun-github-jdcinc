// app/admin/qa-queue/actions.ts — G-T34-5 server action: apply one QA review decision
// (confirm | reject) to a queued occurrence. 'use server'. Gated by resolveSessionAdmin()
// (Round-19 gate, reused) — a write must be attributable in admin_audit_log, so the
// interim token has read-only access; re-checked here so a direct POST can't bypass the
// read gate.
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveSessionAdmin } from '../_lib/gate';
import { isReviewIntent, isDedupIntent, parseReviewNote } from './_lib/vocab';
import { reviewOccurrence, confirmDedupMerge, rejectDedupPair } from './_lib/data';

export interface ReviewActionState {
  ok?: boolean;
  message?: string;
  /** Field-level message for the optional reviewer note. */
  noteError?: string;
}

const NEEDS_SESSION_ADMIN: ReviewActionState = {
  ok: false,
  message:
    'Reviewing a record requires a signed-in admin account. The interim access token is read-only; ask an admin to be seeded, then sign in.',
};

/**
 * Confirm or reject the occurrence identified by the form's `occurrenceId`. The intent
 * comes from the clicked submit button (name="intent" value="confirm"|"reject"). On
 * success: revalidate + redirect with a flash; on failure: return a banner (no navigation).
 */
export async function reviewAction(formData: FormData): Promise<ReviewActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return NEEDS_SESSION_ADMIN;

  const occurrenceId = str(formData.get('occurrenceId'));
  if (!occurrenceId) return { ok: false, message: 'Missing record id — reload the queue.' };

  const intent = str(formData.get('intent'));
  if (!isReviewIntent(intent)) return { ok: false, message: 'Choose Confirm or Reject.' };

  const noteParsed = parseReviewNote(str(formData.get('note')));
  if (!noteParsed.ok) return { ok: false, message: 'Please shorten the note.', noteError: noteParsed.error };

  let result;
  try {
    result = await reviewOccurrence(occurrenceId, intent, noteParsed.note, admin.userId);
  } catch {
    return { ok: false, message: 'Could not apply the review — reload the queue and try again.' };
  }

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === 'already_handled'
          ? 'That record was already reviewed by someone else — reload the queue.'
          : 'That record no longer exists — reload the queue.',
    };
  }

  revalidatePath('/admin/qa-queue');
  redirect(`/admin/qa-queue?flash=${intent === 'confirm' ? 'confirmed' : 'rejected'}`);
}

/**
 * G-T34-6 — apply a dedup-pair decision to a flagged `manual_candidate` row.
 *   • intent 'merge'        → confirmDedupMerge (real G-T14-3 merge: provenance preserved,
 *                             duplicate archived) — needs both duplicateId + canonicalId;
 *   • intent 'reject_merge' → rejectDedupPair ("not a duplicate": both kept live & separate).
 * Same session-admin gate + audit posture as reviewAction (reused, not forked). On success:
 * revalidate + redirect with a flash; on failure: return a banner (no navigation).
 */
export async function dedupReviewAction(formData: FormData): Promise<ReviewActionState> {
  const admin = await resolveSessionAdmin();
  if (!admin) return NEEDS_SESSION_ADMIN;

  const duplicateId = str(formData.get('duplicateId'));
  if (!duplicateId) return { ok: false, message: 'Missing record id — reload the queue.' };

  const intent = str(formData.get('intent'));
  if (!isDedupIntent(intent)) return { ok: false, message: 'Choose Confirm merge or Not a duplicate.' };

  const noteParsed = parseReviewNote(str(formData.get('note')));
  if (!noteParsed.ok) return { ok: false, message: 'Please shorten the note.', noteError: noteParsed.error };

  if (intent === 'merge') {
    const canonicalId = str(formData.get('canonicalId'));
    if (!canonicalId) return { ok: false, message: 'Missing canonical id — reload the queue.' };

    let result;
    try {
      result = await confirmDedupMerge(duplicateId, canonicalId, noteParsed.note, admin.userId);
    } catch {
      return { ok: false, message: 'Could not apply the merge — reload the queue and try again.' };
    }
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === 'not_a_pair'
            ? 'These records are not a flagged duplicate pair — reload the queue.'
            : result.reason === 'canonical_unavailable'
              ? 'The canonical listing is no longer available — reload the queue.'
              : 'That record was already handled by someone else — reload the queue.',
      };
    }
    revalidatePath('/admin/qa-queue');
    redirect('/admin/qa-queue?flash=merged');
  }

  // reject_merge — keep both records separate.
  let result;
  try {
    result = await rejectDedupPair(duplicateId, noteParsed.note, admin.userId);
  } catch {
    return { ok: false, message: 'Could not apply the decision — reload the queue and try again.' };
  }
  if (!result.ok) {
    return { ok: false, message: 'That record was already handled by someone else — reload the queue.' };
  }
  revalidatePath('/admin/qa-queue');
  redirect('/admin/qa-queue?flash=kept_separate');
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}
