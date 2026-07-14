// lib/admin/dashboard.ts — read-only data access for the internal admin/health
// dashboard (M5, first slice). Server-only: uses the shared service-level pg pool
// (lib/db/client). Every statement here is a SELECT; nothing mutates. Numbers come
// straight from the same tables the ingestion worker and analytics writer populate,
// so the dashboard reflects the live database, not a fixture.
import { query } from '@/lib/db/client';

export interface IngestionSourceHealth {
  sourceId: string;
  name: string;
  family: string;
  termsStatus: string;
  robotsStatus: string;
  healthState: string;
  /** source.last_check_at — set by the worker; may lag behind actual runs. */
  lastCheckAt: string | null;
  /** Ground truth: most recent success/partial run from source_check_run. */
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

export interface AnalyticsSummary {
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

export interface AdminDashboardData {
  generatedAt: string;
  registry: SourceRegistrySummary;
  ingestion: IngestionSourceHealth[];
  analytics: AnalyticsSummary;
}

/** "Enabled/live" source = terms reviewed and allowed (terms_status = 'allowed'). */
export const ENABLED_TERMS_STATUS = 'allowed';

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
      WHERE cr.source_id = s.id AND cr.status IN ('success', 'partial')
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

/** Analytics rollups from analytics_event. Robust to an empty table (returns zeros). */
export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const totalsRows = await query<{ total_events: number; listing_viewed: number; search_performed: number }>(
    `
    SELECT
      count(*)::int AS total_events,
      count(*) FILTER (WHERE event_type = 'listing_viewed')::int AS listing_viewed,
      count(*) FILTER (WHERE event_type = 'search_performed')::int AS search_performed
    FROM analytics_event
    `
  );
  const totals = totalsRows[0];

  const byType = await query<{ event_type: string; count: number }>(
    `
    SELECT event_type, count(*)::int AS count
    FROM analytics_event
    GROUP BY event_type
    ORDER BY count DESC, event_type
    `
  );

  const topListings = await query<{ label: string; occurrence_id: string | null; views: number }>(
    `
    SELECT
      coalesce(nullif(result_summary_json->>'activityName', ''), occurrence_id::text, '(unlabeled)') AS label,
      occurrence_id,
      count(*)::int AS views
    FROM analytics_event
    WHERE event_type = 'listing_viewed'
    GROUP BY 1, occurrence_id
    ORDER BY views DESC, label
    LIMIT 10
    `
  );

  const last7Days = await query<{ day: string; count: number }>(
    `
    SELECT
      to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      count(*)::int AS count
    FROM analytics_event
    WHERE created_at >= now() - interval '7 days'
    GROUP BY 1
    ORDER BY 1
    `
  );

  // --- search analytics rollups (search_performed events) ----------------------
  // What parents actually search for. All three tokenise the jsonb fields the
  // /search page writes; each guards its set-returning function with a WHERE on
  // event_type (applied before the SELECT-list expansion) so a non-search or
  // legacy row can never error the query. Robust to an empty table (returns []).

  // Most common query WORDS. Split the raw query on non-alphanumerics, drop tokens
  // under 3 chars and a small stopword set, then frequency-count.
  const topQueryTerms = await query<{ term: string; count: number }>(
    `
    SELECT term, count(*)::int AS count
    FROM (
      SELECT unnest(
        regexp_split_to_array(lower(coalesce(search_context_json->>'q', '')), '[^a-z0-9]+')
      ) AS term
      FROM analytics_event
      WHERE event_type = 'search_performed'
    ) t
    WHERE length(term) >= 3
      AND term <> ALL ($1::text[])
    GROUP BY term
    ORDER BY count DESC, term
    LIMIT 15
    `,
    [QUERY_TERM_STOPWORDS]
  );

  // Most-used region chips (search_context_json.regions is a string array).
  const topSearchRegions = await query<{ region: string; count: number }>(
    `
    SELECT region, count(*)::int AS count
    FROM (
      SELECT jsonb_array_elements_text(search_context_json->'regions') AS region
      FROM analytics_event
      WHERE event_type = 'search_performed'
        AND jsonb_typeof(search_context_json->'regions') = 'array'
    ) t
    GROUP BY region
    ORDER BY count DESC, region
    LIMIT 10
    `
  );

  // Most-used non-region filter tokens (search_context_json.filters is a string array).
  // Alias the unnested value `token` (not `filter`) — FILTER is a SQL keyword and a bare
  // `filter` alias is a parser landmine right after a set-returning function.
  const topSearchFilters = await query<{ token: string; count: number }>(
    `
    SELECT token, count(*)::int AS count
    FROM (
      SELECT jsonb_array_elements_text(search_context_json->'filters') AS token
      FROM analytics_event
      WHERE event_type = 'search_performed'
        AND jsonb_typeof(search_context_json->'filters') = 'array'
    ) t
    GROUP BY token
    ORDER BY count DESC, token
    LIMIT 15
    `
  );

  return {
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

/** One call that assembles everything the dashboard renders. */
export async function getAdminDashboardData(): Promise<AdminDashboardData> {
  const [registry, ingestion, analytics] = await Promise.all([
    getSourceRegistrySummary(),
    getIngestionHealth(),
    getAnalyticsSummary(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    registry,
    ingestion,
    analytics,
  };
}
