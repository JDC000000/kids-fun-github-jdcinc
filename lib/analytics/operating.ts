// lib/analytics/operating.ts — READ-SIDE operating-KPI TIME SERIES (M7 / T41, G-T41-1/2).
//
// The third read-side analytics module, and the one the /admin/operating review
// surface is built on. The split between the three is deliberate and NOT a fork:
//
//   kpi.ts       → ONE current-window snapshot (the /admin/dashboard tiles).
//   trends.ts    → per-DAY DAU/WAU/MAU + volume lines (the /admin/product-health charts).
//   operating.ts → every operating KPI as a PERIOD SERIES at a selectable grain
//                  (day for the daily review, month for the monthly review), so each
//                  KPI can be read as a DIRECTION, not a point-in-time number.
//
// Nothing here re-implements a KPI that already has a canonical definition: the
// ratio maths is imported from kpi.ts (`pct`, `sourceCtrPct`, `zeroResultPct`,
// `signedInSharePct`, `perDay`) so a rate shown on the operating dashboard is
// computed by exactly the same function the snapshot tiles and the benchmark tile
// use. What IS new here is (a) bucketing those same counters by period, and (b) the
// four lifecycle/outcome KPIs the launch scope asks for that had no implementation
// anywhere before: activation, retention, search-success and zero-result recovery.
//
// Same discipline as its two siblings: a pure CONSUMER — every statement is a
// SELECT, nothing mutates, and it imports NOTHING from the analytics write side.
// Safe on an EMPTY table: every bucket returns 0 and every rate returns `null`
// (→ the UI shows an em-dash) rather than a fabricated 0%.
//
// ── HONESTY PROPERTIES BUILT INTO THIS MODULE (they are requirements, not polish) ──
//  1. The newest bucket is ALWAYS incomplete ("today so far" / "this month so far").
//     Comparing an incomplete period against a complete one is the classic dashboard
//     lie, so it is flagged `partial` and EXCLUDED from every trend-direction
//     computation. Direction is always last-complete vs previous-complete.
//  2. A rate over a zero denominator is `null`, never 0% (kpi.ts's `pct` contract).
//  3. A rate over a SMALL but non-zero denominator is still returned, but carries a
//     `lowSample` flag so the UI can mark it as directionally unreliable instead of
//     presenting it with the same authority as a well-powered number. This matters
//     right now: KIDS FUN launched 2026-07-21 and the production dataset is days old.
import { query } from '@/lib/db/client';
import { pct, perDay, signedInSharePct, sourceCtrPct, zeroResultPct } from './kpi';

// ─────────────────────────────────────────────────────────────────────────────
// Grain / window configuration
// ─────────────────────────────────────────────────────────────────────────────

/** The two review cadences the operating dashboard supports (G-T41-2). */
export type OperatingGrain = 'day' | 'month';

/** Buckets shown in the DAILY review (30 days ≈ a month of day-by-day context). */
export const DAILY_REVIEW_PERIODS = 30;
/** Buckets shown in the MONTHLY review (12 months ≈ a year of month-by-month context). */
export const MONTHLY_REVIEW_PERIODS = 12;
/** Hard ceiling on buckets so a caller can never request an unbounded scan. */
export const MAX_PERIODS = 36;

/**
 * How long after a search we still attribute a follow-on engagement (or a recovering
 * re-search) to that search. 30 minutes is a session-shaped window: long enough to
 * cover reading a listing and coming back, short enough that an unrelated visit hours
 * later is not credited to it.
 */
export const SEARCH_OUTCOME_WINDOW_MINUTES = 30;

/**
 * Denominator below which a rate is flagged `lowSample`. Not a statistical test — a
 * blunt, documented threshold whose only job is to stop a 1-of-2 = 50% reading from
 * being presented as if it were 500-of-1000 = 50%.
 */
export const MIN_RATE_SAMPLE = 20;

/**
 * The events that count as a NEW actor reaching product value, for the activation
 * KPI. A search alone is not activation — a parent who searched and never opened a
 * listing did not get what they came for. Opening a real listing, clicking through to
 * the official source, or saving a search all are.
 *
 * ⚠️ PROPOSED definition, not a ratified TSD §12.5 target — the spec names the KPI
 * but does not define its numerator. Stated here, in one place, so the number on the
 * dashboard is auditable and a product decision can move it deliberately.
 */
export const ACTIVATION_EVENT_TYPES = [
  'listing_viewed',
  'outbound_source_click',
  'saved_search_created',
] as const;

/** Postgres interval literal for a grain. */
export function grainInterval(grain: OperatingGrain): string {
  return grain === 'month' ? '1 month' : '1 day';
}

/** Default bucket count for a grain. */
export function defaultPeriods(grain: OperatingGrain): number {
  return grain === 'month' ? MONTHLY_REVIEW_PERIODS : DAILY_REVIEW_PERIODS;
}

/** Coerce an arbitrary caller value into a safe bucket count for the grain. */
export function clampPeriods(periods: number | undefined, grain: OperatingGrain): number {
  if (!Number.isFinite(periods)) return defaultPeriods(grain);
  return Math.min(MAX_PERIODS, Math.max(2, Math.trunc(periods as number)));
}

/** Parse a `?view=` search param into a grain; anything unrecognised → 'day'. */
export function parseGrain(raw: string | string[] | undefined): OperatingGrain {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'month' || value === 'monthly' ? 'month' : 'day';
}

/** Display label for a bucket: 'YYYY-MM-DD' for days, 'YYYY-MM' for months. */
export function periodLabel(periodStart: string, grain: OperatingGrain): string {
  return grain === 'month' ? periodStart.slice(0, 7) : periodStart;
}

/** Exclusive end of a bucket, as an epoch-ms UTC instant. */
export function periodEndMs(periodStart: string, grain: OperatingGrain): number {
  const [year, month, day] = periodStart.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return Number.NaN;
  return grain === 'month' ? Date.UTC(year, month, 1) : Date.UTC(year, month - 1, (day ?? 1) + 1);
}

/**
 * Whether a bucket ended BEFORE the product had any recorded history at all.
 *
 * This is the difference between "we measured zero" and "there was nothing to
 * measure", and getting it wrong is a real, load-bearing lie on a dashboard read
 * days after launch: a monthly review that compares July against a June in which the
 * product did not yet exist would report "MAU 0, steady" — flat, unremarkable, and
 * completely wrong. Pre-history buckets therefore carry `null` (→ em-dash, direction
 * 'unknown'), not 0.
 *
 * Crucially this is NOT the same as "the bucket has no events". A day AFTER launch on
 * which nobody visited is a genuine, measured zero and must keep reading 0 — that is
 * precisely the traffic-cliff signal the daily review exists to catch, and suppressing
 * it would hide an outage. Only buckets that closed before the very first event are
 * suppressed.
 *
 * When there is no recorded history at all (`firstEventAtMs == null`), nothing is
 * suppressed: with no anchor we cannot claim a period predates anything, so the
 * honest reading is the raw zeros.
 */
export function isPreHistory(
  periodStart: string,
  grain: OperatingGrain,
  firstEventAtMs: number | null
): boolean {
  if (firstEventAtMs == null || !Number.isFinite(firstEventAtMs)) return false;
  const end = periodEndMs(periodStart, grain);
  return Number.isFinite(end) && end <= firstEventAtMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw per-period counters
// ─────────────────────────────────────────────────────────────────────────────

/** Every raw counter the operating KPI set derives from, for ONE period bucket. */
export interface OperatingPeriodCounts {
  /** Bucket start, 'YYYY-MM-DD' (UTC). Stable key. */
  period: string;
  /** Display label for the axis: 'YYYY-MM-DD' (day) or 'YYYY-MM' (month). */
  label: string;
  /** True for the newest bucket — the period is still in progress, so it is never
   *  used as a trend endpoint. */
  partial: boolean;

  // volume + reach
  events: number;
  activeActors: number;

  // search funnel
  searches: number;
  /** search_performed rows carrying a result `total` (the rate denominator). */
  searchesWithResults: number;
  zeroResultSearches: number;
  /** searchesWithResults − zeroResultSearches. */
  nonEmptySearches: number;
  /** Searches the engine broadened to recover a thin/empty result set. */
  broadenedSearches: number;
  /** Searches with a usable actor id — the denominator for outcome-proxy rates. */
  attributableSearches: number;
  /** …of those, ones followed by a same-actor listing view / source click. */
  engagedSearches: number;
  /** Zero-result searches with a usable actor id (recovery-rate denominator). */
  attributableZeroResultSearches: number;
  /** …of those, ones followed by a same-actor search that DID return results. */
  recoveredZeroResultSearches: number;

  // engagement + account value
  listingViews: number;
  outboundClicks: number;
  savedSearches: number;
  emailOptIns: number;
  signInEvents: number;
  signedInActors: number;

  // lifecycle
  /** Actors whose first-ever event falls in this period. */
  newActors: number;
  /** …of those, ones that reached an ACTIVATION_EVENT_TYPES moment in the period. */
  activatedNewActors: number;
  /** Actors active in this period that were seen before it. */
  returningActors: number;
  /** Actors active in the PREVIOUS period (the retention denominator). */
  priorActors: number;
  /** …of those, ones active again in THIS period (the retention numerator). */
  retainedActors: number;
}

interface EngagementRow {
  period_start: string;
  events: number;
  active_actors: number;
  searches: number;
  searches_with_results: number;
  zero_result_searches: number;
  broadened_searches: number;
  attributable_searches: number;
  engaged_searches: number;
  attributable_zero_result_searches: number;
  recovered_zero_result_searches: number;
  listing_views: number;
  outbound_clicks: number;
  saved_searches: number;
  sign_in_events: number;
  signed_in_actors: number;
}

interface LifecycleRow {
  period_start: string;
  new_actors: number;
  activated_new_actors: number;
  returning_actors: number;
  prior_actors: number;
  retained_actors: number;
}

/**
 * Shared bucket generator. `$1` = grain name for date_trunc, `$2` = the interval
 * literal, `$3` = bucket count. Emitted as a CTE prefix by both queries below so the
 * two result sets are keyed to byte-identical bucket boundaries and can be zipped.
 */
const PERIODS_CTE = `
  periods AS (
    SELECT gs AS pstart
    FROM generate_series(
      date_trunc($1::text, now()) - (($3::int - 1) * $2::interval),
      date_trunc($1::text, now()),
      $2::interval
    ) AS gs
  )`;

/**
 * Per-period engagement/search/account counters.
 *
 * The per-event outcome flags (`engaged`, `recovered`) are computed in an `ev` CTE
 * rather than inside an aggregate FILTER — a correlated sub-select is not portable
 * inside FILTER, and pre-computing once per row is also cheaper than re-evaluating
 * it per aggregate. The CTE is bounded to the plotted window, so the scan never
 * covers the whole table.
 *
 * The outcome look-ahead deliberately crosses the bucket boundary: a search is
 * attributed to the period it happened in, and we then look forward in real time for
 * its outcome. One honest consequence: searches in the last
 * SEARCH_OUTCOME_WINDOW_MINUTES of the newest bucket have not had their full chance
 * to convert yet, so the in-progress period's success/recovery rates read slightly
 * low. That period is flagged `partial` and excluded from trend direction for exactly
 * this class of reason.
 */
async function getEngagementSeries(grain: OperatingGrain, periods: number): Promise<EngagementRow[]> {
  return query<EngagementRow>(
    `
    WITH ${PERIODS_CTE},
    bounds AS (
      SELECT min(pstart) AS lo, max(pstart) + $2::interval AS hi FROM periods
    ),
    ev AS (
      SELECT
        e.id,
        e.created_at,
        e.event_type,
        (e.user_or_session IS NOT NULL AND e.user_or_session <> '') AS has_actor,
        e.user_or_session,
        (e.result_summary_json ? 'total')                          AS has_total,
        ((e.result_summary_json ->> 'total') = '0')                AS zero_result,
        ((e.result_summary_json ->> 'broadened') = 'true')         AS broadened,
        (
          e.event_type = 'search_performed'
          AND e.user_or_session IS NOT NULL AND e.user_or_session <> ''
          AND EXISTS (
            SELECT 1 FROM analytics_event f
            WHERE f.user_or_session = e.user_or_session
              AND f.event_type IN ('listing_viewed', 'outbound_source_click')
              AND f.created_at >  e.created_at
              AND f.created_at <= e.created_at + ($4::int * interval '1 minute')
          )
        ) AS engaged,
        (
          e.event_type = 'search_performed'
          AND e.user_or_session IS NOT NULL AND e.user_or_session <> ''
          AND EXISTS (
            SELECT 1 FROM analytics_event r
            WHERE r.user_or_session = e.user_or_session
              AND r.event_type = 'search_performed'
              AND r.created_at >  e.created_at
              AND r.created_at <= e.created_at + ($4::int * interval '1 minute')
              AND r.result_summary_json ? 'total'
              AND (r.result_summary_json ->> 'total') <> '0'
          )
        ) AS recovered
      FROM analytics_event e, bounds b
      WHERE e.created_at >= b.lo AND e.created_at < b.hi
    )
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD') AS period_start,
      count(e.id)::int AS events,
      count(DISTINCT e.user_or_session) FILTER (WHERE e.has_actor)::int AS active_actors,
      count(e.id) FILTER (WHERE e.event_type = 'search_performed')::int AS searches,
      count(e.id) FILTER (WHERE e.event_type = 'search_performed' AND e.has_total)::int
        AS searches_with_results,
      count(e.id) FILTER (WHERE e.event_type = 'search_performed' AND e.has_total AND e.zero_result)::int
        AS zero_result_searches,
      count(e.id) FILTER (WHERE e.event_type = 'search_performed' AND e.broadened)::int
        AS broadened_searches,
      count(e.id) FILTER (WHERE e.event_type = 'search_performed' AND e.has_actor)::int
        AS attributable_searches,
      count(e.id) FILTER (WHERE e.engaged)::int AS engaged_searches,
      count(e.id) FILTER (
        WHERE e.event_type = 'search_performed' AND e.has_total AND e.zero_result AND e.has_actor
      )::int AS attributable_zero_result_searches,
      count(e.id) FILTER (WHERE e.recovered AND e.has_total AND e.zero_result)::int
        AS recovered_zero_result_searches,
      count(e.id) FILTER (WHERE e.event_type = 'listing_viewed')::int AS listing_views,
      count(e.id) FILTER (WHERE e.event_type = 'outbound_source_click')::int AS outbound_clicks,
      count(e.id) FILTER (WHERE e.event_type = 'saved_search_created')::int AS saved_searches,
      count(e.id) FILTER (WHERE e.event_type = 'account_signed_in')::int AS sign_in_events,
      count(DISTINCT e.user_or_session) FILTER (
        WHERE e.event_type = 'account_signed_in' AND e.has_actor
      )::int AS signed_in_actors
    FROM periods p
    LEFT JOIN ev e ON e.created_at >= p.pstart AND e.created_at < p.pstart + $2::interval
    GROUP BY p.pstart
    ORDER BY p.pstart
    `,
    [grain, grainInterval(grain), periods, SEARCH_OUTCOME_WINDOW_MINUTES]
  );
}

/**
 * Per-period actor lifecycle: new / activated / returning / retained.
 *
 * `actor_first` is a whole-table min() per actor — the only way to know whether an
 * actor seen in a bucket had EVER been seen before it. That is a full scan of
 * analytics_event; acceptable at the table's current (and retention-bounded, 13-month)
 * size, and the correct answer rather than an approximation. If the table ever grows
 * past the point where this is comfortable, the fix is a covering index on
 * (user_or_session, created_at) — noted in docs/kpi-cadence.md, not pre-built here.
 */
async function getLifecycleSeries(grain: OperatingGrain, periods: number): Promise<LifecycleRow[]> {
  return query<LifecycleRow>(
    `
    WITH ${PERIODS_CTE},
    actor_first AS (
      SELECT user_or_session AS actor, min(created_at) AS first_at
      FROM analytics_event
      WHERE user_or_session IS NOT NULL AND user_or_session <> ''
      GROUP BY user_or_session
    ),
    active AS (
      SELECT DISTINCT p.pstart, e.user_or_session AS actor
      FROM periods p
      JOIN analytics_event e
        ON e.created_at >= p.pstart AND e.created_at < p.pstart + $2::interval
      WHERE e.user_or_session IS NOT NULL AND e.user_or_session <> ''
    ),
    activated AS (
      SELECT DISTINCT p.pstart, e.user_or_session AS actor
      FROM periods p
      JOIN analytics_event e
        ON e.created_at >= p.pstart AND e.created_at < p.pstart + $2::interval
      WHERE e.user_or_session IS NOT NULL AND e.user_or_session <> ''
        AND e.event_type = ANY($4::text[])
    )
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD') AS period_start,
      count(a.actor) FILTER (WHERE af.first_at >= p.pstart)::int AS new_actors,
      count(a.actor) FILTER (WHERE af.first_at >= p.pstart AND act.actor IS NOT NULL)::int
        AS activated_new_actors,
      count(a.actor) FILTER (WHERE af.first_at < p.pstart)::int AS returning_actors,
      (
        SELECT count(DISTINCT prev.user_or_session)::int
        FROM analytics_event prev
        WHERE prev.user_or_session IS NOT NULL AND prev.user_or_session <> ''
          AND prev.created_at >= p.pstart - $2::interval
          AND prev.created_at <  p.pstart
      ) AS prior_actors,
      (
        SELECT count(DISTINCT prev.user_or_session)::int
        FROM analytics_event prev
        WHERE prev.user_or_session IS NOT NULL AND prev.user_or_session <> ''
          AND prev.created_at >= p.pstart - $2::interval
          AND prev.created_at <  p.pstart
          AND EXISTS (
            SELECT 1 FROM analytics_event cur
            WHERE cur.user_or_session = prev.user_or_session
              AND cur.created_at >= p.pstart
              AND cur.created_at <  p.pstart + $2::interval
          )
      ) AS retained_actors
    FROM periods p
    LEFT JOIN active a    ON a.pstart = p.pstart
    LEFT JOIN actor_first af ON af.actor = a.actor
    LEFT JOIN activated act  ON act.pstart = p.pstart AND act.actor = a.actor
    GROUP BY p.pstart
    ORDER BY p.pstart
    `,
    [grain, grainInterval(grain), periods, [...ACTIVATION_EVENT_TYPES]]
  );
}

/**
 * The weekly-email opt-in counter needs the `optedIn` payload test that kpi.ts's
 * getAccountValue applies, which does not fit the `ev` CTE's flag shape cleanly.
 * Kept as its own small bucketed count so the definition stays byte-identical to the
 * canonical one rather than drifting.
 */
async function getEmailOptInSeries(
  grain: OperatingGrain,
  periods: number
): Promise<{ period_start: string; email_opt_ins: number }[]> {
  return query<{ period_start: string; email_opt_ins: number }>(
    `
    WITH ${PERIODS_CTE}
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD') AS period_start,
      count(e.id)::int AS email_opt_ins
    FROM periods p
    LEFT JOIN analytics_event e
      ON e.created_at >= p.pstart AND e.created_at < p.pstart + $2::interval
     AND e.event_type = 'weekly_email_opt_in'
     AND (e.result_summary_json ->> 'optedIn') = 'true'
    GROUP BY p.pstart
    ORDER BY p.pstart
    `,
    [grain, grainInterval(grain), periods]
  );
}

/** How much real data exists at all — the guard against reading noise as signal. */
export interface DataCoverage {
  /** Timestamp of the oldest surviving analytics_event, or null on an empty table. */
  firstEventAt: string | null;
  /** Whole days between firstEventAt and now. 0 on an empty table. */
  daysOfData: number;
  /** Total surviving analytics_event rows. */
  totalEvents: number;
}

/** Read how far back real analytics data actually goes. Safe on an empty table. */
export async function getDataCoverage(): Promise<DataCoverage> {
  const rows = await query<{ first_event_at: Date | null; total_events: number }>(
    `SELECT min(created_at) AS first_event_at, count(*)::int AS total_events FROM analytics_event`
  );
  const first = rows[0]?.first_event_at ?? null;
  const firstMs = first ? new Date(first).getTime() : null;
  return {
    firstEventAt: firstMs && Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    daysOfData: firstMs && Number.isFinite(firstMs) ? Math.floor((Date.now() - firstMs) / 86_400_000) : 0,
    totalEvents: rows[0]?.total_events ?? 0,
  };
}

/**
 * Fetch and zip every per-period counter for the requested grain. The three reads run
 * concurrently and are merged on the bucket key, which is identical across them
 * because they all use the same PERIODS_CTE.
 */
export async function getOperatingPeriodCounts(
  grain: OperatingGrain,
  periodsRequested?: number
): Promise<OperatingPeriodCounts[]> {
  const periods = clampPeriods(periodsRequested, grain);
  const [engagement, lifecycle, optIns] = await Promise.all([
    getEngagementSeries(grain, periods),
    getLifecycleSeries(grain, periods),
    getEmailOptInSeries(grain, periods),
  ]);

  const lifecycleByPeriod = new Map(lifecycle.map((r) => [r.period_start, r]));
  const optInsByPeriod = new Map(optIns.map((r) => [r.period_start, r.email_opt_ins ?? 0]));
  const lastIndex = engagement.length - 1;

  return engagement.map((row, index) => {
    const life = lifecycleByPeriod.get(row.period_start);
    const searchesWithResults = row.searches_with_results ?? 0;
    const zeroResultSearches = row.zero_result_searches ?? 0;
    return {
      period: row.period_start,
      label: periodLabel(row.period_start, grain),
      partial: index === lastIndex,

      events: row.events ?? 0,
      activeActors: row.active_actors ?? 0,

      searches: row.searches ?? 0,
      searchesWithResults,
      zeroResultSearches,
      nonEmptySearches: Math.max(0, searchesWithResults - zeroResultSearches),
      broadenedSearches: row.broadened_searches ?? 0,
      attributableSearches: row.attributable_searches ?? 0,
      engagedSearches: row.engaged_searches ?? 0,
      attributableZeroResultSearches: row.attributable_zero_result_searches ?? 0,
      recoveredZeroResultSearches: row.recovered_zero_result_searches ?? 0,

      listingViews: row.listing_views ?? 0,
      outboundClicks: row.outbound_clicks ?? 0,
      savedSearches: row.saved_searches ?? 0,
      emailOptIns: optInsByPeriod.get(row.period_start) ?? 0,
      signInEvents: row.sign_in_events ?? 0,
      signedInActors: row.signed_in_actors ?? 0,

      newActors: life?.new_actors ?? 0,
      activatedNewActors: life?.activated_new_actors ?? 0,
      returningActors: life?.returning_actors ?? 0,
      priorActors: life?.prior_actors ?? 0,
      retainedActors: life?.retained_actors ?? 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure trend model — DB-free, unit-testable, and the only place "is this getting
// better or worse?" is decided.
// ─────────────────────────────────────────────────────────────────────────────

/** Raw movement of the metric between the last two COMPLETE periods. */
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';
/** Movement re-read through whether up is good for THIS metric. */
export type TrendVerdict = 'improving' | 'worsening' | 'steady' | 'unknown';
/** Which way is good. `neutral` = a volume counter with no inherent good direction. */
export type KpiBetter = 'higher' | 'lower' | 'neutral';
/** How the UI should render the numbers. */
export type KpiFormat = 'count' | 'pct' | 'perDay';

/** One period's value for one KPI, plus the denominator it was computed over. */
export interface KpiPoint {
  /** Bucket key, 'YYYY-MM-DD'. */
  period: string;
  /** Axis label ('YYYY-MM-DD' or 'YYYY-MM'). */
  label: string;
  /** The KPI value, or null when there was no data to state it. */
  value: number | null;
  /** The denominator this value was computed over (null for plain counts). */
  sample: number | null;
  /** True on the newest, still-in-progress bucket. */
  partial: boolean;
  /** True when the bucket closed before the product recorded anything (see isPreHistory). */
  preHistory?: boolean;
}

/** A target a KPI can be read against (mirrors benchmark.ts's target shape). */
export interface KpiTarget {
  value: number;
  direction: 'gte' | 'lte';
  /** Where the target comes from — 'TSD §12.5 KPI #7 (ratified)' vs 'launch goal'. */
  source: string;
}

/** The definition half of an operating KPI — everything that is not data. */
export interface OperatingKpiDef {
  key: string;
  label: string;
  /** One line the reviewer can read to know exactly what the number means. */
  description: string;
  format: KpiFormat;
  better: KpiBetter;
  /** Spec provenance, or an explicit note that the definition is proposed here. */
  provenance: string;
  /** Which review the KPI belongs to. 'both' shows in daily AND monthly. */
  cadence: 'daily' | 'monthly' | 'both';
  target?: KpiTarget;
}

/** A KPI definition joined to its live series and trend read — the UI's row model. */
export interface OperatingKpi extends OperatingKpiDef {
  points: KpiPoint[];
  /** Value of the newest COMPLETE period — the number the review is read off. */
  current: number | null;
  /** Value of the period before that. */
  previous: number | null;
  /** Value of the in-progress period, shown separately and never compared. */
  inProgress: number | null;
  /** current − previous, or null when either is missing. */
  delta: number | null;
  direction: TrendDirection;
  verdict: TrendVerdict;
  /** True when `current`'s denominator is a non-zero value below MIN_RATE_SAMPLE. */
  lowSample: boolean;
  /** true = target met, false = missed, null = no target or no data. */
  met: boolean | null;
}

/**
 * Raw direction between two values. `null` on either side → 'unknown' (we do not
 * know, which is different from 'flat'). Exact equality → 'flat'.
 */
export function trendDirection(current: number | null, previous: number | null): TrendDirection {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return 'unknown';
  }
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

/** Re-read a raw direction through whether up is good for this metric. */
export function trendVerdict(direction: TrendDirection, better: KpiBetter): TrendVerdict {
  if (direction === 'unknown') return 'unknown';
  if (direction === 'flat') return 'steady';
  if (better === 'neutral') return 'steady';
  const goodWhenUp = better === 'higher';
  return (direction === 'up') === goodWhenUp ? 'improving' : 'worsening';
}

/** Evaluate a KPI value against its target. Null-safe: no data is never a miss. */
export function meetsTarget(value: number | null, target: KpiTarget | undefined): boolean | null {
  if (!target || value == null || !Number.isFinite(value)) return null;
  return target.direction === 'gte' ? value >= target.value : value <= target.value;
}

/**
 * Join a KPI definition to its per-period series and derive the whole trend read.
 *
 * `current`/`previous` come from the last two COMPLETE periods — the in-progress
 * period is reported as `inProgress` and never used as a comparison endpoint. With
 * fewer than two complete periods of data (KIDS FUN's situation days after launch),
 * `direction` is honestly 'unknown' rather than a made-up arrow.
 */
export function buildOperatingKpi(def: OperatingKpiDef, points: KpiPoint[]): OperatingKpi {
  const complete = points.filter((p) => !p.partial);
  const partial = points.find((p) => p.partial) ?? null;

  const latest = complete.length > 0 ? complete[complete.length - 1] : null;
  const prior = complete.length > 1 ? complete[complete.length - 2] : null;

  const current = latest?.value ?? null;
  const previous = prior?.value ?? null;
  const direction = trendDirection(current, previous);

  return {
    ...def,
    points,
    current,
    previous,
    inProgress: partial?.value ?? null,
    delta: current != null && previous != null ? Math.round((current - previous) * 10) / 10 : null,
    direction,
    verdict: trendVerdict(direction, def.better),
    lowSample: latest?.sample != null && latest.sample > 0 && latest.sample < MIN_RATE_SAMPLE,
    met: meetsTarget(current, def.target),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-KPI derivations — each maps one period's counters to (value, sample).
// Every ratio delegates to the canonical helper in kpi.ts. Exported for tests.
// ─────────────────────────────────────────────────────────────────────────────

/** Share of NEW actors in the period that reached an activation moment. */
export function activationPct(c: OperatingPeriodCounts): number | null {
  return pct(c.activatedNewActors, c.newActors);
}

/** Share of the PREVIOUS period's actors that came back in this period. */
export function retentionPct(c: OperatingPeriodCounts): number | null {
  return pct(c.retainedActors, c.priorActors);
}

/**
 * Share of searches that returned at least one result. This is the DEFINITIONAL,
 * exact half of "search success" — it needs no relevance label and cannot be argued
 * with. It is the complement of the canonical zero-result rate.
 */
export function nonEmptyResultPct(c: OperatingPeriodCounts): number | null {
  const zero = zeroResultPct(c.zeroResultSearches, c.searchesWithResults);
  return zero == null ? null : 100 - zero;
}

/**
 * Share of searches followed by a same-actor listing view or source click inside
 * SEARCH_OUTCOME_WINDOW_MINUTES — a BEHAVIOURAL proxy for "the parent found
 * something useful". Explicitly a proxy: the §9 event catalog carries no relevance
 * grade (see the note at the top of kpi.ts), so this is the strongest honest signal
 * the data can support, and it is labelled as such everywhere it is shown.
 */
export function searchEngagementPct(c: OperatingPeriodCounts): number | null {
  return pct(c.engagedSearches, c.attributableSearches);
}

/** Share of zero-result searches followed by a same-actor search that DID return results. */
export function zeroResultRecoveryPct(c: OperatingPeriodCounts): number | null {
  return pct(c.recoveredZeroResultSearches, c.attributableZeroResultSearches);
}

/** Saved-search + email-opt-in volume — the account-value counter, per period. */
export function savedSearchAndEmailTotal(c: OperatingPeriodCounts): number {
  return c.savedSearches + c.emailOptIns;
}

interface Derivation {
  def: OperatingKpiDef;
  value: (c: OperatingPeriodCounts) => number | null;
  /** The denominator behind `value`, for the low-sample flag. Null for raw counts. */
  sample?: (c: OperatingPeriodCounts) => number | null;
}

/**
 * The full operating KPI set the launch scope names, in review order. Each entry
 * states its own provenance so a reviewer can see at a glance which numbers are
 * ratified spec targets and which are proposed here.
 */
const DERIVATIONS: readonly Derivation[] = [
  {
    def: {
      key: 'dau',
      label: 'Daily active users',
      description: 'Distinct actors (user_or_session) with any event in the period.',
      format: 'count',
      better: 'higher',
      provenance: 'TSD §12.5 reach; same distinct-actor definition as kpi.ts',
      cadence: 'daily',
    },
    value: (c) => c.activeActors,
  },
  {
    def: {
      key: 'active_actors',
      label: 'Monthly active users',
      description: 'Distinct actors with any event in the calendar month.',
      format: 'count',
      better: 'higher',
      provenance: 'TSD §12.5 reach; launch goal target from benchmark.ts',
      cadence: 'monthly',
    },
    value: (c) => c.activeActors,
  },
  {
    def: {
      key: 'signed_in_share',
      label: 'Signed-in share of active users',
      description:
        'Distinct actors that signed in at least once, ÷ all active actors in the period. TSD §12.5 KPI #15 "logged in at least once".',
      format: 'pct',
      better: 'higher',
      provenance: 'TSD §12.5 KPI #15 — computed with kpi.ts signedInSharePct()',
      cadence: 'both',
      target: { value: 20, direction: 'gte', source: 'launch goal (benchmark.ts SIGNED_IN_SHARE_TARGET_PCT)' },
    },
    value: (c) => signedInSharePct(c.signedInActors, c.activeActors),
    sample: (c) => c.activeActors,
  },
  {
    def: {
      key: 'activation',
      label: 'Activation rate (new actors)',
      description:
        'Of actors whose first-ever event was in this period, the share that opened a listing, clicked through to a source, or saved a search in the same period.',
      format: 'pct',
      better: 'higher',
      provenance: 'PROPOSED definition (ACTIVATION_EVENT_TYPES) — not a ratified TSD §12.5 target',
      cadence: 'both',
    },
    value: activationPct,
    sample: (c) => c.newActors,
  },
  {
    def: {
      key: 'retention',
      label: 'Period-over-period retention',
      description:
        'Of the actors active in the previous period, the share active again in this one. Day-over-day in the daily review, month-over-month in the monthly review.',
      format: 'pct',
      better: 'higher',
      provenance: 'PROPOSED definition (return-rate) — not a ratified TSD §12.5 target',
      cadence: 'both',
    },
    value: retentionPct,
    sample: (c) => c.priorActors,
  },
  {
    def: {
      key: 'saved_search_email',
      label: 'Saved searches + email opt-ins',
      description: 'saved_search_created plus opted-in weekly_email_opt_in events in the period.',
      format: 'count',
      better: 'higher',
      provenance: 'TSD §12.5 KPI #10,12 (repeat use / account value)',
      cadence: 'both',
    },
    value: savedSearchAndEmailTotal,
  },
  {
    def: {
      key: 'non_empty_results',
      label: 'Search success — non-empty result rate',
      description:
        'Share of searches that returned at least one result. Exact and definitional: the complement of the canonical zero-result rate.',
      format: 'pct',
      better: 'higher',
      provenance: 'TSD §12.5 KPI #1,2 — complement of kpi.ts zeroResultPct()',
      cadence: 'both',
      target: { value: 90, direction: 'gte', source: 'complement of the ≤10% zero-result launch goal' },
    },
    value: nonEmptyResultPct,
    sample: (c) => c.searchesWithResults,
  },
  {
    def: {
      key: 'search_engagement',
      label: 'Search success — engagement proxy',
      description: `Share of searches followed by the same actor opening a listing or clicking through to a source within ${SEARCH_OUTCOME_WINDOW_MINUTES} minutes.`,
      format: 'pct',
      better: 'higher',
      provenance: 'PROXY — the §9 event catalog carries no relevance grade, so this is behavioural, not graded',
      cadence: 'both',
    },
    value: searchEngagementPct,
    sample: (c) => c.attributableSearches,
  },
  {
    def: {
      key: 'zero_result_recovery',
      label: 'Zero-result recovery rate',
      description: `Of searches that returned nothing, the share where the same actor re-searched within ${SEARCH_OUTCOME_WINDOW_MINUTES} minutes and got results.`,
      format: 'pct',
      better: 'higher',
      provenance: 'PROPOSED definition (re-search recovery) — TSD §12.5 names the KPI, not its numerator',
      cadence: 'both',
    },
    value: zeroResultRecoveryPct,
    sample: (c) => c.attributableZeroResultSearches,
  },
  {
    def: {
      key: 'zero_result_rate',
      label: 'Zero-result search rate',
      description: 'Share of searches with result data that returned nothing.',
      format: 'pct',
      better: 'lower',
      provenance: 'launch goal (benchmark.ts ZERO_RESULT_TARGET_PCT) — kpi.ts zeroResultPct()',
      cadence: 'both',
      target: { value: 10, direction: 'lte', source: 'launch goal (benchmark.ts ZERO_RESULT_TARGET_PCT)' },
    },
    value: (c) => zeroResultPct(c.zeroResultSearches, c.searchesWithResults),
    sample: (c) => c.searchesWithResults,
  },
  {
    def: {
      key: 'source_ctr',
      label: 'Source click-through rate',
      description: 'outbound_source_click ÷ listing_viewed in the period.',
      format: 'pct',
      better: 'higher',
      provenance: 'TSD §12.5 KPI #7 (ratified) — kpi.ts sourceCtrPct()',
      cadence: 'both',
      target: { value: 25, direction: 'gte', source: 'TSD §12.5 KPI #7 (ratified)' },
    },
    value: (c) => sourceCtrPct(c.outboundClicks, c.listingViews),
    sample: (c) => c.listingViews,
  },
  {
    def: {
      key: 'searches_per_day',
      label: 'Searches per day',
      description: 'search_performed volume, averaged per calendar day of the period.',
      format: 'perDay',
      better: 'higher',
      provenance: 'launch goal (benchmark.ts SEARCHES_PER_DAY_TARGET) — kpi.ts perDay()',
      cadence: 'both',
      target: { value: 20, direction: 'gte', source: 'launch goal (benchmark.ts SEARCHES_PER_DAY_TARGET)' },
    },
    value: (c) => perDay(c.searches, daysInPeriod(c)),
  },
];

/**
 * Calendar days a period covers, for per-day averaging. Days are 1; months are read
 * off the bucket key so February and July are not both treated as 30.
 */
export function daysInPeriod(c: OperatingPeriodCounts): number {
  if (c.label.length !== 7) return 1; // 'YYYY-MM-DD' → a single day
  const [year, month] = c.label.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 30;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Build every operating KPI (definition + series + trend read) for a grain, keeping
 * only the ones that belong in that review. Pure — takes the counters, returns the
 * model, touches no database.
 *
 * `firstEventAtMs` (from getDataCoverage) anchors the pre-history suppression
 * described on {@link isPreHistory}: buckets that closed before the product recorded
 * anything yield `null`, so a monthly review run days after launch reports "not
 * enough data" for month-over-month rather than a confident, false "steady".
 */
export function buildOperatingKpis(
  counts: OperatingPeriodCounts[],
  grain: OperatingGrain,
  firstEventAtMs: number | null = null
): OperatingKpi[] {
  const wanted = grain === 'month' ? 'monthly' : 'daily';
  return DERIVATIONS.filter((d) => d.def.cadence === 'both' || d.def.cadence === wanted).map((d) =>
    buildOperatingKpi(
      d.def,
      counts.map((c) => {
        const preHistory = isPreHistory(c.period, grain, firstEventAtMs);
        return {
          period: c.period,
          label: c.label,
          value: preHistory ? null : d.value(c),
          sample: preHistory || !d.sample ? null : d.sample(c),
          partial: c.partial,
          preHistory,
        };
      })
    )
  );
}
