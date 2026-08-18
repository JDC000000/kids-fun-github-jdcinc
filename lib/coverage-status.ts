// lib/coverage-status.ts — READ-SIDE data for the PUBLIC coverage/status page
// (app/coverage-status/page.tsx, served at `/coverage-status` — see that file's header for
// why the route isn't the more obvious `/coverage`). "How many sources are connected in my
// city, and when did we last check them?" — a parent-facing trust signal, deliberately
// smaller and separate from
// the internal /admin/data-health coverage matrix (region × family × network gap board),
// which answers a different, operator-facing question and is gated behind admin access.
//
// Every statement here is a SELECT over the same tables the admin dashboard already reads
// (`source`, `source_check_run`, `venue`, `region`, `activity_series`) — this file adds no
// new schema and reuses the existing gate/health constants rather than re-deriving them:
//   • ENABLED_TERMS_STATUS / CLEAN_SUCCESS_RUN_SQL (lib/admin/dashboard.ts) — the SAME
//     "is this source connected" and "was this a clean successful run" definitions the
//     admin dashboard and the freshness SLA use. Importing rather than re-typing them is
//     what keeps "connected" meaning the same thing on the public page and the admin one.
//   • LAUNCH_REGIONS (lib/admin/data-health.ts) — the 5 canonical municipalities, so the
//     page always renders the full set (a region with zero connected sources still gets a
//     row, honestly reading "0 sources" rather than silently vanishing).
import { query } from '@/lib/db/client';
import { CLEAN_SUCCESS_RUN_SQL, ENABLED_TERMS_STATUS } from '@/lib/admin/dashboard';
import { LAUNCH_REGIONS, type RegionDef } from '@/lib/admin/data-health';

export interface MunicipalityCoverage {
  region: RegionDef;
  /** Distinct terms-allowed sources with at least one venue in this municipality. */
  connectedSources: number;
  /** Most recent CLEAN successful check across those sources, or null if none has ever run. */
  lastCrawlAt: string | null;
}

export interface CoverageStatus {
  generatedAt: string;
  /** Distinct terms-allowed sources connected anywhere in the launch footprint. */
  totalConnectedSources: number;
  regions: MunicipalityCoverage[];
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Per-municipality connected-source counts + last crawl time (roadmap initiative 7's
 * public coverage/status page).
 *
 * A source is attributed to a municipality via the venues its OWN series serve — the same
 * `activity_series.source_id -> venue -> region` hop `getCoverageRawCounts`
 * (lib/admin/data-health.ts) uses, rolling a sub-area up one hop to its parent municipality
 * so e.g. a Kitsilano venue counts toward Vancouver. "Connected" means `terms_status =
 * 'allowed'` (ENABLED_TERMS_STATUS) — the SAME gate the admin dashboard and freshness SLA
 * call enabled; a source still pending/disallowed/blocked review does not count, however
 * much data it may hold from before that state changed. "Last crawl" is the most recent
 * CLEAN successful run (CLEAN_SUCCESS_RUN_SQL) among a municipality's connected sources —
 * a failed or alert-flagged run is not "we checked", it is "we tried and it didn't count".
 */
export async function getCoverageStatus(nowMs: number = Date.now()): Promise<CoverageStatus> {
  const rows = await query<{ region_name: string; source_count: number; last_crawl_at: Date | null }>(
    `
    WITH connected_source_region AS (
      SELECT DISTINCT
        s.id AS source_id,
        CASE
          WHEN r.level = 'municipality' THEN r.name
          WHEN rp.level = 'municipality' THEN rp.name
        END AS region_name
      FROM source s
      JOIN activity_series ser ON ser.source_id = s.id
      LEFT JOIN venue v        ON v.id = ser.venue_id
      LEFT JOIN region r       ON r.id = v.municipality_id
      LEFT JOIN region rp      ON rp.id = r.parent_id
      WHERE s.terms_status = $1
    )
    SELECT
      csr.region_name,
      count(DISTINCT csr.source_id)::int AS source_count,
      max(success.last_success_at)       AS last_crawl_at
    FROM connected_source_region csr
    LEFT JOIN LATERAL (
      SELECT max(cr.started_at) AS last_success_at
      FROM source_check_run cr
      WHERE cr.source_id = csr.source_id AND ${CLEAN_SUCCESS_RUN_SQL}
    ) success ON true
    WHERE csr.region_name IS NOT NULL
    GROUP BY csr.region_name
    `,
    [ENABLED_TERMS_STATUS]
  );
  const byRegionName = new Map(rows.map((r) => [r.region_name, r]));

  const totalRows = await query<{ total: number }>(
    `SELECT count(DISTINCT s.id)::int AS total FROM source s WHERE s.terms_status = $1`,
    [ENABLED_TERMS_STATUS]
  );

  const regions: MunicipalityCoverage[] = LAUNCH_REGIONS.map((region) => {
    const row = byRegionName.get(region.name);
    return {
      region,
      connectedSources: row?.source_count ?? 0,
      lastCrawlAt: toIso(row?.last_crawl_at ?? null),
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    totalConnectedSources: totalRows[0]?.total ?? 0,
    regions,
  };
}
