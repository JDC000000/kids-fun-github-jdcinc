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
import { query } from '@/lib/db/client';
import { WAU_WINDOW_DAYS, MAU_WINDOW_DAYS } from './kpi';
import { anchorMsFromIso, isPreHistory } from './prehistory';

/** How many trailing calendar days the trend charts plot by default. */
export const TREND_WINDOW_DAYS = 30;

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

  const rows = await query<{
    date: string;
    dau: number;
    wau: number;
    mau: number;
    events: number;
    first_event_at: Date | null;
  }>(
    `
    WITH days AS (
      SELECT gs::date AS day
      FROM generate_series(
        date_trunc('day', now()) - (($1::int - 1) * interval '1 day'),
        date_trunc('day', now()),
        interval '1 day'
      ) AS gs
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      (SELECT min(created_at) FROM analytics_event) AS first_event_at,
      (
        SELECT count(DISTINCT e.user_or_session)::int
        FROM analytics_event e
        WHERE e.user_or_session IS NOT NULL AND e.user_or_session <> ''
          AND e.created_at >= d.day::timestamptz
          AND e.created_at <  d.day::timestamptz + interval '1 day'
      ) AS dau,
      (
        SELECT count(DISTINCT e.user_or_session)::int
        FROM analytics_event e
        WHERE e.user_or_session IS NOT NULL AND e.user_or_session <> ''
          AND e.created_at >= d.day::timestamptz - (($2::int - 1) * interval '1 day')
          AND e.created_at <  d.day::timestamptz + interval '1 day'
      ) AS wau,
      (
        SELECT count(DISTINCT e.user_or_session)::int
        FROM analytics_event e
        WHERE e.user_or_session IS NOT NULL AND e.user_or_session <> ''
          AND e.created_at >= d.day::timestamptz - (($3::int - 1) * interval '1 day')
          AND e.created_at <  d.day::timestamptz + interval '1 day'
      ) AS mau,
      (
        SELECT count(*)::int
        FROM analytics_event e
        WHERE e.created_at >= d.day::timestamptz
          AND e.created_at <  d.day::timestamptz + interval '1 day'
      ) AS events
    FROM days d
    ORDER BY d.day
    `,
    [windowDays, WAU_WINDOW_DAYS, MAU_WINDOW_DAYS]
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
