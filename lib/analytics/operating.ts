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
import { queryWithTimeout } from '@/lib/db/client';
import { adminAnalyticsQueryTimeoutMs } from '@/lib/db/budgets';
import {
  MAU_WINDOW_DAYS,
  SOURCE_CTR_TARGET_PCT,
  pct,
  perDay,
  signedInSharePct,
  sourceCtrPct,
  zeroResultPct,
} from './kpi';
// The ONE shared exclusion-predicate generator (also used by kpi.ts and trends.ts) — see that
// module's header for the 2026-09-22 window-mismatch bug a hand-copied version of this predicate
// caused between two OTHER consumers, and why this file must not add a third hand-typed copy.
import {
  ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD,
  highFrequencyExclusionAgainstFlagged,
  highFrequencyFlaggedDaysCte,
} from './high-frequency-exclusion';
// Targets are IMPORTED, never copied. The UI renders a provenance line naming these
// very constants as each target's source, so a hardcoded literal here would let a
// tuned launch goal move /admin/product-health while /admin/operating silently kept
// the old number and went on claiming benchmark.ts as its authority.
import {
  MAU_TARGET,
  SEARCHES_PER_DAY_TARGET,
  SIGNED_IN_SHARE_TARGET_PCT,
  ZERO_RESULT_TARGET_PCT,
} from './benchmark';
// The "measured zero vs. nothing to measure" primitive, extracted to its own pure
// module (H1) so lib/observability/ can apply the identical rule without importing
// this module's database client. Re-exported below so existing call sites are
// unchanged and there remains exactly ONE definition in the codebase.
import { anchorMsFromIso, isPreHistory, periodEndMs, type PeriodGrain } from './prehistory';

export { anchorMsFromIso, isPreHistory, periodEndMs };
export type { PeriodGrain };

// ─────────────────────────────────────────────────────────────────────────────
// Grain / window configuration
// ─────────────────────────────────────────────────────────────────────────────

/** The two review cadences the operating dashboard supports (G-T41-2). */
export type OperatingGrain = PeriodGrain;

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

// `periodEndMs` / `isPreHistory` now live in lib/analytics/prehistory.ts — pure and
// DB-free, so lib/observability/ can share the identical primitive without importing
// this module's pg pool. They are re-exported verbatim (see the import block at the
// top) so every existing call site keeps its current import path. Do NOT reintroduce
// a local copy: re-derivation per surface is exactly the defect H1 exists to close.

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
 * ═══ THE FRAME MUST GROW, NOT SHRINK (2026-09-02, third rewrite) ═══
 * `engaged`/`recovered` began as two EXISTS subqueries evaluated per row against a
 * user_or_session column with no index: >600s, abandoned. Two rewrites followed, and the
 * SECOND ONE CAUSED A PRODUCTION OUTAGE. The history matters more than the destination:
 *
 *   dc55d1a  min() over an UNBOUNDED FOLLOWING frame. Reported at 7.1s. That number was
 *            WRONG -- measured on a fixture built to test tie handling, not timing. The real
 *            figure was 35.9s, slower than the 18.3s EXISTS version it replaced.
 *   091d1a8  bounded the frame: RANGE ... 30 min FOLLOWING EXCLUDE GROUP. Correct, and fast
 *            on ordinary traffic -- but it took /admin/operating to a hard 60s timeout.
 *   this     ORDER BY created_at DESC + GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING.
 *
 * WHY THE BOUNDED FRAME STILL BLEW UP. A time bound only helps if the bound is reached before
 * the partition ends. Production has ~2,758 sessions carrying >100 events inside <30 minutes
 * (max 628, p99 601) -- scripted traffic, not people. In a session denser than the outcome
 * window, every row's frame runs to nearly the end of that session, so the per-session cost is
 * O(n^2) no matter how cheap the bound makes the sparse ~97%. The average session got faster
 * while the page got slower.
 *
 * WHY THIS FORM IS DIFFERENT, AND IT IS NOT THE `min()`. Both dc55d1a and this use `min()`.
 * What changed is the DIRECTION THE FRAME MOVES. A frame that shrinks from the left forces a
 * rescan per row, because `min()` has no inverse -- you cannot un-see the value you dropped.
 * Reversing the sort turns the same set of rows into a frame that only ever GROWS, and `min()`
 * over a growing frame is one comparison per row. In DESC order, `GROUPS ... 1 PRECEDING` means
 * "every row strictly later in time", which is the `> e.created_at` the original EXISTS wanted,
 * and skipping the whole peer group is what keeps ties out -- `created_at` defaults to `now()`,
 * so every row written in one transaction shares a timestamp. Cost is then independent of
 * session density, which is the property the previous two forms both lacked.
 *
 * Measured on ONE fixture holding production's real shape (2.25M events, 2,758 sessions with
 * >100 events in <30 min). Cross-fixture numbers are NOT comparable and are deliberately not
 * tabled together here -- that confusion is what produced the false 7.1s above:
 *
 *     091d1a8, bounded RANGE frame     103.5 s      (production: HTTP 000, 60s timeout)
 *     this form, growing frame          15.4 s
 *
 * Byte-identical to 091d1a8 across all 30 periods on that fixture, with both paths carrying
 * real volume (1,336,247 engaged / 59,405 recovered) -- an equality check where either side
 * reads zero proves nothing. Boundary and tie cases are pinned per-case in
 * tests/analytics/trend-query-db.test.ts: +30min exactly counts, +40min does not, and a
 * same-instant follow-up does not.
 *
 * ⚠ RAISING work_mem DOES NOT HELP -- tested at 64MB and 256MB, no material change. The sorts
 * do spill, but they are not the dominant cost, so do not reach for that lever here.
 *
 * ═══ AND THE PERIOD JOIN IS AGGREGATED FIRST ═══
 * Joining every event to `periods` produced 1.19M rows that then had to be sorted by bucket, with
 * `count(DISTINCT user_or_session)` on top — the same sort-spill shape fixed in lib/analytics/kpi.ts.
 * Bucketing with date_trunc, aggregating, and joining the 30 period rows to that result avoids both.
 * Distinct actors are counted by grouping first, then counting, for the same reason.
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
  return queryWithTimeout<EngagementRow>(
    `
    WITH ${PERIODS_CTE},
    bounds AS (
      SELECT min(pstart) AS lo, max(pstart) + $2::interval AS hi FROM periods
    ),
    scanned AS (
      SELECT
        e.id,
        e.created_at,
        e.event_type,
        e.user_or_session,
        (e.user_or_session IS NOT NULL AND e.user_or_session <> '') AS has_actor,
        (e.result_summary_json ? 'total')                          AS has_total,
        ((e.result_summary_json ->> 'total') = '0')                AS zero_result,
        ((e.result_summary_json ->> 'broadened') = 'true')         AS broadened,
        min(e.created_at) FILTER (
          WHERE e.event_type IN ('listing_viewed', 'outbound_source_click')
        ) OVER w AS next_engage_at,
        min(e.created_at) FILTER (
          WHERE e.event_type = 'search_performed'
            AND (e.result_summary_json ? 'total')
            AND (e.result_summary_json ->> 'total') <> '0'
        ) OVER w AS next_recover_at
      FROM analytics_event e, bounds b
      WHERE e.created_at >= b.lo AND e.created_at < b.hi
      WINDOW w AS (
        PARTITION BY e.user_or_session
        ORDER BY e.created_at DESC
        GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      )
    ),
    -- The IS NOT NULL checks below are REDUNDANT and deliberately kept. A NULL next_*_at makes
    -- the comparison NULL, the conjunction not-true, and count(*) FILTER skips not-true rows,
    -- so removing them changes no output. Mutation testing flags this as a surviving mutant; it is
    -- an equivalent mutant, not a coverage gap, and no test can be written to catch it. Kept
    -- because "no follow-up exists" is the common case here and saying so explicitly is cheaper
    -- to read than re-deriving three-valued logic at the call site.
    ev AS (
      SELECT
        date_trunc($1::text, s.created_at) AS pstart,
        s.id, s.event_type, s.user_or_session, s.has_actor, s.has_total, s.zero_result, s.broadened,
        (s.event_type = 'search_performed' AND s.has_actor
          AND s.next_engage_at IS NOT NULL
          AND s.next_engage_at <= s.created_at + ($4::int * interval '1 minute')) AS engaged,
        (s.event_type = 'search_performed' AND s.has_actor
          AND s.next_recover_at IS NOT NULL
          AND s.next_recover_at <= s.created_at + ($4::int * interval '1 minute')) AS recovered
      FROM scanned s
    ),
    counted AS (
      SELECT
        pstart,
        count(id)::int AS events,
        count(id) FILTER (WHERE event_type = 'search_performed')::int AS searches,
        count(id) FILTER (WHERE event_type = 'search_performed' AND has_total)::int
          AS searches_with_results,
        count(id) FILTER (WHERE event_type = 'search_performed' AND has_total AND zero_result)::int
          AS zero_result_searches,
        count(id) FILTER (WHERE event_type = 'search_performed' AND broadened)::int
          AS broadened_searches,
        count(id) FILTER (WHERE event_type = 'search_performed' AND has_actor)::int
          AS attributable_searches,
        count(id) FILTER (WHERE engaged)::int AS engaged_searches,
        count(id) FILTER (
          WHERE event_type = 'search_performed' AND has_total AND zero_result AND has_actor
        )::int AS attributable_zero_result_searches,
        count(id) FILTER (WHERE recovered AND has_total AND zero_result)::int
          AS recovered_zero_result_searches,
        count(id) FILTER (WHERE event_type = 'listing_viewed')::int AS listing_views,
        count(id) FILTER (WHERE event_type = 'outbound_source_click')::int AS outbound_clicks,
        count(id) FILTER (WHERE event_type = 'saved_search_created')::int AS saved_searches,
        count(id) FILTER (WHERE event_type = 'account_signed_in')::int AS sign_in_events
      FROM ev
      GROUP BY pstart
    ),
    -- ═══ THE ACTOR COUNTS READ THE BASE TABLE, NOT ev, AND THAT IS THE WHOLE FIX ═══
    -- These were SELECT DISTINCT pstart, user_or_session FROM ev, and that single choice cost
    -- 35.4 of this query's 35.9 seconds: an external merge spilling 123MB.
    --
    -- ev is referenced three times, so Postgres MATERIALISES it — 1.19M rows carrying every
    -- window output and boolean flag. De-duplicating actors out of that means sorting 1.19M WIDE
    -- tuples. Reading the base table instead lets the planner group a two-column projection and
    -- use idx_analytics_event_actor_created. Measured: 35.4s -> 1.9s, same answer.
    --
    -- The tell that this was wrong: an actor count does not need engaged, recovered, or any
    -- of the window machinery. It was reading from ev only because ev was already there.
    --
    -- === THE 2026-09-22 EXCLUSION, VIA THE SHARED GENERATOR (lib/analytics/high-frequency-
    -- exclusion.ts) ===
    -- active_actors/signed_in_actors are PER-PERIOD metrics -- one independent count per
    -- pstart row, exactly like trends.ts's per-day DAU, not a single aggregate over the whole
    -- scan range. bounds (b.lo/b.hi) spans ALL requested periods at once (e.g. all 30 days),
    -- so it is a "scan once" convenience window for THIS query, the same role trends.ts's scan
    -- plays for its own per-day outputs -- it is NOT any one period's own window, and checking a
    -- candidate row's flag against the full b.lo/b.hi range directly (an earlier version of this
    -- fix did exactly that) would exclude an actor from EVERY period in the series just because
    -- they crossed the threshold once, on one unrelated day -- the exact tiles/trend-line drift
    -- bug this module exists to prevent, reproduced one file over. So: flagged finds every
    -- (day, actor) pair that crossed the threshold anywhere in the wide scan range (cheap
    -- candidate list, per highFrequencyFlaggedDaysCte's own contract), and each subquery below
    -- checks that candidate list against ITS OWN correct window -- see the REVISED decision just
    -- below for what that window actually is today (it is not "that row's own bucket alone").
    --
    -- === DELIBERATE ARCHITECTURAL DECISION, REVISED (2026-09-22, THIRD review round, 6f176ae2)
    -- ===
    -- An earlier version of this comment picked "operating.ts stays per-bucket everywhere" and
    -- documented the cross-PAGE consequence (activeActors vs /admin/product-health's DAU tile) as
    -- accepted. 6f176ae2 found a narrower, same-PAGE instance that comment did not cover:
    -- /admin/operating renders BOTH the DAU chart (getActivityTrend, shared 30-day window) AND
    -- this table's "Active" column (active_actors, was per-bucket) side by side -- an actor
    -- flagged 10 days ago with ordinary traffic today showed DAU=0 on the chart directly above
    -- "Active"=1 in the table below it, on the SAME page, for the SAME day. That is a materially
    -- different bar than agreeing with a number on a DIFFERENT page: a reader comparing two
    -- numbers next to each other has no reason to expect them to mean different things unless
    -- told so.
    --
    -- REVISED DECISION: active_actors and signed_in_actors now share kpi.ts's/trends.ts's 30-day
    -- (MAU_WINDOW_DAYS) trailing exclusion window too, generalized per bucket exactly the way
    -- trends.ts's per-day dau is (window ends at THIS row's own pstart, not "now" -- a historical
    -- row gets its own historical 30-day lookback, not today's). This is a narrower change than
    -- it looks: 'flagged' already existed as a separate small pre-aggregation; only its day
    -- granularity (now always 'day', not grain-parameterized -- a MONTH-grain bucket's own
    -- trailing window is still resolved to day precision, see below) and the two dayWindowSql
    -- values changed.
    --
    -- getLifecycleSeries's 'seen' (new/activated/returning/retained) is UNCHANGED and keeps its
    -- own separate per-bucket 'flagged' CTE (that function's own comment) -- the two 🔴
    -- cross-period regression tests pinning per-bucket-only lifecycle behaviour (~line 667/~687)
    -- still apply there. The reviewers' own read (independently confirmed correct) is that the
    -- lifecycle cohorts have no counterpart chart to disagree with and no cross-metric nesting
    -- duty, so they were never the problem -- only active_actors/signed_in_actors, which sit
    -- directly beside trends.ts's chart on the page, needed to move.
    --
    -- The MONTH-grain case: MAU_WINDOW_DAYS is a fixed 30-day width regardless of series grain
    -- (kpi.ts's own window is always 30 days, never scaled by any "period" concept), so a monthly
    -- bucket's trailing window is simply "the 30 days immediately before this month's pstart" --
    -- well-defined, and consistent with how a kpi.ts-style snapshot generalizes to a historical
    -- point, exactly as trends.ts's per-day dau generalizes kpi.ts's single snapshot to every
    -- plotted day.
    flagged AS (
      ${highFrequencyFlaggedDaysCte({
        scanWindowSql:
          "e.created_at >= (SELECT lo FROM bounds) - (($6::int - 1) * interval '1 day') AND e.created_at < (SELECT hi FROM bounds)",
        dayExpr: "date_trunc('day', e.created_at)",
        thresholdParam: '$5',
      })}
    ),
    actor_counts AS (
      SELECT pstart, count(*)::int AS active_actors
      FROM (
        SELECT date_trunc($1::text, e.created_at) AS pstart, e.user_or_session
          FROM analytics_event e, bounds b
         WHERE e.created_at >= b.lo AND e.created_at < b.hi
           AND e.user_or_session IS NOT NULL AND e.user_or_session <> ''
           AND ${highFrequencyExclusionAgainstFlagged({
             actorAlias: 'e',
             actorColumn: 'user_or_session',
             dayColumn: 'pstart',
             dayWindowSql:
               "f.d <= date_trunc($1::text, e.created_at) AND f.d > date_trunc($1::text, e.created_at) - ($6::int - 1) * interval '1 day'",
           })}
         GROUP BY 1, 2
      ) d
      GROUP BY pstart
    ),
    signed_in_counts AS (
      SELECT pstart, count(*)::int AS signed_in_actors
      FROM (
        SELECT date_trunc($1::text, e.created_at) AS pstart, e.user_or_session
          FROM analytics_event e, bounds b
         WHERE e.created_at >= b.lo AND e.created_at < b.hi
           AND e.event_type = 'account_signed_in'
           AND e.user_or_session IS NOT NULL AND e.user_or_session <> ''
           AND ${highFrequencyExclusionAgainstFlagged({
             actorAlias: 'e',
             actorColumn: 'user_or_session',
             dayColumn: 'pstart',
             dayWindowSql:
               "f.d <= date_trunc($1::text, e.created_at) AND f.d > date_trunc($1::text, e.created_at) - ($6::int - 1) * interval '1 day'",
           })}
         GROUP BY 1, 2
      ) d
      GROUP BY pstart
    )
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD') AS period_start,
      COALESCE(c.events, 0) AS events,
      COALESCE(a.active_actors, 0) AS active_actors,
      COALESCE(c.searches, 0) AS searches,
      COALESCE(c.searches_with_results, 0) AS searches_with_results,
      COALESCE(c.zero_result_searches, 0) AS zero_result_searches,
      COALESCE(c.broadened_searches, 0) AS broadened_searches,
      COALESCE(c.attributable_searches, 0) AS attributable_searches,
      COALESCE(c.engaged_searches, 0) AS engaged_searches,
      COALESCE(c.attributable_zero_result_searches, 0) AS attributable_zero_result_searches,
      COALESCE(c.recovered_zero_result_searches, 0) AS recovered_zero_result_searches,
      COALESCE(c.listing_views, 0) AS listing_views,
      COALESCE(c.outbound_clicks, 0) AS outbound_clicks,
      COALESCE(c.saved_searches, 0) AS saved_searches,
      COALESCE(c.sign_in_events, 0) AS sign_in_events,
      COALESCE(si.signed_in_actors, 0) AS signed_in_actors
    FROM periods p
    LEFT JOIN counted c ON c.pstart = p.pstart
    LEFT JOIN actor_counts a ON a.pstart = p.pstart
    LEFT JOIN signed_in_counts si ON si.pstart = p.pstart
    ORDER BY p.pstart
    `,
    [
      grain,
      grainInterval(grain),
      periods,
      SEARCH_OUTCOME_WINDOW_MINUTES,
      ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD,
      MAU_WINDOW_DAYS,
    ],
    adminAnalyticsQueryTimeoutMs()
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
 *
 * ═══ AGGREGATE ONCE, THEN JOIN 30 ROWS (2026-09-02) ═══
 * prior_actors and retained_actors were correlated scalar subqueries evaluated PER PERIOD,
 * and retained_actors carried a nested EXISTS inside that — so the event table was read
 * roughly 60 times per page load, twice per period, each read followed by a sort to satisfy
 * count(DISTINCT). `active` and `activated` compounded it by range-joining `periods` to
 * analytics_event and de-duplicating afterwards with DISTINCT, the same shape fixed in
 * getOpsSeries. Measured at 1.17M events / 50k actors:
 *
 *     before   2,292,271 shared buffer hits, spilled to temp    day 3.74 s / month 5.76 s
 *     after       ~48,000 shared buffer hits                    day 1.63 s / month 1.76 s
 *
 * Everything now derives from one pre-aggregated (period, actor, activated) relation. Prior
 * and retained fall out of joining that relation to itself one period apart, which is also
 * why `bounds.lo` reaches one period BEFORE the first period: the earliest bucket needs a
 * comparison period that is outside the requested window. Dropping that offset leaves the
 * first period's retention reading 0 rather than missing, so it is pinned by a test.
 *
 * Verified by symmetric difference against the previous query inside a single REPEATABLE
 * READ snapshot, on both grains — 0 differing rows. The snapshot matters: an earlier
 * side-by-side run disagreed on one cell, and re-running showed the table had changed
 * between the two queries rather than the queries disagreeing.
 */
async function getLifecycleSeries(grain: OperatingGrain, periods: number): Promise<LifecycleRow[]> {
  return queryWithTimeout<LifecycleRow>(
    `
    WITH ${PERIODS_CTE},
    bounds AS (
      SELECT min(pstart) - $2::interval AS lo, max(pstart) + $2::interval AS hi FROM periods
    ),
    -- The 2026-09-22 exclusion, via the shared generator (lib/analytics/high-frequency-
    -- exclusion.ts). seen is a PER-PERIOD relation -- one (pstart, actor) row per bucket, the
    -- same shape as getEngagementSeries's actor_counts (see that function's own comment for the
    -- full reasoning) -- so bounds (b.lo/b.hi, which here additionally spans one extra period
    -- on the low end for the carryover comparison) is a scan-once convenience window across ALL
    -- buckets, never any ONE bucket's own window. Excluding against the wide b.lo/b.hi range
    -- would purge an actor from every period in the series over a threshold crossing in a single
    -- unrelated period -- so, exactly as in getEngagementSeries, flagged finds threshold-
    -- crossing (period-bucket, actor) candidates anywhere in the wide scan range, and seen
    -- checks only its OWN bucket against it.
    flagged AS (
      ${highFrequencyFlaggedDaysCte({
        scanWindowSql:
          'e.created_at >= (SELECT lo FROM bounds) AND e.created_at < (SELECT hi FROM bounds)',
        dayExpr: 'date_trunc($1::text, e.created_at)',
        thresholdParam: '$5',
      })}
    ),
    seen AS (
      SELECT
        date_trunc($1::text, e.created_at)          AS pstart,
        e.user_or_session                           AS actor,
        bool_or(e.event_type = ANY($4::text[]))     AS activated
      FROM analytics_event e, bounds b
      WHERE e.created_at >= b.lo AND e.created_at < b.hi
        AND e.user_or_session IS NOT NULL AND e.user_or_session <> ''
        AND ${highFrequencyExclusionAgainstFlagged({
          actorAlias: 'e',
          actorColumn: 'user_or_session',
          dayColumn: 'pstart',
          dayWindowSql: 'f.d = date_trunc($1::text, e.created_at)',
        })}
      GROUP BY 1, 2
    ),
    -- Lifetime first-seen, for the actors seen HAS ALREADY MATERIALISED — not for every
    -- actor that has ever existed. The previous form re-scanned the whole table (Parallel Seq
    -- Scan, 2.65M rows, 118,534 physical block reads) to build rows that mostly cannot be
    -- reached: per_actor is periods LEFT JOIN seen s LEFT JOIN actor_first af ON af.actor =
    -- s.actor, driven from the seen side, so an af row with no matching seen actor is inert
    -- by construction. Measured on production 2026-09-14: this node 7.65s -> 5.5s, and its
    -- physical reads 118,534 -> 7,606 blocks (-93.6%, ~0.87GB less I/O per page load). The I/O
    -- is the point, not the seconds — shared_buffers is 256MB against a 1,164MB heap, so every
    -- block this does not read is a block the page's eight sibling queries are not evicted for.
    -- Output verified BYTE-IDENTICAL to the old form over all 30 periods in one REPEATABLE READ
    -- snapshot, and first_at identical for all 15,700 shared actors.
    --
    -- TWO THINGS HERE ARE LOAD-BEARING AND EASY TO "TIDY" INTO A BUG:
    --   • DISTINCT. Without it this yields one row per (pstart, actor) and the LEFT JOIN in
    --     per_actor FANS OUT, multiplying new_actors/activated_new_actors/returning_actors by
    --     the number of periods the actor appears in.
    --   • The subquery carries NO time predicate. Bounding it to bounds looks like the
    --     obvious next optimisation and silently reclassifies returning actors as new — the
    --     mutant was written and it diverged on a real actor.
    --
    -- KNOWN LIMIT (cost, not correctness): this scales with ACTOR count where the old form
    -- scaled with ROW count. Today that is 15.7k actors against 2.65M rows. At grain='month'
    -- the window covers nearly all retained history, so seen holds nearly every actor and the
    -- win narrows; at hundreds of thousands of actors, 0.35ms per index probe would make this
    -- slower than the seq scan. Re-measure before assuming it still wins.
    actor_first AS (
      SELECT s.actor,
             (SELECT min(e.created_at)
                FROM analytics_event e
               WHERE e.user_or_session = s.actor) AS first_at
      FROM (SELECT DISTINCT actor FROM seen) s
    ),
    carryover AS (
      SELECT
        p.pstart,
        count(*)::int                                          AS prior_actors,
        count(*) FILTER (WHERE cur.actor IS NOT NULL)::int      AS retained_actors
      FROM periods p
      JOIN seen prev      ON prev.pstart = p.pstart - $2::interval
      LEFT JOIN seen cur  ON cur.pstart = p.pstart AND cur.actor = prev.actor
      GROUP BY p.pstart
    ),
    per_actor AS (
      SELECT
        p.pstart,
        count(s.actor) FILTER (WHERE af.first_at >= p.pstart)::int AS new_actors,
        count(s.actor) FILTER (WHERE af.first_at >= p.pstart AND s.activated)::int
          AS activated_new_actors,
        count(s.actor) FILTER (WHERE af.first_at < p.pstart)::int  AS returning_actors
      FROM periods p
      LEFT JOIN seen s         ON s.pstart = p.pstart
      LEFT JOIN actor_first af ON af.actor = s.actor
      GROUP BY p.pstart
    )
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD')       AS period_start,
      pa.new_actors,
      pa.activated_new_actors,
      pa.returning_actors,
      coalesce(c.prior_actors, 0)::int      AS prior_actors,
      coalesce(c.retained_actors, 0)::int   AS retained_actors
    FROM periods p
    JOIN per_actor pa     ON pa.pstart = p.pstart
    LEFT JOIN carryover c ON c.pstart = p.pstart
    ORDER BY p.pstart
    `,
    [
      grain,
      grainInterval(grain),
      periods,
      [...ACTIVATION_EVENT_TYPES],
      ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD,
    ],
    adminAnalyticsQueryTimeoutMs()
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
  return queryWithTimeout<{ period_start: string; email_opt_ins: number }>(
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
    [grain, grainInterval(grain), periods],
    adminAnalyticsQueryTimeoutMs()
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
  const rows = await queryWithTimeout<{ first_event_at: Date | null; total_events: number }>(
    `SELECT min(created_at) AS first_event_at, count(*)::int AS total_events FROM analytics_event`,
    undefined,
    adminAnalyticsQueryTimeoutMs()
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
      provenance: 'TSD §12.5 reach; launch goal target from benchmark.ts (MAU_TARGET)',
      cadence: 'monthly',
      // The provenance line above promises a target, so one is actually rendered —
      // MAU_TARGET already existed in benchmark.ts and was going unused.
      target: { value: MAU_TARGET, direction: 'gte', source: 'launch goal (benchmark.ts MAU_TARGET)' },
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
      target: {
        value: SIGNED_IN_SHARE_TARGET_PCT,
        direction: 'gte',
        source: 'launch goal (benchmark.ts SIGNED_IN_SHARE_TARGET_PCT)',
      },
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
      // Derived, not restated: this KPI IS the complement of the zero-result rate, so its
      // target must be the complement of that target or the two can disagree.
      target: {
        value: 100 - ZERO_RESULT_TARGET_PCT,
        direction: 'gte',
        source: `complement of the ≤${ZERO_RESULT_TARGET_PCT}% zero-result launch goal (benchmark.ts ZERO_RESULT_TARGET_PCT)`,
      },
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
      target: {
        value: ZERO_RESULT_TARGET_PCT,
        direction: 'lte',
        source: 'launch goal (benchmark.ts ZERO_RESULT_TARGET_PCT)',
      },
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
      target: {
        value: SOURCE_CTR_TARGET_PCT,
        direction: 'gte',
        source: 'TSD §12.5 KPI #7 (ratified) — kpi.ts SOURCE_CTR_TARGET_PCT',
      },
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
      target: {
        value: SEARCHES_PER_DAY_TARGET,
        direction: 'gte',
        source: 'launch goal (benchmark.ts SEARCHES_PER_DAY_TARGET)',
      },
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
