// app/admin/qa-queue/actions.ts — G-T34-5 server action: apply one QA review decision
// (confirm | reject) to a queued occurrence. 'use server'. Gated by resolveSessionAdmin()
// (Round-19 gate, reused) — a write must be attributable in admin_audit_log, re-checked
// here so a direct POST cannot bypass the page gate.
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveSessionAdmin } from '../_lib/gate';
import { bustCatalogueAfterAdminWrite } from '@/lib/search/catalogue-write-bust';
import { isReviewIntent, isDedupIntent, parseReviewNote, parseQueuePageParam } from './_lib/vocab';
import { reviewOccurrence, confirmDedupMerge, rejectDedupPair } from './_lib/data';

export interface ReviewActionState {
  ok?: boolean;
  message?: string;
  /** Field-level message for the optional reviewer note. */
  noteError?: string;
}

/**
 * Where to send the reviewer after a successful decision: back to the queue PAGE they acted
 * from, not page 1. The page arrives as a hidden form field and is re-parsed here rather than
 * trusted — it lands in a redirect URL, and parseQueuePageParam only ever yields a bounded
 * integer, so a forged value cannot smuggle anything into the Location header.
 */
function queueRedirect(formData: FormData, flash: string): string {
  const page = parseQueuePageParam(str(formData.get('page')));
  return page > 1 ? `/admin/qa-queue?page=${page}&flash=${flash}` : `/admin/qa-queue?flash=${flash}`;
}

const NEEDS_SESSION_ADMIN: ReviewActionState = {
  ok: false,
  message:
    'Reviewing a record requires a signed-in admin account. Read-only access cannot make changes.',
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

  await bustCatalogueAfterAdminWrite(`qa.${intent}`);
  revalidatePath('/admin/qa-queue');
  redirect(queueRedirect(formData, intent === 'confirm' ? 'confirmed' : 'rejected'));
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
    await bustCatalogueAfterAdminWrite('qa.dedup_merge');
    revalidatePath('/admin/qa-queue');
    redirect(queueRedirect(formData, 'merged'));
  }

  // reject_merge — keep both records separate.
  // canonicalId is REQUIRED here too, and checked the same way the merge branch checks it.
  // The verdict is pair-scoped, so recording it needs both ids; accepting a blank one would
  // either write an adjudication row with a meaningless second id, or (worse) skip the verdict
  // while still flipping the status — which is silently the exact defect this path closes.
  // No UI change was needed to get it: DedupReviewForm renders the hidden canonicalId at FORM
  // level, above both buttons, so it is already in the POST body for this intent.
  const rejectCanonicalId = str(formData.get('canonicalId'));
  if (!rejectCanonicalId) return { ok: false, message: 'Missing canonical id — reload the queue.' };

  let result;
  try {
    result = await rejectDedupPair(duplicateId, rejectCanonicalId, noteParsed.note, admin.userId);
  } catch {
    return { ok: false, message: 'Could not apply the decision — reload the queue and try again.' };
  }
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === 'not_a_pair'
          ? 'These records are not a flagged duplicate pair — reload the queue.'
          : 'That record was already handled by someone else — reload the queue.',
    };
  }
  await bustCatalogueAfterAdminWrite('qa.dedup_keep_separate');
  revalidatePath('/admin/qa-queue');
  redirect(queueRedirect(formData, 'kept_separate'));
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}
