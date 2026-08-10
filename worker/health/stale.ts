// worker/health/stale.ts — G-T15-4: OCCURRENCE-level stale detection (TSD §7.2, §5A.3).
// A past-cadence occurrence WHOSE SOURCE IS AUTO-CRAWLED flips status_state → 'stale', which
// (per lib/search/filters/status.ts + lib/search/rank.ts) keeps it shown but ranks it lowest
// (0.15) — i.e. de-prioritised and dropped out of the "confirmed" high-actionability band —
// and makes it countable for the data-health surface. Occurrences under an OPERATOR-FED
// source are exempt; see STALE_FLIP_EXCLUDED_INGESTION_METHODS below for why.
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
 * source.ingestion_method values the flip must NOT demote — the sources with NO RE-INGEST
 * PATH BACK.
 *
 * WHY THIS EXCLUSION EXISTS, and it is not a special case bolted onto a general rule. The
 * staleness rule is "nothing has re-checked this row lately". For an INGESTED source that
 * is both true and SELF-CORRECTING: worker/core/upsert.ts re-stamps last_checked_at and
 * status_state together on the next successful ingest, so the caveat lifts itself. A source
 * that is never crawled AUTOMATICALLY sits inside the identical rule with nothing routine to
 * lift it, so its
 * occurrences decay to the lowest shown rank ~2 days after a human curated them and STAY
 * there until a human returns (the only writes that restore status_state are a real
 * re-ingest, an admin QA approve, or resolving a correction). The rule was written for
 * ingested listings; this is the clause that says so.
 *
 * WHY `ingestion_method` AND NOT `authority_tier`. Both columns have a 'manual' value and
 * app/admin/listings/_lib/data.ts's getOrCreateManualSource sets BOTH, so on that one row
 * they are indistinguishable — but they answer different questions. `authority_tier` is a
 * TRUST claim about the data and gates no fetching at all; `ingestion_method` is the column
 * that decides whether anything ever fetches the source again AUTOMATICALLY, and it is the
 * exact column worker/scheduler/tiered.ts's candidate predicate uses to refuse to enqueue
 * (`AND s.ingestion_method <> 'manual'`).
 *
 * "AUTOMATICALLY" IS LOAD-BEARING, NOT A HEDGE. worker/src/ingest-once.ts selects a source by
 * --source-id or --family/--name with NO ingestion_method filter, so a human CAN deliberately
 * re-ingest a manual source from the CLI, and that run really does lift the caveat (it reaches
 * worker/core/upsert.ts, which re-stamps last_checked_at and status_state together). What a
 * manual source has no path back from is UNATTENDED recovery — and that is the whole of the
 * problem this exclusion exists for, because the caveat would otherwise be applied by a
 * scheduled job and lifted only by a human who knows to go looking.
 *
 * THE EXCLUSION CANNOT OVER-PROTECT, and this is stronger than counting rows: over-protection
 * would require a source that is 'manual' AND still automatically re-checked. No such source
 * can exist, because ONE COLUMN GATES BOTH — the set excluded here is exactly the set
 * tiered.ts refuses to enqueue. Exempting a source from the caveat therefore cannot strand a
 * source the scheduler would otherwise have kept fresh.
 *
 * SAME SET, SAME MEANING as worker/scheduler/cadence.ts's MANUAL_INGESTION_METHODS — the
 * sources that producer refuses to schedule are exactly the ones this flip must not punish
 * for not having been scheduled. Deliberately NOT imported from there: that module is the
 * scheduler's tier policy and this is a data-health predicate, and coupling them would mean
 * a future scheduling change silently moved which listings get caveated. If the two sets
 * ever need to diverge they can; today they agree, and that agreement is the point.
 *
 * NOTE 'semi' IS NOT HERE, deliberately. Only 'manual' means never-crawled; cadence.ts
 * schedules 'semi', 'auto' and 'partner' alike, so their occurrences do get re-checked and
 * the self-correcting argument above holds for them.
 */
export const STALE_FLIP_EXCLUDED_INGESTION_METHODS: readonly string[] = ['manual'];

/**
 * Pure mirror of the flip's ingestion_method clause: may occurrences under a source with
 * this ingestion_method be demoted by staleness?
 *
 * This function and flipStaleOccurrences()'s SQL cannot drift, because they are not two
 * statements of the same rule — they READ THE SAME ARRAY. The SQL passes
 * STALE_FLIP_EXCLUDED_INGESTION_METHODS as a bind parameter exactly as it already does with
 * STALE_DEMOTE_FROM, so editing the constant moves both at once and editing one without the
 * other is not expressible.
 *
 * `ingestionMethod` is typed non-null because source.ingestion_method is NOT NULL
 * (supabase/migrations/0003_core_places.sql).
 */
export function isStaleFlipEligibleSource(ingestionMethod: string): boolean {
  return !STALE_FLIP_EXCLUDED_INGESTION_METHODS.includes(ingestionMethod);
}

/**
 * Pure staleness predicate for one occurrence: stale iff it was last refreshed longer than
 * grace × its effective cadence ago. A never-checked occurrence (null last_checked_at) is not
 * stale (no freshness signal yet). Exported so the flip logic is unit-testable without a DB.
 *
 * THIS IS THE FRESHNESS CLAUSE ONLY, and deliberately still answers "is this row overdue?"
 * rather than "will the flip touch this row?" — an ancient manual listing IS stale by this
 * measure, and saying otherwise here would make the function's name a lie. Whether the flip
 * may ACT on it is a separate question, answered by isStaleFlipEligibleSource() and
 * STALE_DEMOTE_FROM. The SQL below is the only place all three are composed.
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
 * Flip every past-cadence, live-status, non-archived occurrence UNDER AN AUTO-CRAWLED SOURCE
 * to status_state='stale'.
 * Effective cadence is the owning source's COALESCE(near_date_cadence, baseline_cadence);
 * freshness is the occurrence's own last_checked_at (stamped by worker/core/upsert.ts on
 * every ingest). Threshold, eligible-status set and eligible-source set match
 * isOccurrenceStale / STALE_DEMOTE_FROM / STALE_FLIP_EXCLUDED_INGESTION_METHODS so the DB
 * behaviour and the pure predicates agree — each of the two set clauses is BOUND FROM THE
 * EXPORTED CONSTANT rather than restated as a SQL literal, so they cannot drift apart.
 * Returns the ids it changed.
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
        AND NOT (s.ingestion_method::text = ANY($4::text[]))
        AND o.last_checked_at < now() - make_interval(
              secs => COALESCE(extract(epoch FROM COALESCE(s.near_date_cadence, s.baseline_cadence)), $2::float8) * $3::float8
            )
      RETURNING o.id`,
    [STALE_DEMOTE_FROM, DEFAULT_CADENCE_SECONDS, grace, STALE_FLIP_EXCLUDED_INGESTION_METHODS]
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
