// lib/analytics/high-frequency-exclusion.ts — the ONE shared definition of "is this actor
// excluded as high-frequency (bot-like) traffic", used by every read-side module that counts
// distinct actors from analytics_event: kpi.ts (getActiveUsers, getAccountValue), trends.ts
// (getActivityTrend), operating.ts (getEngagementSeries, getLifecycleSeries).
//
// ═══ WHY THIS EXISTS — THE BUG IT REPLACES ═══
// 2026-09-22: kpi.ts's getActiveUsers and trends.ts's getActivityTrend each hand-wrote their own
// copy of the same NOT EXISTS predicate. The WORDING was identical; the WINDOW was not —
// kpi.ts checked a subject's flagged rows within its own exact N-day window, while trends.ts's
// per-day scan CTE only had a WIDER "scan once" window lying around (needed so one query could
// produce every plotted day's rolling MAU, not because that width was ever the right exclusion
// window for any SINGLE day's own metric) and the copy-pasted predicate used THAT window instead
// of re-deriving the correct one per day. Reproduced on real Postgres: an actor flagged 40 days
// ago, active today with ordinary traffic, was COUNTED by kpi.ts's tiles (40 days is outside its
// 30-day window) and EXCLUDED by trends.ts's trend line (40 days is inside its ~58-day scan
// window) — the tiles/trend-line discrepancy this incident is about wasn't fixed, it inverted.
//
// Sharing a threshold CONSTANT (ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD, in
// lib/security/search-rate-limit.ts) was not enough: the constant can't stop two hand-written
// copies of the SURROUNDING predicate from disagreeing about what window it applies over. This
// module makes the WORDING itself generated, not hand-typed, and — the actual fix, not a
// formality — puts a documented, load-bearing REQUIREMENT in front of every caller: pass the
// exact window the metric being computed uses, never a wider convenience bound a query happens
// to have lying around for an unrelated reason.
//
// ═══ WHY A SQL-TEXT GENERATOR, NOT A DATABASE VIEW OR FUNCTION ═══
// The correct window varies per caller and even per OUTPUT ROW (trends.ts needs a different
// window for every plotted day's DAU vs WAU vs MAU). A view has no parameters; a set-returning
// SQL function called once per output row (e.g. via LATERAL) would reintroduce exactly the
// "one correlated read per row" cost this repo's read-side modules have each independently
// fixed at least once (see trends.ts's and operating.ts's own extensive measured-regression
// comments). Generating the SQL TEXT keeps every caller's query a single statement Postgres
// plans as a whole — callers correlating against `analytics_event` directly get an ordinary
// (often planner-flattened, see the anti-join note below) correlated subquery; trends.ts AND
// operating.ts (both have PER-BUCKET/PER-DAY metrics sharing one wider scan-once window — see
// `highFrequencyExclusionAgainstRaw`'s own docstring below for why that disqualifies them from
// the raw form) correlate against their OWN small `flagged` pre-aggregation instead (see
// `highFrequencyExclusionAgainstFlagged` below) for the identical reason trends.ts's `scan`
// itself exists: so a per-bucket check touches a bounded, tiny relation, never the whole event
// table again.
//
// ═══ NOT EXISTS vs ANTI-JOIN ═══
// `highFrequencyExclusionAgainstRaw` emits `NOT EXISTS`, matching kpi.ts's already-tested,
// already-measured form (verified via EXPLAIN to correlate correctly and use
// idx_analytics_event_high_frequency as a Merge Anti Join — see lib/analytics/kpi.ts's
// getAccountValue). Postgres's planner already turns a simple, uncorrelated-beyond-one-column
// NOT EXISTS like this into an anti join on its own; there is no separate "faster" LEFT JOIN
// form worth hand-maintaining here.
import { ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD } from '@/lib/security/search-rate-limit';

export { ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD };

export interface RawExclusionOptions {
  /** The alias (or bare table name) of the OUTER row being tested, e.g. 'ae', 's', 'si'. Must
   *  already be in scope at the point this SQL is spliced in. */
  actorAlias: string;
  /** Column on `actorAlias` holding the actor id. Defaults to 'user_or_session'. */
  actorColumn?: string;
  /**
   * Raw SQL boolean expression bounding the internal `hf.created_at`, referencing `hf` and
   * whatever CTEs/params the caller's own query already has in scope (e.g.
   * "hf.created_at >= now() - ($3::int * interval '1 day')" or "hf.created_at >= b.lo AND
   * hf.created_at < b.hi").
   *
   * ⚠ LOAD-BEARING CONTRACT, NOT A STYLE CHOICE: this MUST be the exact same window the calling
   * query uses to decide whether `actorAlias`'s OWN row counts toward the metric being computed
   * — never a wider bound the query happens to have lying around (a "scan once" convenience
   * window, a padding window for an adjacent computation, etc.). A caller with a per-output-row
   * varying window (see trends.ts) cannot use this function at all — see
   * `highFrequencyExclusionAgainstFlagged` for that shape instead.
   */
  windowSql: string;
  /** SQL parameter placeholder for the threshold, e.g. '$4'. Callers pass
   *  ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD (re-exported above) as that parameter's VALUE — this
   *  function only emits the placeholder reference, never the number itself, so every caller's
   *  own parameter array is what actually binds it (keeping this a pure text generator with no
   *  runtime dependency of its own). */
  thresholdParam: string;
}

/**
 * The exclusion predicate for a caller correlating directly against raw `analytics_event` under
 * a SINGLE window shared by the WHOLE query (kpi.ts's getActiveUsers/getAccountValue — one
 * window for the whole statement, with dau/wau/mau all derived from the same excluded-actor set
 * afterward, never a window that varies by output row/metric).
 *
 * ⚠ operating.ts's getEngagementSeries/getLifecycleSeries do NOT use this one, even though their
 * own `bounds` CTE looks like a single window at first glance: `bounds` spans the WHOLE requested
 * period range (e.g. all 30 days), while active_actors/signed_in_actors/seen are PER-PERIOD
 * metrics — one independent count per bucket, the same shape as trends.ts's per-day DAU. That
 * makes `bounds` a scan-once convenience window, not any one bucket's own window (identical
 * reasoning to why trends.ts can't use this function either) — see `highFrequencyExclusionAgainstFlagged`
 * below, which both of them use instead.
 */
export function highFrequencyExclusionAgainstRaw(opts: RawExclusionOptions): string {
  const actorColumn = opts.actorColumn ?? 'user_or_session';
  return `NOT EXISTS (
                     SELECT 1 FROM analytics_event hf
                      WHERE hf.${actorColumn} = ${opts.actorAlias}.${actorColumn}
                        AND ${opts.windowSql}
                        AND hf.search_minute_request_count >= ${opts.thresholdParam}
                   )`;
}

export interface FlaggedDaysCteOptions {
  /** Raw SQL boundING the scan — the SAME wide window the caller's own per-day pre-aggregation
   *  (e.g. trends.ts's `scan`) already reads, referencing `e.created_at`. This CTE only needs to
   *  find every (day, actor) pair that EVER crossed the threshold anywhere in that broad span;
   *  narrowing to any ONE day's correct window happens later, per output row, in
   *  `highFrequencyExclusionAgainstFlagged` — that split is what fixes the 2026-09-22 bug: the
   *  wide scan window is fine for finding candidates, it was only ever wrong to use as the
   *  EXCLUSION window for every day uniformly. */
  scanWindowSql: string;
  /** How the day bucket is derived from `e.created_at`, e.g. "date_trunc('day', e.created_at)::date". */
  dayExpr: string;
  thresholdParam: string;
}

/** The `flagged` CTE body: every (day, actor) pair that crossed the threshold at least once that
 *  day, within the caller's own wide scan window. Deliberately SMALL and cheap regardless of
 *  analytics_event's size — the same reason trends.ts's `scan` itself exists (see that module's
 *  header): a per-day correlated check against THIS relation, not against raw analytics_event
 *  again, is what keeps per-day exclusion checks fast. */
export function highFrequencyFlaggedDaysCte(opts: FlaggedDaysCteOptions): string {
  return `
      SELECT ${opts.dayExpr} AS d,
             NULLIF(e.user_or_session, '') AS u
        FROM analytics_event e
       WHERE ${opts.scanWindowSql}
         AND e.search_minute_request_count >= ${opts.thresholdParam}
       GROUP BY 1, 2`;
}

export interface FlaggedExclusionOptions {
  /** Alias of the pre-aggregated per-day/per-bucket relation being tested (e.g. trends.ts's `s`
   *  from `scan`, or operating.ts's `e` from its own per-bucket subquery). */
  actorAlias: string;
  /** Column on `actorAlias` holding the actor id in the pre-aggregated relation. */
  actorColumn: string;
  /** Column on `actorAlias` holding that row's day bucket. */
  dayColumn: string;
  /** Alias the `flagged` CTE (built via `highFrequencyFlaggedDaysCte`) is referenced under in
   *  this query, default 'flagged'. */
  flaggedCteName?: string;
  /**
   * Raw SQL boolean expression bounding `f.d` against `${actorAlias}.${dayColumn}` — THIS is
   * where the correct window finally applies. Must match the calling query's OWN window bound
   * exactly, for the identical reason `RawExclusionOptions.windowSql` must.
   *
   * ⚠ 2026-09-22, SECOND version of this bug (caught by two independent reviewers, 0bab6a97 and
   * 6f176ae2): trends.ts's dau/wau/mau/events used to each pass a DIFFERENT dayWindowSql here —
   * `f.d = d.day` for dau, `f.d <= d.day AND f.d > d.day - $2::int` for wau, `...$3::int` for mau
   * — matching each metric's own DISPLAY period. That sounds principled but is not what kpi.ts's
   * tiles do: kpi.ts excludes over ONE shared MAU-width window and derives dau/wau/mau from what
   * survives, so a per-metric window here (a) disagreed with kpi.ts's tiles on dau/wau specifically
   * (an actor flagged 10 days ago sits inside kpi.ts's 30-day window but outside dau's 1-day/wau's
   * 7-day windows) and (b) broke the dau <= wau <= mau invariant (a wider window, mau, could
   * exclude an actor a narrower one, dau, did not). The fix: every metric passes the SAME
   * dayWindowSql — day D's trailing MAU-width window — reproducing kpi.ts's one-shared-window
   * shape per plotted day. Do not let a future caller reintroduce a narrower per-metric window
   * here "to match that metric's own period" — that is precisely this bug.
   */
  dayWindowSql: string;
}

/** The exclusion predicate for a caller correlating against a `flagged` pre-aggregation (built
 *  via `highFrequencyFlaggedDaysCte`) instead of raw `analytics_event` — trends.ts's per-day
 *  DAU/WAU/MAU/events sub-selects (all sharing ONE window per day, see `dayWindowSql` above) and
 *  operating.ts's per-bucket active_actors/signed_in_actors/seen (each bucket its own window). */
export function highFrequencyExclusionAgainstFlagged(opts: FlaggedExclusionOptions): string {
  const flaggedCteName = opts.flaggedCteName ?? 'flagged';
  return `NOT EXISTS (
               SELECT 1 FROM ${flaggedCteName} f
                WHERE f.u = ${opts.actorAlias}.${opts.actorColumn}
                  AND ${opts.dayWindowSql}
             )`;
}
