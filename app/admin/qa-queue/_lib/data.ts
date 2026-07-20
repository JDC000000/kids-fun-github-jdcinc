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
import { mergeOccurrencesTx } from '@/lib/llm/dedup-merge';
import { REVIEW_STATES, type ReviewIntent } from './vocab';

/** QA-queue audit verbs (local to this stream — admin_audit_log.action is free-text;
 *  keeps the change within the taxonomy/qa-queue scope boundary, not the shared audit set). */
export const QA_AUDIT_ACTIONS = {
  CONFIRM: 'qa.confirm',
  REJECT: 'qa.reject',
  /** G-T34-6: a human CONFIRMED a flagged dedup pair — the duplicate was merged into the
   *  canonical (provenance preserved via G-T14-3), then archived. */
  DEDUP_MERGE: 'dedup.merge',
  /** G-T34-6: a human REJECTED a flagged dedup pair — "not a duplicate": both records stay
   *  live & separate; the candidate is confirmed (removed from the queue), never archived. */
  DEDUP_REJECT: 'dedup.reject_merge',
} as const;

/**
 * When a queued `manual_candidate` row was surfaced by the dedup adjudicator's
 * `route_to_review` (G-T14-2), this carries the OTHER side of the pair — the suspected
 * surviving canonical — plus the "why" from the recorded llm_batch_decision. Lets the QA
 * queue render a dedup-aware side-by-side review (G-T34-6) instead of the generic single
 * record. `canonicalAvailable` is false if that canonical has since been archived/removed,
 * in which case a merge is no longer offered (fall back to the generic review).
 */
export interface DedupPairing {
  canonicalId: string;
  canonicalName: string | null;
  canonicalSeriesTitle: string | null;
  canonicalSourceName: string | null;
  canonicalStartDatetimeUtc: string | null;
  canonicalOpenHoursState: string | null;
  canonicalSourceUrl: string | null;
  canonicalConfidenceLabel: string | null;
  canonicalAvailable: boolean;
  reason: string | null;
  deterministicScore: number | null;
  llmConfidence: number | null;
  decidedAt: string;
}

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
  /** Present only when this row is a flagged dedup candidate (else null). */
  dedup: DedupPairing | null;
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
  // dedup pairing (null unless a route_to_review decision exists for this row)
  dedup_canonical_id: string | null;
  dedup_reason: string | null;
  deterministic_score: number | null;
  llm_confidence: number | null;
  dedup_decided_at: Date | string | null;
  canon_name: string | null;
  canon_series_title: string | null;
  canon_source_name: string | null;
  canon_status_state: string | null;
  canon_archived_at: Date | string | null;
  canon_start_datetime_utc: Date | string | null;
  canon_open_hours_state: string | null;
  canon_source_url: string | null;
  canon_confidence_label: string | null;
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
            s.name AS source_name,
            -- dedup pairing: the LATEST route_to_review decision for this row (if any) +
            -- the suspected canonical it points at. LEFT joins → null for non-dedup rows.
            d.related_id AS dedup_canonical_id,
            d.detail->>'reason' AS dedup_reason,
            d.deterministic_score, d.llm_confidence, d.created_at AS dedup_decided_at,
            co.activity_name AS canon_name, co.status_state::text AS canon_status_state,
            co.archived_at AS canon_archived_at, co.start_datetime_utc AS canon_start_datetime_utc,
            co.open_hours_state AS canon_open_hours_state, co.source_url AS canon_source_url,
            co.confidence_label AS canon_confidence_label,
            cser.canonical_title AS canon_series_title, cs.name AS canon_source_name
       FROM activity_occurrence o
       JOIN activity_series ser ON ser.id = o.series_id
       JOIN source s ON s.id = ser.source_id
       LEFT JOIN LATERAL (
         SELECT related_id, deterministic_score, llm_confidence, detail, created_at
           FROM llm_batch_decision
          WHERE target_id = o.id AND use_case = 'dedup' AND action = 'route_to_review'
          ORDER BY created_at DESC
          LIMIT 1
       ) d ON true
       LEFT JOIN activity_occurrence co ON co.id = d.related_id
       LEFT JOIN activity_series cser ON cser.id = co.series_id
       LEFT JOIN source cs ON cs.id = cser.source_id
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
    dedup: r.dedup_canonical_id
      ? {
          canonicalId: r.dedup_canonical_id,
          canonicalName: r.canon_name,
          canonicalSeriesTitle: r.canon_series_title,
          canonicalSourceName: r.canon_source_name,
          canonicalStartDatetimeUtc: iso(r.canon_start_datetime_utc),
          canonicalOpenHoursState: r.canon_open_hours_state,
          canonicalSourceUrl: r.canon_source_url,
          canonicalConfidenceLabel: r.canon_confidence_label,
          // Merge is only offered when the canonical still exists AND is live.
          canonicalAvailable: r.canon_name != null && r.canon_archived_at == null,
          reason: r.dedup_reason,
          deterministicScore: r.deterministic_score,
          llmConfidence: r.llm_confidence,
          decidedAt: iso(r.dedup_decided_at)!,
        }
      : null,
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

// ── G-T34-6: dedup-pair review (confirm merge / reject = keep separate) ─────────────────

export type DedupMergeResult =
  | { ok: true; duplicateId: string; canonicalId: string; provenanceMoved: number }
  | { ok: false; reason: 'not_a_pair' | 'already_handled' | 'canonical_unavailable' };

/**
 * Human-confirmed dedup MERGE (G-T34-6 → G-T14-3). In ONE admin transaction:
 *   1. verify the pair is a real recorded route_to_review dedup decision — defense in depth
 *      so a forged POST can't merge an arbitrary pair;
 *   2. best-effort pre-check that the duplicate is still a live manual_candidate (a friendly
 *      "already handled" rather than a surprise);
 *   3. run the provenance-preserving {@link mergeOccurrencesTx} (its canonical-lock +
 *      duplicate-claim are the AUTHORITATIVE guard against a concurrent double-merge — same
 *      lock order as the nightly auto-merge, so the two callers never invert locks);
 *   4. write the admin_audit_log row (only on a real merge).
 * Nothing is mutated on the non-merge branches, so the caller can safely tell the admin to
 * reload. The merge archives the duplicate — irreversible — hence the layered guards.
 */
export async function confirmDedupMerge(
  duplicateId: string,
  canonicalId: string,
  note: string | null,
  adminUserId: string
): Promise<DedupMergeResult> {
  return withAdminTransaction(async (client: PoolClient) => {
    const link = await client.query(
      `SELECT 1 FROM llm_batch_decision
        WHERE target_id = $1 AND related_id = $2 AND use_case = 'dedup' AND action = 'route_to_review'
        LIMIT 1`,
      [duplicateId, canonicalId]
    );
    if ((link.rowCount ?? 0) === 0) return { ok: false, reason: 'not_a_pair' } as const;

    const dup = await client.query<{ status_state: string; archived_at: Date | string | null }>(
      `SELECT status_state::text AS status_state, archived_at FROM activity_occurrence WHERE id = $1`,
      [duplicateId]
    );
    if (!dup.rows[0]) return { ok: false, reason: 'already_handled' } as const;
    if (dup.rows[0].archived_at != null || dup.rows[0].status_state !== 'manual_candidate') {
      return { ok: false, reason: 'already_handled' } as const;
    }

    const outcome = await mergeOccurrencesTx(client, canonicalId, duplicateId);
    if (outcome.status !== 'merged') {
      // duplicate_already_archived → someone merged/archived it first (reload);
      // canonical_archived / canonical_not_found → the survivor is gone (reload).
      return {
        ok: false,
        reason: outcome.status === 'duplicate_already_archived' ? 'already_handled' : 'canonical_unavailable',
      } as const;
    }

    await writeAdminAudit(
      {
        adminUserId,
        action: QA_AUDIT_ACTIONS.DEDUP_MERGE,
        targetTable: 'activity_occurrence',
        targetId: duplicateId,
        before: { statusState: 'manual_candidate', archived: false },
        after: { archived: true, mergedInto: canonicalId, provenanceMoved: outcome.provenanceMoved, note },
      },
      client
    );

    return { ok: true, duplicateId, canonicalId, provenanceMoved: outcome.provenanceMoved } as const;
  });
}

export type DedupRejectResult = { ok: true; duplicateId: string } | { ok: false; reason: 'already_handled' };

/**
 * Human-confirmed dedup REJECT — "not a duplicate" (G-T34-6). Keeps BOTH records live and
 * separate; the flagged candidate is CONFIRMED (a trusted, distinct listing) so it leaves
 * the queue — a real, audited decision, never a silent drop or an archive. In one admin
 * transaction: lock + re-check the row is still a live manual_candidate (else already
 * handled), flip status_state → 'confirmed', write the audit row.
 */
export async function rejectDedupPair(duplicateId: string, note: string | null, adminUserId: string): Promise<DedupRejectResult> {
  return withAdminTransaction(async (client: PoolClient) => {
    const cur = await client.query<{ status_state: string; archived_at: Date | string | null }>(
      `SELECT status_state::text AS status_state, archived_at FROM activity_occurrence WHERE id = $1 FOR UPDATE`,
      [duplicateId]
    );
    if (!cur.rows[0]) return { ok: false, reason: 'already_handled' } as const;
    if (cur.rows[0].archived_at != null || cur.rows[0].status_state !== 'manual_candidate') {
      return { ok: false, reason: 'already_handled' } as const;
    }

    await client.query(
      `UPDATE activity_occurrence SET status_state = 'confirmed', last_checked_at = now() WHERE id = $1`,
      [duplicateId]
    );
    await writeAdminAudit(
      {
        adminUserId,
        action: QA_AUDIT_ACTIONS.DEDUP_REJECT,
        targetTable: 'activity_occurrence',
        targetId: duplicateId,
        before: { statusState: 'manual_candidate', archived: false },
        after: { statusState: 'confirmed', archived: false, note },
      },
      client
    );

    return { ok: true, duplicateId } as const;
  });
}
