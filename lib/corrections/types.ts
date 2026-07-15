// lib/corrections/types.ts — typed contract for the "Report wrong info" corrections
// flow (Task 39 / G4 corrections-API). Shared by the request validator (validate.ts),
// the server write helper (report.ts), the POST /api/corrections route, and the
// browser helper (client.ts). Rows land in the EXISTING `correction_report` table
// (supabase/migrations/0006_provenance_ops.sql):
//   id · occurrence_id (FK→activity_occurrence, NOT NULL) · reporter · issue_type
//   (NOT NULL) · note · status (open|in_review|resolved) · created_at · resolved_at ·
//   archived_at (soft-delete).
// The table already fits a correction report — no migration is added by this task.

/** Loose UUID shape check (mirrors lib/db/session.ts / lib/analytics/types.ts) —
 *  used to guard the occurrence_id foreign key before an insert is attempted. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Known correction issue types. The "Report wrong info" button sends the default;
 *  the small known set leaves room for a future category picker without a schema
 *  change (issue_type is a free-text column, but we constrain it at the edge). */
export type CorrectionIssueType =
  | 'wrong_info'
  | 'wrong_time'
  | 'wrong_price'
  | 'wrong_location'
  | 'cancelled'
  | 'other';

export const KNOWN_ISSUE_TYPES: readonly CorrectionIssueType[] = [
  'wrong_info',
  'wrong_time',
  'wrong_price',
  'wrong_location',
  'cancelled',
  'other',
];

/** What the single "Report wrong info" affordance reports when no category is chosen. */
export const DEFAULT_ISSUE_TYPE: CorrectionIssueType = 'wrong_info';

/** Whole-request payload cap — a sanity ceiling against abuse (matches the analytics route). */
export const MAX_CORRECTION_PAYLOAD_BYTES = 8 * 1024; // 8 KB

/** Free-text note cap — a correction is a sentence or two, not an essay. */
export const MAX_NOTE_LENGTH = 1000;

/**
 * A validated correction ready to persist. `occurrenceId` is a well-formed UUID (the
 * FK target); `reporter` is set server-side from the anon session id — never trusted
 * from the client.
 */
export interface CorrectionReportWrite {
  occurrenceId: string;
  issueType: CorrectionIssueType;
  note: string | null;
  reporter?: string | null;
}
