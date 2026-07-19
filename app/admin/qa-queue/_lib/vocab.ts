// app/admin/qa-queue/_lib/vocab.ts — G-T34-5 QA review queue: pure value sets + a tiny
// validator (no DB import → client-safe + unit-testable), mirroring the sources/corrections
// vocab posture.
//
// The queue lists occurrences in the two "awaiting human judgement" states of the
// status_state enum (0002_enums.sql): 'needs_review' (the ingestion default — see
// activity_occurrence.status_state DEFAULT 'needs_review' in 0004_activities.sql) and
// 'manual_candidate' (a lead surfaced for verification). A DB drift test asserts both are
// real enum members so the queue predicate can never reference a value the DB rejects.
export const REVIEW_STATES = ['needs_review', 'manual_candidate'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The two terminal actions an admin can take on a queued record. */
export const REVIEW_INTENTS = ['confirm', 'reject'] as const;
export type ReviewIntent = (typeof REVIEW_INTENTS)[number];

export function isReviewIntent(v: string | undefined): v is ReviewIntent {
  return typeof v === 'string' && (REVIEW_INTENTS as readonly string[]).includes(v);
}

export const MAX_REVIEW_NOTE = 1000;

export type ReviewNoteResult = { ok: true; note: string | null } | { ok: false; error: string };

/** Validate the optional reviewer note. Pure. */
export function parseReviewNote(raw: string | undefined): ReviewNoteResult {
  const note = (raw ?? '').trim();
  if (note.length > MAX_REVIEW_NOTE) return { ok: false, error: `Keep the note under ${MAX_REVIEW_NOTE} characters.` };
  return { ok: true, note: note.length > 0 ? note : null };
}
