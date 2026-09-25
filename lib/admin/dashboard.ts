// lib/admin/dashboard.ts — read-only data access for the internal admin/health
// dashboard (M5, first slice). Server-only: uses the shared service-level pg pool
// (lib/db/client). Every statement here is a SELECT; nothing mutates. Numbers come
// straight from the same tables the ingestion worker and analytics writer populate,
// so the dashboard reflects the live database, not a fixture.
import { query, queryWithTimeout } from '@/lib/db/client';
import { shouldRedact, type PersonalDataOptions } from './personal-data';
import { adminAnalyticsQueryTimeoutMs } from '@/lib/db/budgets';

export interface IngestionSourceHealth {
  sourceId: string;
  name: string;
  family: string;
  termsStatus: string;
  robotsStatus: string;
  healthState: string;
  /** source.last_check_at — set by the worker; may lag behind actual runs. */
  lastCheckAt: string | null;
  /** Ground truth: most recent CLEAN success/partial run (no health verdict) from source_check_run. */
  lastSuccessfulCheckAt: string | null;
  latestRunStatus: string | null;
  latestRunRecordsFound: number | null;
  latestRunStartedAt: string | null;
  latestRunDurationMs: number | null;
  seriesCount: number;
  occurrenceCount: number;
}

export interface SourceRegistrySummary {
  totalSources: number;
  enabledSources: number;
}

/**
 * One ingest run an operator needs to look at, for the dashboard's "Runs needing attention"
 * list. TWO kinds qualify (F-11):
 *   • the run FAILED outright (status = 'failed'), and
 *   • the run's adapter raised a health verdict (health_alert_code IS NOT NULL) — shape_drift,
 *     phone_rejection_spike, coverage_shortfall, … — regardless of the run's status.
 *
 * That second kind is why this is no longer "recent failures". An alerting run typically
 * upserts occurrences perfectly well and lands as 'partial' or even 'success', so a panel
 * keyed on status alone showed none of them and every health verdict this project raises
 * reached nobody. It is keyed on the ALERT, not on a widened status set, precisely so an
 * ordinary partial run (a handful of bad records) does not flood the panel — see the
 * decision note on AdapterRunDiagnostics in worker/core/adapter.ts.
 */
export interface RunNeedingAttention {
  checkRunId: string;
  sourceId: string;
  sourceName: string;
  family: string;
  startedAt: string | null;
  durationMs: number | null;
  /** The run's own status — 'failed', or 'partial'/'success' for an alert-only row. */
  status: string;
  /** AdapterRunDiagnostics.code when this run raised a health verdict; null for a plain failure. */
  healthAlertCode: string | null;
  /** AdapterRunDiagnostics.detail for that verdict; null when there is no alert. */
  healthAlertDetail: string | null;
  /** First error string from source_check_run.errors (a jsonb string[]); null if none captured. */
  errorSummary: string | null;
  /** Total errors recorded on that run (array length), or null if errors isn't an array. */
  errorCount: number | null;
}

/** An enabled source that hasn't had a successful check within its expected cadence. */
export interface StaleSource {
  sourceId: string;
  name: string;
  family: string;
  /** COALESCE(near_date_cadence, baseline_cadence) in seconds — the scheduler's expected interval. */
  cadenceSeconds: number | null;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

/** Operational problems only — the "something is wrong" view the healthy-count tiles don't show. */
export interface HealthAlerts {
  runsNeedingAttention: RunNeedingAttention[];
  staleSources: StaleSource[];
  /** How many days back the attention-runs window spans (for the UI copy). */
  windowDays: number;
}

export interface AnalyticsSummary {
  /**
   * How many days of history every field below EXCEPT `last7Days` was computed over.
   * Returned so the page can state it: these used to be all-time and are now windowed
   * (see ANALYTICS_ROLLUP_WINDOW_DAYS), and a number whose meaning changed silently is a
   * worse dashboard than a slow one.
   */
  windowDays: number;
  totalEvents: number;
  listingViewed: number;
  /** Count of `search_performed` events — what parents actually searched/browsed. */
  searchPerformed: number;
  byType: { eventType: string; count: number }[];
  topListings: { label: string; occurrenceId: string | null; views: number }[];
  last7Days: { day: string; count: number }[];
  /** Most common query WORDS across all searches (stopwords + <3-char tokens dropped). */
  topQueryTerms: { term: string; count: number }[];
  /** Most-used region chips across all searches (raw chip ids, e.g. 'van'). */
  topSearchRegions: { region: string; count: number }[];
  /** Most-used non-region filter tokens (e.g. 'free', 'when:weekend', 'age:5-9'). */
  topSearchFilters: { filter: string; count: number }[];
}

/** One parent-submitted "Report wrong info" correction, for the dashboard's
 *  "Corrections reported" list. Read-only visibility for an operator/triager —
 *  the eventual triage workflow (resolve/archive) is Screen 7's data-health slice. */
export interface RecentCorrection {
  id: string;
  occurrenceId: string;
  /** activity_occurrence.activity_name, or null if the occurrence was since removed. */
  activityName: string | null;
  issueType: string;
  note: string | null;
  status: string;
  createdAt: string | null;
}

/** A recent correction as a page may render it: the note NULLed unless the viewer may see it. */
export interface DisplayedCorrection extends RecentCorrection {
  redacted: boolean;
  hasNote: boolean;
}

/**
 * The render-layer GUARD for the recent-corrections list: `note` is free text typed by a member of
 * the public (lib/snapshot/policy.ts classes it as PII), NULLed here for a read-only 'viewer'.
 *
 * This is the SECOND line, not the first (QA M1, 2026-09-25). A viewer's list is already redacted IN
 * SQL — getRecentCorrections({ redactPersonalData: true }) — on /admin/data-health (live query) and
 * on /admin/dashboard, which reads a viewer's list live instead of from the role-independent
 * snapshot. This guard then runs on whatever list a page is about to render, so a future edit that
 * wires the wrong list in still cannot put a note on a viewer's screen. `hasNote` is taken from the
 * SQL row when it has one (the note is already NULL there), else derived from the note.
 * Pinned by a full render over a real database: tests/admin/viewer-render-db.test.ts.
 */
export function correctionsForDisplay(
  list: readonly RecentCorrection[],
  opts: PersonalDataOptions
): DisplayedCorrection[] {
  const redact = shouldRedact(opts);
  return list.map((c) => ({
    ...c,
    note: redact ? null : c.note,
    redacted: redact,
    hasNote:
      'hasNote' in c && typeof (c as DisplayedCorrection).hasNote === 'boolean'
        ? (c as DisplayedCorrection).hasNote
        : typeof c.note === 'string' && c.note.length > 0,
  }));
}

export interface AdminDashboardData {
  generatedAt: string;
  registry: SourceRegistrySummary;
  ingestion: IngestionSourceHealth[];
  analytics: AnalyticsSummary;
  alerts: HealthAlerts;
  corrections: RecentCorrection[];
}

/** "Enabled/live" source = terms reviewed and allowed (terms_status = 'allowed'). */
export const ENABLED_TERMS_STATUS = 'allowed';

/** How far back the "runs needing attention" list looks. */
export const ATTENTION_RUN_WINDOW_DAYS = 7;
/** Cap on rows in the attention-runs list (dashboard is a scan, not a log viewer). */
export const ATTENTION_RUN_LIMIT = 20;

/**
 * SQL predicate for a CLEAN successful run — one that both completed AND carried no health
 * verdict. This is what "last successful check" and every success ratio must mean (F-11):
 * a run whose adapter raised shape_drift or phone_rejection_spike did NOT deliver a
 * trustworthy refresh, so counting it as a success made the board report better numbers than
 * the data deserved.
 *
 * Assumes the source_check_run table is aliased `cr`.
 *
 * MUST STAY BYTE-IDENTICAL to worker/health/sla.ts CLEAN_SUCCESS_RUN_SQL. The Next app cannot
 * import from worker/ (tsconfig excludes it, eslint ignores it), so the two read paths are
 * deliberately separate copies — exactly like SLA_CADENCE_GRACE / isCadenceAdherent above
 * them. tests/health/sla-consistency.test.ts pins both, so neither the grace constant nor
 * this predicate can drift without going red.
 */
export const CLEAN_SUCCESS_RUN_SQL = "cr.status IN ('success', 'partial') AND cr.health_alert_code IS NULL";
/** A source is "stale" once its last successful check is older than grace × its cadence.
 *  2 = one full missed cycle is tolerated (could be transient); two missed = a real problem. */
export const STALE_CADENCE_GRACE = 2;
/** Cap on rows in the "Corrections reported" list (the dashboard is a scan, not a queue). */
export const RECENT_CORRECTIONS_LIMIT = 20;
/** Fallback cadence when a source somehow has none configured (baseline is NOT NULL, so defensive). */
export const DEFAULT_CADENCE_SECONDS = 24 * 60 * 60;

/** Noise words dropped from the "most common query terms" frequency count. Kept small
 *  and domain-aware ('kids' is noise here — every listing is for kids). Not NLP: a plain
 *  stopword list, applied alongside a >=3-char minimum, per the task's "simple count". */
const QUERY_TERM_STOPWORDS = [
  'the', 'and', 'for', 'with', 'near', 'you', 'your', 'our', 'from', 'that', 'this',
  'kids', 'kid', 'any', 'are', 'has', 'have', 'get', 'about', 'not', 'find',
];

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Per-source ingestion health for the enabled sources. One query with lateral
 * subselects: series/occurrence counts attributed via activity_series.source_id,
 * the latest check run, and the last successful run time.
 */
export async function getIngestionHealth(): Promise<IngestionSourceHealth[]> {
  const rows = await query<{
    id: string;
    name: string;
    family: string;
    terms_status: string;
    robots_status: string;
    health_state: string;
    last_check_at: Date | null;
    series_count: number;
    occurrence_count: number;
    latest_status: string | null;
    latest_records_found: number | null;
    latest_started_at: Date | null;
    latest_duration_ms: number | null;
    last_success_at: Date | null;
  }>(
    `
    SELECT
      s.id,
      s.name,
      s.family,
      s.terms_status,
      s.robots_status,
      s.health_state,
      s.last_check_at,
      series.series_count,
      occ.occurrence_count,
      latest.status        AS latest_status,
      latest.records_found AS latest_records_found,
      latest.started_at    AS latest_started_at,
      latest.duration_ms   AS latest_duration_ms,
      success.last_success_at
    FROM source s
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS series_count
      FROM activity_series ser
      WHERE ser.source_id = s.id
    ) series ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS occurrence_count
      FROM activity_occurrence o
      JOIN activity_series ser ON ser.id = o.series_id
      WHERE ser.source_id = s.id AND o.archived_at IS NULL
    ) occ ON true
    LEFT JOIN LATERAL (
      SELECT status, records_found, started_at, duration_ms
      FROM source_check_run cr
      WHERE cr.source_id = s.id
      ORDER BY cr.started_at DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT max(started_at) AS last_success_at
      FROM source_check_run cr
      WHERE cr.source_id = s.id AND ${CLEAN_SUCCESS_RUN_SQL}
    ) success ON true
    WHERE s.terms_status = $1
    ORDER BY s.name
    `,
    [ENABLED_TERMS_STATUS]
  );

  return rows.map((r) => ({
    sourceId: r.id,
    name: r.name,
    family: r.family,
    termsStatus: r.terms_status,
    robotsStatus: r.robots_status,
    healthState: r.health_state,
    lastCheckAt: toIso(r.last_check_at),
    lastSuccessfulCheckAt: toIso(r.last_success_at),
    latestRunStatus: r.latest_status,
    latestRunRecordsFound: r.latest_records_found,
    latestRunStartedAt: toIso(r.latest_started_at),
    latestRunDurationMs: r.latest_duration_ms,
    seriesCount: r.series_count ?? 0,
    occurrenceCount: r.occurrence_count ?? 0,
  }));
}

/** Registry totals: how many sources exist and how many are enabled. */
export async function getSourceRegistrySummary(): Promise<SourceRegistrySummary> {
  const rows = await query<{ total: number; enabled: number }>(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE terms_status = $1)::int AS enabled
    FROM source
    `,
    [ENABLED_TERMS_STATUS]
  );
  const row = rows[0];
  return { totalSources: row?.total ?? 0, enabledSources: row?.enabled ?? 0 };
}

/**
 * How much history the dashboard's analytics rollups cover.
 *
 * ═══ WHY A BOUND EXISTS AT ALL, AND WHY IT IS THIS SMALL ═══
 * These six rollups had NO date predicate. They aggregated the whole of analytics_event on
 * every page load, and the table crossed 2.65M rows — so /admin/dashboard stopped responding
 * entirely (measured 2026-09-14: no response after 75s, HTTP 000). The `byType` grouping
 * alone took 42.2s, and the three jsonb/regexp tokenisers unnest a set-returning function
 * across every matching row, which no btree index can help.
 *
 * THREE DAYS, and the number comes from the data rather than from taste. analytics_event's
 * oldest row is 2026-07-21, so the table is only ~55 days old: a 30-day window would cover
 * 99.997% of it (2,651,229 of 2,651,302 rows) and change nothing. Measured against production:
 *
 *     byType             42.2s  ->  1.02s
 *     topSearchRegions    9.9s  ->  0.76s
 *
 * The bound uses idx_analytics_event_type_created (event_type, created_at DESC) and
 * idx_analytics_event_created_at, both of which already existed. No new index, no new
 * infrastructure — the queries simply stop reading history nobody asked for.
 *
 * ⚠ THIS CHANGES WHAT THE NUMBERS MEAN, so the page SAYS SO. `windowDays` is returned on
 * AnalyticsSummary and rendered into the tile labels and section headings. A dashboard that
 * quietly redefines "Analytics events" from all-time to three days is worse than a slow one,
 * because nothing on screen would tell the reader which question was answered.
 *
 * These reads also run under adminAnalyticsQueryTimeoutMs(). The bound is what makes them
 * fast; the timeout is what stops an abandoned request leaving one running anyway. Both,
 * not either — the bound is a prediction about cost, and the timeout is what holds when
 * the prediction is wrong.
 *
 * ⚠ DO NOT COPY THIS BOUND ONTO THE KPI QUERIES in lib/analytics/kpi.ts. Those are ALREADY
 * bounded, and their windows are the metric DEFINITIONS: MAU is 30 days because MAU means
 * 30 days. Shrinking that window does not make MAU faster, it replaces it — measured, MAU
 * reads 15,772 over its real window and 4,103 over three days, under the same label.
 */
export const ANALYTICS_ROLLUP_WINDOW_DAYS = 3;

/** Analytics rollups from analytics_event. Robust to an empty table (returns zeros). */
export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const totalsRows = await queryWithTimeout<{ total_events: number; listing_viewed: number; search_performed: number }>(
    `
    SELECT
      count(*)::int AS total_events,
      count(*) FILTER (WHERE event_type = 'listing_viewed')::int AS listing_viewed,
      count(*) FILTER (WHERE event_type = 'search_performed')::int AS search_performed
    FROM analytics_event
    WHERE created_at >= now() - ($1::int * interval '1 day')
    `,
    [ANALYTICS_ROLLUP_WINDOW_DAYS],
    adminAnalyticsQueryTimeoutMs()
  );
  const totals = totalsRows[0];

  const byType = await queryWithTimeout<{ event_type: string; count: number }>(
    `
    SELECT event_type, count(*)::int AS count
    FROM analytics_event
    WHERE created_at >= now() - ($1::int * interval '1 day')
    GROUP BY event_type
    ORDER BY count DESC, event_type
    `,
    [ANALYTICS_ROLLUP_WINDOW_DAYS],
    adminAnalyticsQueryTimeoutMs()
  );

  const topListings = await queryWithTimeout<{ label: string; occurrence_id: string | null; views: number }>(
    `
    SELECT
      coalesce(nullif(result_summary_json->>'activityName', ''), occurrence_id::text, '(unlabeled)') AS label,
      occurrence_id,
      count(*)::int AS views
    FROM analytics_event
    WHERE event_type = 'listing_viewed'
      AND created_at >= now() - ($1::int * interval '1 day')
    GROUP BY 1, occurrence_id
    ORDER BY views DESC, label
    LIMIT 10
    `,
    [ANALYTICS_ROLLUP_WINDOW_DAYS],
    adminAnalyticsQueryTimeoutMs()
  );

  const last7Days = await queryWithTimeout<{ day: string; count: number }>(
    `
    SELECT
      to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      count(*)::int AS count
    FROM analytics_event
    WHERE created_at >= now() - interval '7 days'
    GROUP BY 1
    ORDER BY 1
    `,
    undefined,
    adminAnalyticsQueryTimeoutMs()
  );

  // --- search analytics rollups (search_performed events) ----------------------
  // What parents actually search for. All three tokenise the jsonb fields the
  // /search page writes; each guards its set-returning function with a WHERE on
  // event_type (applied before the SELECT-list expansion) so a non-search or
  // legacy row can never error the query. Robust to an empty table (returns []).

  // Most common query WORDS. Split the raw query on non-alphanumerics, drop tokens
  // under 3 chars and a small stopword set, then frequency-count.
  const topQueryTerms = await queryWithTimeout<{ term: string; count: number }>(
    `
    SELECT term, count(*)::int AS count
    FROM (
      SELECT unnest(
        regexp_split_to_array(lower(coalesce(search_context_json->>'q', '')), '[^a-z0-9]+')
      ) AS term
      FROM analytics_event
      WHERE event_type = 'search_performed'
        AND created_at >= now() - ($2::int * interval '1 day')
    ) t
    WHERE length(term) >= 3
      AND term <> ALL ($1::text[])
    GROUP BY term
    ORDER BY count DESC, term
    LIMIT 15
    `,
    [QUERY_TERM_STOPWORDS, ANALYTICS_ROLLUP_WINDOW_DAYS],
    adminAnalyticsQueryTimeoutMs()
  );

  // Most-used region chips (search_context_json.regions is a string array).
  const topSearchRegions = await queryWithTimeout<{ region: string; count: number }>(
    `
    SELECT region, count(*)::int AS count
    FROM (
      SELECT jsonb_array_elements_text(search_context_json->'regions') AS region
      FROM analytics_event
      WHERE event_type = 'search_performed'
        AND created_at >= now() - ($1::int * interval '1 day')
        AND jsonb_typeof(search_context_json->'regions') = 'array'
    ) t
    GROUP BY region
    ORDER BY count DESC, region
    LIMIT 10
    `,
    [ANALYTICS_ROLLUP_WINDOW_DAYS],
    adminAnalyticsQueryTimeoutMs()
  );

  // Most-used non-region filter tokens (search_context_json.filters is a string array).
  // Alias the unnested value `token` (not `filter`) — FILTER is a SQL keyword and a bare
  // `filter` alias is a parser landmine right after a set-returning function.
  const topSearchFilters = await queryWithTimeout<{ token: string; count: number }>(
    `
    SELECT token, count(*)::int AS count
    FROM (
      SELECT jsonb_array_elements_text(search_context_json->'filters') AS token
      FROM analytics_event
      WHERE event_type = 'search_performed'
        AND created_at >= now() - ($1::int * interval '1 day')
        AND jsonb_typeof(search_context_json->'filters') = 'array'
    ) t
    GROUP BY token
    ORDER BY count DESC, token
    LIMIT 15
    `,
    [ANALYTICS_ROLLUP_WINDOW_DAYS],
    adminAnalyticsQueryTimeoutMs()
  );

  return {
    windowDays: ANALYTICS_ROLLUP_WINDOW_DAYS,
    totalEvents: totals?.total_events ?? 0,
    listingViewed: totals?.listing_viewed ?? 0,
    searchPerformed: totals?.search_performed ?? 0,
    byType: byType.map((r) => ({ eventType: r.event_type, count: r.count })),
    topListings: topListings.map((r) => ({ label: r.label, occurrenceId: r.occurrence_id, views: r.views })),
    last7Days: last7Days.map((r) => ({ day: r.day, count: r.count })),
    topQueryTerms: topQueryTerms.map((r) => ({ term: r.term, count: r.count })),
    topSearchRegions: topSearchRegions.map((r) => ({ region: r.region, count: r.count })),
    topSearchFilters: topSearchFilters.map((r) => ({ filter: r.token, count: r.count })),
  };
}

/**
 * Pure staleness rule (exported for unit tests so a failure case can be simulated
 * without touching the DB). An enabled source is stale when its last successful/partial
 * check is older than `grace × cadence`. A source that has NEVER succeeded is stale only
 * if it has actually been attempted (a failing source) — a never-run source is "no runs
 * yet", not stale, so freshly-registered sources don't false-alarm.
 */
export function isSourceStale(
  input: { lastSuccessAtMs: number | null; lastRunAtMs: number | null; cadenceSeconds: number | null },
  nowMs: number,
  grace: number = STALE_CADENCE_GRACE
): boolean {
  const cadence =
    input.cadenceSeconds != null && input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
  const thresholdMs = cadence * 1000 * grace;
  if (input.lastSuccessAtMs != null) {
    return nowMs - input.lastSuccessAtMs > thresholdMs;
  }
  return input.lastRunAtMs != null;
}

/**
 * Failure / staleness visibility for the dashboard, all derived from source_check_run
 * (ground truth — source.last_check_at/health_state aren't actively maintained yet).
 * Attention-worthy runs come straight from the table; staleness is computed in TS via
 * isSourceStale so it's unit-testable. This is VISIBILITY ONLY — no email/Slack alerting.
 */
export async function getHealthAlerts(nowMs: number = Date.now()): Promise<HealthAlerts> {
  // F-11: `status = 'failed' OR health_alert_code IS NOT NULL`. The second disjunct is the
  // whole fix — an adapter that detects shape_drift or a phone-rejection spike still upserts
  // its occurrences, so its run is 'partial' and the old status-only filter hid it. Note what
  // this is NOT: `status IN ('failed','partial')`. Widening to all partials would surface
  // every run that merely had a few bad records, burying the deliberate verdicts in noise and
  // teaching operators to ignore the panel.
  const attentionRows = await query<{
    id: string;
    source_id: string;
    name: string;
    family: string;
    started_at: Date | null;
    duration_ms: number | null;
    status: string;
    health_alert_code: string | null;
    health_alert_detail: string | null;
    error_summary: string | null;
    error_count: number | null;
  }>(
    `
    SELECT
      cr.id,
      cr.source_id,
      s.name,
      s.family,
      cr.started_at,
      cr.duration_ms,
      cr.status,
      cr.health_alert_code,
      left(cr.health_alert_detail, 300) AS health_alert_detail,
      left(
        coalesce(cr.errors #>> '{0}', cr.errors ->> 'message', cr.errors #>> '{}', cr.errors::text),
        300
      ) AS error_summary,
      CASE WHEN jsonb_typeof(cr.errors) = 'array' THEN jsonb_array_length(cr.errors) ELSE NULL END AS error_count
    FROM source_check_run cr
    JOIN source s ON s.id = cr.source_id
    WHERE (cr.status = 'failed' OR cr.health_alert_code IS NOT NULL)
      AND s.terms_status = $3
      AND cr.started_at >= now() - ($1::int * interval '1 day')
    ORDER BY cr.started_at DESC
    LIMIT $2::int
    `,
    [ATTENTION_RUN_WINDOW_DAYS, ATTENTION_RUN_LIMIT, ENABLED_TERMS_STATUS]
  );

  const cadenceRows = await query<{
    id: string;
    name: string;
    family: string;
    cadence_seconds: number | null;
    last_success_at: Date | null;
    last_run_at: Date | null;
    last_run_status: string | null;
  }>(
    `
    SELECT
      s.id,
      s.name,
      s.family,
      extract(epoch FROM COALESCE(s.near_date_cadence, s.baseline_cadence))::float8 AS cadence_seconds,
      success.last_success_at,
      latest.last_run_at,
      latest.last_run_status
    FROM source s
    LEFT JOIN LATERAL (
      SELECT max(started_at) AS last_success_at
      FROM source_check_run cr
      WHERE cr.source_id = s.id AND ${CLEAN_SUCCESS_RUN_SQL}
    ) success ON true
    LEFT JOIN LATERAL (
      SELECT started_at AS last_run_at, status AS last_run_status
      FROM source_check_run cr
      WHERE cr.source_id = s.id
      ORDER BY cr.started_at DESC
      LIMIT 1
    ) latest ON true
    WHERE s.terms_status = $1
    ORDER BY s.name
    `,
    [ENABLED_TERMS_STATUS]
  );

  const staleSources: StaleSource[] = cadenceRows
    .map((r) => ({
      sourceId: r.id,
      name: r.name,
      family: r.family,
      cadenceSeconds: r.cadence_seconds ?? null,
      lastSuccessAt: toIso(r.last_success_at),
      lastRunAt: toIso(r.last_run_at),
      lastRunStatus: r.last_run_status,
    }))
    .filter((s) =>
      isSourceStale(
        {
          lastSuccessAtMs: s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : null,
          lastRunAtMs: s.lastRunAt ? Date.parse(s.lastRunAt) : null,
          cadenceSeconds: s.cadenceSeconds,
        },
        nowMs
      )
    );

  return {
    runsNeedingAttention: attentionRows.map((r) => ({
      checkRunId: r.id,
      sourceId: r.source_id,
      sourceName: r.name,
      family: r.family,
      startedAt: toIso(r.started_at),
      durationMs: r.duration_ms,
      status: r.status,
      healthAlertCode: r.health_alert_code,
      healthAlertDetail: r.health_alert_detail,
      errorSummary: r.error_summary,
      errorCount: r.error_count,
    })),
    staleSources,
    windowDays: ATTENTION_RUN_WINDOW_DAYS,
  };
}

/**
 * Recent parent-submitted correction reports (the "Report wrong info" affordance on
 * the activity detail page). Newest first, non-archived only, joined to the occurrence
 * for a human label. Read-only visibility — the actual triage (resolve/archive) is a
 * later data-health slice; this just surfaces that reports are arriving.
 */
export async function getRecentCorrections(opts: PersonalDataOptions): Promise<DisplayedCorrection[]> {
  // REDACTED IN SQL for a read-only 'viewer' (QA M1, 2026-09-25): the note never leaves the
  // database; `has_note` is computed from the real column first so the page can still say one exists.
  const redact = shouldRedact(opts);
  const rows = await query<{
    id: string;
    occurrence_id: string;
    activity_name: string | null;
    issue_type: string;
    note: string | null;
    has_note: boolean;
    status: string;
    created_at: Date | null;
  }>(
    `
    SELECT
      cr.id,
      cr.occurrence_id,
      o.activity_name,
      cr.issue_type,
      CASE WHEN $2::boolean THEN NULL ELSE cr.note END AS note,
      (coalesce(cr.note, '') <> '') AS has_note,
      cr.status,
      cr.created_at
    FROM correction_report cr
    LEFT JOIN activity_occurrence o ON o.id = cr.occurrence_id
    WHERE cr.archived_at IS NULL
    ORDER BY cr.created_at DESC
    LIMIT $1::int
    `,
    [RECENT_CORRECTIONS_LIMIT, redact]
  );
  return rows.map((r) => ({
    id: r.id,
    occurrenceId: r.occurrence_id,
    activityName: r.activity_name,
    issueType: r.issue_type,
    note: r.note,
    redacted: redact,
    hasNote: r.has_note,
    status: r.status,
    createdAt: toIso(r.created_at),
  }));
}

/** One call that assembles everything the dashboard renders. */
export async function getAdminDashboardData(): Promise<AdminDashboardData> {
  const [registry, ingestion, analytics, alerts, corrections] = await Promise.all([
    getSourceRegistrySummary(),
    getIngestionHealth(),
    getAnalyticsSummary(),
    getHealthAlerts(),
    // The ROLE-INDEPENDENT snapshot payload (lib/admin/snapshot-refresh.ts stores it for every
    // admin), so it carries the notes. It is never rendered to a read-only viewer: /admin/dashboard
    // reads a viewer's list live, redacted in SQL — see the page.
    getRecentCorrections({ redactPersonalData: false }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    registry,
    ingestion,
    analytics,
    alerts,
    corrections,
  };
}
