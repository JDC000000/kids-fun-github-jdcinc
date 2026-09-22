// lib/analytics/trends.ts — READ-SIDE daily product-health TRENDS (M5 / T32, G-T32-6).
//
// The over-time companion to lib/analytics/kpi.ts: where kpi.ts returns the single
// current-window snapshot the dashboard tiles show, this returns a per-DAY series so
// the admin product-health page can plot DAU/WAU/MAU (and daily activity volume) as
// trend lines. Same discipline as kpi.ts: a pure CONSUMER — every statement is a
// SELECT, nothing mutates, and it imports NOTHING from the analytics write side. Safe
// on an EMPTY table (every day returns 0, the chart renders a flat baseline, never an
// error). It reuses kpi.ts's window constants so the trailing WAU/MAU windows here are
// byte-for-byte the same definition the snapshot tiles use.
//
// ── PRE-HISTORY (H1) ───────────────────────────────────────────────────────────
// Days that closed BEFORE analytics instrumentation recorded its first event carry
// `null`, not 0. Before H1 this module had no pre-history concept at all, so a 30-day
// chart drawn days after instrumentation landed painted a flat zero line across the
// weeks before it existed — which on a traffic chart reads as a sustained outage.
// Both surfaces that plot this series (/admin/product-health and /admin/operating)
// showed it, and on /admin/operating the chart's own data table contradicted the
// detail table directly below it, which had already been fixed to dash those days.
//
// The suppression is deliberately NARROW. A day AFTER the first event on which nobody
// visited is a genuine, measured zero and still renders as a visible 0 — that traffic
// cliff is the single most important thing these charts exist to catch, and hiding it
// behind an em-dash would be a worse bug than the one being fixed. Only days whose
// bucket CLOSED at or before the first recorded event are suppressed. See
// lib/analytics/prehistory.ts for the shared rule.
import { queryWithTimeout } from '@/lib/db/client';
import { adminAnalyticsQueryTimeoutMs } from '@/lib/db/budgets';
import { WAU_WINDOW_DAYS, MAU_WINDOW_DAYS } from './kpi';
import { anchorMsFromIso, isPreHistory } from './prehistory';
// The ONE shared exclusion-predicate generator — see that module's header for the 2026-09-22
// window-mismatch bug a hand-copied version of this exact predicate (this file's own previous
// version included) caused between this trend line and kpi.ts's tiles.
import {
  ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD,
  highFrequencyFlaggedDaysCte,
  highFrequencyExclusionAgainstFlagged,
} from './high-frequency-exclusion';

/** How many trailing calendar days the trend charts plot by default. */
export const TREND_WINDOW_DAYS = 30;

/**
 * Per-query ceiling for the trend read — now the SHARED admin budget, not a second opinion.
 *
 * ═══ THE OLD 8s NUMBER WAS CORRECTING FOR TWO THINGS THAT TURNED OUT TO BE WRONG ═══
 * It was justified as "~5x headroom over a measured ~1.5s" and as sitting "below the
 * serverless function ceiling (~10s on the current plan)". Both were re-measured against
 * production on 2026-09-14 and neither holds:
 *
 *   • THE QUERY COSTS 10.2s, not 1.5s. The 1.5s figure came from a fixture; the table has
 *     since reached 2.65M rows. So the ceiling was not 5x headroom — it was BELOW the
 *     query's ordinary cost, and it fired on every single load. That is the whole reason
 *     /admin/product-health returned a 500 after ~8.6s: not contention, not a fault, just a
 *     budget that the normal path could no longer fit inside.
 *   • THE FUNCTION CEILING IS NOT ~10s. /admin/dashboard was observed still executing 75s
 *     into a request, so the platform was never the binding constraint the comment assumed.
 *
 * A ceiling set below a query's routine cost is not a guard, it is an outage: it converted a
 * slow page into a broken one and named the trend query while doing it. The real protection —
 * that the statement cancels ITSELF via SET LOCAL even if the function is torn down, so no
 * orphaned backend keeps scanning — is a property of queryWithTimeout, not of the number.
 * So the number becomes the one admin budget, and stops being a place a second guess can rot.
 * NB: this is now resolved PER CALL via adminAnalyticsQueryTimeoutMs() rather than captured
 * into a module-level const. A const is evaluated once at import, which would have pinned this
 * read to the page budget forever and made it the one read the scheduled refresh could not
 * widen — silently, and only under the cron path.
 */
// (no constant: the budget is read at the call site, below.)

/**
 * One day of the trend: the active-user windows *as of that day* + that day's raw volume.
 *
 * ── WHY EVERY MEASURE IS `number | null` ───────────────────────────────────────
 * This is the structural half of the H1 fix, and the nullability is load-bearing
 * rather than defensive. `preHistory` alone would not have prevented the defect: a new
 * surface writing `points.map((p) => p.dau)` into a chart series would still compile
 * and still draw a confident zero. Typing the MEASURES as nullable means the value
 * cannot reach a formatter or an axis without the surface deciding, in code the
 * compiler checks, what an unmeasurable day should look like. A forgotten pre-history
 * check is now a type error instead of a silent lie — the same guarantee `partial`
 * already gives OperatingPeriodCounts by living in the data.
 *
 * INVARIANT: `preHistory === true` ⟺ all four measures are `null`. They move as one
 * unit; there is no state where a day is half-measurable.
 */
export interface TrendPoint {
  /** UTC calendar day, 'YYYY-MM-DD'. */
  date: string;
  /**
   * True when this day CLOSED before analytics recorded its first event — nothing
   * could have been measured, so the measures below are null rather than 0.
   * False for every day after instrumentation began, INCLUDING genuinely quiet ones.
   */
  preHistory: boolean;
  /** Distinct actors active on this day (rolling 1-day / DAU). Null iff pre-history. */
  dau: number | null;
  /** Distinct actors active in the trailing WAU_WINDOW_DAYS ending this day. Null iff pre-history. */
  wau: number | null;
  /** Distinct actors active in the trailing MAU_WINDOW_DAYS ending this day. Null iff pre-history. */
  mau: number | null;
  /** All analytics_event rows recorded on this day (activity volume). Null iff pre-history. */
  events: number | null;
}

export interface ActivityTrend {
  /** The number of days plotted (length of `points`). */
  days: number;
  /** WAU/MAU rolling-window sizes echoed for the chart caption/legend. */
  windows: { wauDays: number; mauDays: number };
  /**
   * Oldest→newest. Always `days` long, one entry per calendar day — gaps are
   * zero-filled where the day was measurable and null-filled where it was not.
   */
  points: TrendPoint[];
  // NOTE: no `firstEventAt` here. H1 briefly exposed the anchor on this type, but
  // nothing consumed it — <TrendChart> explains its own em-dashes in the table caption,
  // which is the better place for it (the explanation belongs beside the dashes, not in
  // a field every caller must remember to render), and lib/admin/operating.ts already
  // carries the same instant as `coverage.firstEventAt` from getDataCoverage(). Two
  // sources for one fact is how they drift. Dropped rather than left as dead surface.
}

/** The raw per-day shape the SQL returns, before pre-history is applied. */
export interface TrendRow {
  date: string;
  dau: number;
  wau: number;
  mau: number;
  events: number;
}

/**
 * Apply the pre-history rule to a raw day series. Pure — no database, no clock.
 *
 * Extracted as its own seam (the same discipline scale.ts and kpi.ts use) because the
 * property that matters most here cannot be asserted reliably against a shared test
 * database: that a day AFTER the first event with no traffic still reports a REAL,
 * VISIBLE 0. That zero is the traffic-cliff signal these charts exist to catch;
 * swallowing it into "no data" would be a worse bug than the flat-zero pre-history
 * line this change removes, and it is exactly the failure an over-broad fix produces.
 * Keeping the rule pure lets that case be pinned down deterministically.
 *
 * @param firstEventMs Epoch-ms of the oldest analytics_event, or null when the table
 *   is empty — in which case NOTHING is suppressed and the output is byte-for-byte the
 *   pre-H1 behaviour.
 */
export function buildTrendPoints(rows: TrendRow[], firstEventMs: number | null): TrendPoint[] {
  return rows.map((r) => {
    // 'day' grain: these buckets ARE calendar days, so the shared rule applies as-is.
    const preHistory = isPreHistory(r.date, 'day', firstEventMs);
    return {
      date: r.date,
      preHistory,
      // Null and 0 are different claims. `?? 0` stays on the non-pre-history path so a
      // measurable day with no rows keeps reporting the real zero it measured.
      dau: preHistory ? null : r.dau ?? 0,
      wau: preHistory ? null : r.wau ?? 0,
      mau: preHistory ? null : r.mau ?? 0,
      events: preHistory ? null : r.events ?? 0,
    };
  });
}

/**
 * Per-day active-user trend over the trailing `days` calendar days (UTC), plus each
 * day's raw activity volume.
 *
 * DAU(d)   = distinct user_or_session with an event *on* day d.
 * WAU(d)   = distinct user_or_session in the trailing WAU_WINDOW_DAYS ending on day d.
 * MAU(d)   = distinct user_or_session in the trailing MAU_WINDOW_DAYS ending on day d.
 * events(d)= count of all analytics_event rows on day d.
 *
 * `generate_series` produces one row per calendar day so days with no activity are
 * zero-filled (a real, gap-free trend line rather than a chart with holes). The
 * per-day rolling DISTINCT counts are computed with correlated sub-selects; blank/
 * null actor ids are excluded so a malformed row can't inflate a distinct count,
 * exactly as getActiveUsers() in kpi.ts does. Bounds are half-open [start, end) on
 * an explicit ::timestamptz cast so the buckets are unambiguous and never
 * double-count a midnight boundary.
 *
 * The pre-history anchor — `min(analytics_event.created_at)` — is read in the SAME
 * statement as a scalar sub-select rather than as a second round trip, so the anchor
 * and the buckets can never be read from two different instants and disagree at the
 * edge. It is the identical definition getDataCoverage() uses for `firstEventAt`.
 */
export async function getActivityTrend(days: number = TREND_WINDOW_DAYS): Promise<ActivityTrend> {
  // Clamp to a sane, bounded window — never let a caller ask for an unbounded scan.
  const windowDays = Number.isFinite(days) ? Math.min(120, Math.max(1, Math.trunc(days))) : TREND_WINDOW_DAYS;

  const rows = await queryWithTimeout<{
    date: string;
    dau: number;
    wau: number;
    mau: number;
    events: number;
    first_event_at: Date | null;
  }>(
    /*
     * ONE PASS OVER THE WINDOW, then everything derived from the result.
     *
     * ═══ WHAT THIS REPLACED, AND WHY ═══
     * This query used to run FIVE correlated subqueries PER DAY — 30 days × (dau, wau, mau,
     * events) plus a re-evaluated anchor — each filtering analytics_event by a created_at range
     * with no event_type predicate. That is ~120 scans of the whole table per page load. It hung
     * /admin/operating and /admin/product-health indefinitely in production (>55s, caught live in
     * pg_stat_activity on wait_event=DataFileRead).
     *
     * `scan` reads the window ONCE and collapses it to (day, session, count). On real data that
     * intermediate is tiny — production has ~6.5k distinct sessions and averages 1.0 active days
     * per session, so a 1.19M-row table becomes a ~6k-row relation that the per-day aggregates
     * below run over for free.
     *
     * ═══ MEASURED, on a fixture built to production's ACTUAL cardinalities ═══
     *     old query, no index                70.5 s
     *     old query + created_at index       36.1 s
     *     this query, no index               16.6 s
     *     this query + created_at index       1.5 s
     * Both halves are load-bearing; neither alone gets under the serverless ceiling. The index is
     * migration 0040.
     *
     * ⚠ A COVERING INDEX IS NOT NEEDED — tested, 3% on the slower shape and nothing on this one.
     *
     * ⚠ THE WINDOW IS ($1-1)+($3-1) DAYS DEEP, NOT $1. MAU for the OLDEST day in the series
     * reaches back another MAU_WINDOW_DAYS-1 days before it. Narrowing `scan` to $1 days would
     * silently under-count MAU on the early rows rather than fail.
     *
     * NULLIF(user_or_session,'') collapses the old `IS NOT NULL AND <> ''` pair into one value, so
     * the per-day aggregates below only have to test for NULL.
     *
     * ═══ THE 2026-09-22 EXCLUSION — AND WHY IT LIVES PER-METRIC, NOT INSIDE `scan` ═══
     * lib/analytics/kpi.ts's getActiveUsers (the admin TILES) excludes any actor with a
     * search_minute_request_count row at/above ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD from
     * DAU/WAU/MAU entirely — see that migration's (0052) and module's (search-rate-limit.ts)
     * headers for the full incident context. This query is the trend LINE plotted right next to
     * those same tiles (app/admin/product-health/page.tsx renders both).
     *
     * A first version of this fix put the `NOT EXISTS` inside `scan` itself, using `scan`'s own
     * WHERE bound — which is WIDER than any single day's own window (see the "$1-1)+($3-1) DAYS
     * DEEP" note above: it exists so the OLDEST plotted day still has its full MAU lookback, not
     * because that width is ever the right EXCLUSION window for any one day). A second, fully
     * independent review (2dfdbb2c) reproduced the consequence on real Postgres: an actor flagged
     * 40 days ago, active TODAY with ordinary traffic, was counted by kpi.ts's tiles (40 days is
     * outside ITS 30-day window) and excluded by this trend line (40 days was inside `scan`'s
     * ~58-day window) — the tiles/trend-line discrepancy this incident is about wasn't fixed, it
     * inverted. Hand-copying the same predicate with whatever window happened to be lying around
     * is exactly how that happened, so the fix is not "widen or narrow the one NOT EXISTS" — it
     * is to stop checking the exclusion against `scan`'s convenience window at all.
     *
     * `flagged` (below) finds every (day, actor) pair that EVER crossed the threshold anywhere in
     * `scan`'s wide span — cheap, and correctness-neutral: it is only a CANDIDATE list. Each of
     * dau/wau/mau/events then checks `flagged` with EXACTLY the same window its own WHERE already
     * uses (day: `f.d = d.day`; wau/mau: `f.d <= d.day AND f.d > d.day - $2`/`$3`, byte-identical
     * to the sibling `scan` conditions two lines above each) — generated by
     * highFrequencyExclusionAgainstFlagged (lib/analytics/high-frequency-exclusion.ts) so the
     * WORDING cannot vary by hand-typing even though the WINDOW correctly does, per metric. A
     * session that produced even one qualifying row is excluded from DAU/WAU/MAU/events for every
     * day THAT SPECIFIC metric's own window actually covers it — not "the whole 30-day series
     * uniformly", which is what caused the bug in the first place.
     */
    `
    WITH days AS (
      SELECT gs::date AS day
      FROM generate_series(
        date_trunc('day', now()) - (($1::int - 1) * interval '1 day'),
        date_trunc('day', now()),
        interval '1 day'
      ) AS gs
    ),
    scan AS (
      SELECT date_trunc('day', e.created_at)::date AS d,
             NULLIF(e.user_or_session, '') AS u,
             count(*)::int AS n
        FROM analytics_event e
       WHERE e.created_at >= date_trunc('day', now())
                             - ((($1::int - 1) + ($3::int - 1)) * interval '1 day')
         AND e.created_at <  date_trunc('day', now()) + interval '1 day'
       GROUP BY 1, 2
    ),
    flagged AS (${highFrequencyFlaggedDaysCte({
      scanWindowSql:
        "e.created_at >= date_trunc('day', now()) - ((($1::int - 1) + ($3::int - 1)) * interval '1 day') AND e.created_at < date_trunc('day', now()) + interval '1 day'",
      dayExpr: "date_trunc('day', e.created_at)::date",
      thresholdParam: '$4',
    })}
    ),
    anchor AS (SELECT min(created_at) AS first_event_at FROM analytics_event)
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      (SELECT first_event_at FROM anchor) AS first_event_at,
      (SELECT count(*)::int FROM scan s
        WHERE s.u IS NOT NULL AND s.d = d.day
          AND ${highFrequencyExclusionAgainstFlagged({
            actorAlias: 's',
            actorColumn: 'u',
            dayColumn: 'd',
            dayWindowSql: 'f.d = d.day',
          })}) AS dau,
      (SELECT count(DISTINCT s.u)::int FROM scan s
        WHERE s.u IS NOT NULL AND s.d <= d.day AND s.d > d.day - $2::int
          AND ${highFrequencyExclusionAgainstFlagged({
            actorAlias: 's',
            actorColumn: 'u',
            dayColumn: 'd',
            dayWindowSql: 'f.d <= d.day AND f.d > d.day - $2::int',
          })}) AS wau,
      (SELECT count(DISTINCT s.u)::int FROM scan s
        WHERE s.u IS NOT NULL AND s.d <= d.day AND s.d > d.day - $3::int
          AND ${highFrequencyExclusionAgainstFlagged({
            actorAlias: 's',
            actorColumn: 'u',
            dayColumn: 'd',
            dayWindowSql: 'f.d <= d.day AND f.d > d.day - $3::int',
          })}) AS mau,
      COALESCE((SELECT sum(s.n)::int FROM scan s
        WHERE s.d = d.day
          AND ${highFrequencyExclusionAgainstFlagged({
            actorAlias: 's',
            actorColumn: 'u',
            dayColumn: 'd',
            dayWindowSql: 'f.d = d.day',
          })}), 0) AS events
    FROM days d
    ORDER BY d.day
    `,
    [windowDays, WAU_WINDOW_DAYS, MAU_WINDOW_DAYS, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD],
    adminAnalyticsQueryTimeoutMs()
  );

  // The anchor is the same scalar on every row (a correlated-free sub-select), so any
  // row carries it. An empty table yields null → isPreHistory() suppresses NOTHING and
  // the series is byte-for-byte what it was before H1: all real, all zero.
  const firstEventRaw = rows[0]?.first_event_at ?? null;
  const firstEventMs = firstEventRaw ? anchorMsFromIso(new Date(firstEventRaw).toISOString()) : null;

  const points = buildTrendPoints(rows, firstEventMs);

  return {
    days: points.length,
    windows: { wauDays: WAU_WINDOW_DAYS, mauDays: MAU_WINDOW_DAYS },
    points,
  };
}
