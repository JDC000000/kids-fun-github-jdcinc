// worker/health/stale.ts — G-T15-4: OCCURRENCE-level stale detection (TSD §7.2, §5A.3).
// A past-cadence occurrence flips status_state → 'stale', which (per
// lib/search/filters/status.ts + lib/search/rank.ts) keeps it shown but ranks it lowest
// (0.15) — i.e. de-prioritised and dropped out of the "confirmed" high-actionability band —
// and makes it countable for the data-health surface.
//
// Reconciliation with lib/admin/dashboard.ts isSourceStale: that predicate is SOURCE-level
// and READ-ONLY (it decides whether to LIST a whole source as stale on the admin dashboard).
// This module is OCCURRENCE-level and MUTATING (it flips individual occurrence rows so the
// public search surface actually demotes them). They are complementary granularities, not a
// fork — and they share the same threshold shape (grace × effective cadence) with the same
// grace (STALE_CADENCE_GRACE = 2: one missed cycle tolerated, two = stale). See findings doc.
import type { Pool } from 'pg';

/** Grace × cadence before an occurrence is stale. 2 = one missed refresh tolerated (could be
 *  transient), two missed = stale. Matches lib/admin/dashboard.ts STALE_CADENCE_GRACE. */
export const STALE_CADENCE_GRACE = 2;

/** Fallback cadence when a source has none configured. Mirrors lib/admin DEFAULT_CADENCE_SECONDS. */
export const DEFAULT_CADENCE_SECONDS = 24 * 60 * 60;

/**
 * status_states an occurrence may be demoted FROM by staleness — the "fresh/live" states
 * that currently present as actionable/confirmed in search. Excludes states that are already
 * low/hidden or human/terminal (stale, cancelled, suspended, postponed, full, waitlist,
 * manual_candidate, needs_review, seasonal_preseason, seasonal_out_of_season) so staleness
 * never overwrites a more specific decision.
 */
export const STALE_DEMOTE_FROM: readonly string[] = [
  'confirmed',
  'bookable_open',
  'not_yet_bookable',
  'schedule_not_published',
  'inferred_recurring',
  'seasonal_active',
];

/**
 * Pure staleness predicate for one occurrence: stale iff it was last refreshed longer than
 * grace × its effective cadence ago. A never-checked occurrence (null last_checked_at) is not
 * stale (no freshness signal yet). Exported so the flip logic is unit-testable without a DB.
 */
export function isOccurrenceStale(
  input: { lastCheckedAtMs: number | null; cadenceSeconds: number | null },
  nowMs: number,
  grace: number = STALE_CADENCE_GRACE
): boolean {
  if (input.lastCheckedAtMs == null) return false;
  const cadence =
    input.cadenceSeconds != null && input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
  return nowMs - input.lastCheckedAtMs > cadence * 1000 * grace;
}

export interface StaleFlipResult {
  /** Occurrence ids flipped to 'stale' this run. */
  flipped: string[];
  count: number;
}

/**
 * Flip every past-cadence, live-status, non-archived occurrence to status_state='stale'.
 * Effective cadence is the owning source's COALESCE(near_date_cadence, baseline_cadence);
 * freshness is the occurrence's own last_checked_at (stamped by worker/core/upsert.ts on
 * every ingest). Threshold and eligible-status set match isOccurrenceStale / STALE_DEMOTE_FROM
 * so the DB behaviour and the pure predicate agree. Returns the ids it changed.
 */
export async function flipStaleOccurrences(
  pool: Pool,
  opts: { grace?: number } = {}
): Promise<StaleFlipResult> {
  const grace = opts.grace ?? STALE_CADENCE_GRACE;
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE activity_occurrence o
        SET status_state = 'stale'
       FROM activity_series ser
       JOIN source s ON s.id = ser.source_id
      WHERE o.series_id = ser.id
        AND o.archived_at IS NULL
        AND o.last_checked_at IS NOT NULL
        AND o.status_state::text = ANY($1::text[])
        AND o.last_checked_at < now() - make_interval(
              secs => COALESCE(extract(epoch FROM COALESCE(s.near_date_cadence, s.baseline_cadence)), $2::float8) * $3::float8
            )
      RETURNING o.id`,
    [STALE_DEMOTE_FROM, DEFAULT_CADENCE_SECONDS, grace]
  );
  return { flipped: rows.map((r) => r.id), count: rows.length };
}

export interface StaleOccurrenceCount {
  /** How many non-archived occurrences are currently in the 'stale' status. */
  staleCount: number;
}

/**
 * Read-only count of occurrences currently flagged stale — the number a data-health surface
 * would show. Complements lib/admin/dashboard.ts's source-level staleness list (which counts
 * whole sources, not occurrences). Kept read-only so it's safe to call from the Next app.
 */
export async function countStaleOccurrences(pool: Pool): Promise<StaleOccurrenceCount> {
  const { rows } = await pool.query<{ stale_count: number }>(
    `SELECT count(*)::int AS stale_count
       FROM activity_occurrence
      WHERE archived_at IS NULL AND status_state = 'stale'`
  );
  return { staleCount: rows[0]?.stale_count ?? 0 };
}
