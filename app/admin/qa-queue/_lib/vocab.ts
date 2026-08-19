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

/**
 * The two decisions on a flagged dedup pair (G-T34-6):
 *   • 'merge'        — confirm the duplicate; merge it into the canonical (provenance
 *                      preserved) and archive it (G-T14-3);
 *   • 'reject_merge' — "not a duplicate"; keep BOTH records live & separate (confirm the
 *                      candidate so it leaves the queue). Never archives.
 */
export const DEDUP_INTENTS = ['merge', 'reject_merge'] as const;
export type DedupIntent = (typeof DEDUP_INTENTS)[number];

export function isDedupIntent(v: string | undefined): v is DedupIntent {
  return typeof v === 'string' && (DEDUP_INTENTS as readonly string[]).includes(v);
}

export const MAX_REVIEW_NOTE = 1000;

// ── Paging ──────────────────────────────────────────────────────────────────────────────
// The queue was a single un-paged read with a hard `limit = 100`, ordered oldest-first. That
// is not a "show the first 100" cap — it is a REACHABILITY cap: every row past the 100th was
// invisible to the console, with nothing on screen saying so, and the rows it hid were always
// the most recently flagged ones. Measured against production 2026-08-19: 2590 occurrences in
// a review state, so 2490 of them (96%) could not be reached by any means. (The finding that
// opened this measured 134/34 on 2026-08-18 — the hidden fraction grows with the catalogue,
// which is exactly why raising the number is not the fix.) 100 is now a PAGE size.

/** Rows per page of the review queue. */
export const REVIEW_QUEUE_PAGE_SIZE = 100;

/** Ceiling on a caller-supplied page size — bounds the cost of one render. */
export const MAX_REVIEW_QUEUE_PAGE_SIZE = 500;

/**
 * Ceiling on the 1-based page number. Only a bound on the arithmetic (page → OFFSET must stay
 * inside int4, since the query casts it), never a limit on what is reachable: the queue would
 * need >5,000,000 rows for the last page to reach it.
 */
export const MAX_REVIEW_QUEUE_PAGE = 100_000;

/**
 * Parse the 1-based `?page=` param. Absent / non-integer / out of range → page 1, because a
 * malformed page number should show the reviewer the queue, not an error. Pure.
 */
export function parseQueuePageParam(raw: string | string[] | undefined): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = (first ?? '').trim();
  if (trimmed === '') return 1;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, MAX_REVIEW_QUEUE_PAGE);
}

export type ReviewNoteResult = { ok: true; note: string | null } | { ok: false; error: string };

/** Validate the optional reviewer note. Pure. */
export function parseReviewNote(raw: string | undefined): ReviewNoteResult {
  const note = (raw ?? '').trim();
  if (note.length > MAX_REVIEW_NOTE) return { ok: false, error: `Keep the note under ${MAX_REVIEW_NOTE} characters.` };
  return { ok: true, note: note.length > 0 ? note : null };
}
