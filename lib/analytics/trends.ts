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
import { query } from '@/lib/db/client';
import { WAU_WINDOW_DAYS, MAU_WINDOW_DAYS } from './kpi';

/** How many trailing calendar days the trend charts plot by default. */
export const TREND_WINDOW_DAYS = 30;

/** One day of the trend: the active-user windows *as of that day* + that day's raw volume. */
export interface TrendPoint {
  /** UTC calendar day, 'YYYY-MM-DD'. */
  date: string;
  /** Distinct actors active on this day (rolling 1-day / DAU). */
  dau: number;
  /** Distinct actors active in the trailing WAU_WINDOW_DAYS ending this day. */
  wau: number;
  /** Distinct actors active in the trailing MAU_WINDOW_DAYS ending this day. */
  mau: number;
  /** All analytics_event rows recorded on this day (activity volume). */
  events: number;
}

export interface ActivityTrend {
  /** The number of days plotted (length of `points`). */
  days: number;
  /** WAU/MAU rolling-window sizes echoed for the chart caption/legend. */
  windows: { wauDays: number; mauDays: number };
  /** Oldest→newest. Always `days` long, one entry per calendar day, gaps zero-filled. */
  points: TrendPoint[];
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
 */
export async function getActivityTrend(days: number = TREND_WINDOW_DAYS): Promise<ActivityTrend> {
  // Clamp to a sane, bounded window — never let a caller ask for an unbounded scan.
  const windowDays = Number.isFinite(days) ? Math.min(120, Math.max(1, Math.trunc(days))) : TREND_WINDOW_DAYS;

  const rows = await query<{ date: string; dau: number; wau: number; mau: number; events: number }>(
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

  const points: TrendPoint[] = rows.map((r) => ({
    date: r.date,
    dau: r.dau ?? 0,
    wau: r.wau ?? 0,
    mau: r.mau ?? 0,
    events: r.events ?? 0,
  }));

  return {
    days: points.length,
    windows: { wauDays: WAU_WINDOW_DAYS, mauDays: MAU_WINDOW_DAYS },
    points,
  };
}
