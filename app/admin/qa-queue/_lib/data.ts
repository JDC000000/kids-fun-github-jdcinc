// app/admin/qa-queue/_lib/data.ts — G-T34-5 QA review-queue DB model. SERVER-ONLY (pg
// service pool). Lists occurrences awaiting human judgement (status_state in
// needs_review / manual_candidate, not archived) and applies one terminal action:
//   • confirm → status_state = 'confirmed'   (the record is now trusted/visible)
//   • reject  → archived_at   = now()         (soft-delete; drops out of every read model)
// Each action runs in ONE transaction with its admin_audit_log row (the Round-19
// withAdminTransaction + writeAdminAudit helpers, reused verbatim) so the state flip and
// its audit trail commit or roll back together — no un-audited admin change.
//
// The record's state is re-checked under a FOR UPDATE lock inside the transaction, so two
// admins acting on the same queue row can't double-apply: the second sees it already
// handled and no-ops.
import type { PoolClient } from 'pg';
import { query } from '@/lib/db/client';
import { writeAdminAudit, withAdminTransaction } from '@/lib/admin/audit';
import { REVIEW_STATES, type ReviewIntent } from './vocab';

/** QA-queue audit verbs (local to this stream — admin_audit_log.action is free-text;
 *  keeps the change within the taxonomy/qa-queue scope boundary, not the shared audit set). */
export const QA_AUDIT_ACTIONS = {
  CONFIRM: 'qa.confirm',
  REJECT: 'qa.reject',
} as const;

export interface ReviewItem {
  id: string;
  activityName: string;
  seriesTitle: string;
  sourceName: string;
  statusState: string;
  confidenceLabel: string;
  descriptionSnippet: string | null;
  startDatetimeUtc: string | null;
  openHoursState: string | null;
  sourceUrl: string | null;
  createdAt: string;
}
interface ReviewItemDbRow {
  id: string;
  activity_name: string;
  series_title: string;
  source_name: string;
  status_state: string;
  confidence_label: string;
  description_snippet: string | null;
  start_datetime_utc: Date | string | null;
  open_hours_state: string | null;
  source_url: string | null;
  created_at: Date | string;
}
function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * The QA review queue — occurrences in a review state, not archived, oldest first
 * (FIFO triage), joined to series + source for the reviewing context. The status_state
 * predicate is parameterised from REVIEW_STATES (single source of truth with the UI/vocab).
 */
export async function listReviewQueue(limit = 100): Promise<ReviewItem[]> {
  const rows = await query<ReviewItemDbRow>(
    `SELECT o.id, o.activity_name, o.status_state::text AS status_state, o.confidence_label,
            o.description_snippet, o.start_datetime_utc, o.open_hours_state, o.source_url, o.created_at,
            ser.canonical_title AS series_title,
            s.name AS source_name
       FROM activity_occurrence o
       JOIN activity_series ser ON ser.id = o.series_id
       JOIN source s ON s.id = ser.source_id
      WHERE o.archived_at IS NULL
        AND o.status_state = ANY($1::status_state[])
      ORDER BY o.created_at ASC
      LIMIT $2::int`,
    [REVIEW_STATES as unknown as string[], limit]
  );
  return rows.map((r) => ({
    id: r.id,
    activityName: r.activity_name,
    seriesTitle: r.series_title,
    sourceName: r.source_name,
    statusState: r.status_state,
    confidenceLabel: r.confidence_label,
    descriptionSnippet: r.description_snippet,
    startDatetimeUtc: iso(r.start_datetime_utc),
    openHoursState: r.open_hours_state,
    sourceUrl: r.source_url,
    createdAt: iso(r.created_at)!,
  }));
}

interface ReviewSnapshot {
  statusState: string;
  archived: boolean;
}
export type ReviewResult =
  | { ok: true; intent: ReviewIntent; occurrenceId: string; before: ReviewSnapshot; after: ReviewSnapshot & { note: string | null } }
  | { ok: false; reason: 'not_found' | 'already_handled' };

/**
 * Apply a terminal QA action to one occurrence. In a single transaction:
 *   1. lock + read the occurrence (skip if missing),
 *   2. bail as `already_handled` if it is archived OR no longer in a review state
 *      (another admin already confirmed/rejected it — the queue row is stale),
 *   3. confirm → status_state='confirmed'; reject → archived_at=now(); both bump
 *      last_checked_at,
 *   4. write the admin_audit_log row (before/after + reviewer note).
 * The underlying record genuinely changes state (verified by the DB round-trip test) —
 * this is not a UI-only label flip.
 */
export async function reviewOccurrence(
  occurrenceId: string,
  intent: ReviewIntent,
  note: string | null,
  adminUserId: string
): Promise<ReviewResult> {
  return withAdminTransaction(async (client: PoolClient) => {
    const cur = await client.query<{ status_state: string; archived_at: Date | string | null }>(
      `SELECT status_state::text AS status_state, archived_at
         FROM activity_occurrence WHERE id = $1 FOR UPDATE`,
      [occurrenceId]
    );
    if (!cur.rows[0]) return { ok: false, reason: 'not_found' } as const;

    const beforeState = cur.rows[0].status_state;
    const wasArchived = cur.rows[0].archived_at != null;
    const inReviewState = (REVIEW_STATES as readonly string[]).includes(beforeState);
    if (wasArchived || !inReviewState) return { ok: false, reason: 'already_handled' } as const;

    if (intent === 'confirm') {
      await client.query(
        `UPDATE activity_occurrence SET status_state = 'confirmed', last_checked_at = now() WHERE id = $1`,
        [occurrenceId]
      );
    } else {
      await client.query(
        `UPDATE activity_occurrence SET archived_at = now(), last_checked_at = now() WHERE id = $1`,
        [occurrenceId]
      );
    }

    const before: ReviewSnapshot = { statusState: beforeState, archived: false };
    const after = {
      statusState: intent === 'confirm' ? 'confirmed' : beforeState,
      archived: intent === 'reject',
      note,
    };
    await writeAdminAudit(
      {
        adminUserId,
        action: intent === 'confirm' ? QA_AUDIT_ACTIONS.CONFIRM : QA_AUDIT_ACTIONS.REJECT,
        targetTable: 'activity_occurrence',
        targetId: occurrenceId,
        before,
        after,
      },
      client
    );

    return { ok: true, intent, occurrenceId, before, after } as const;
  });
}
