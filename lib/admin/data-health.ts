// lib/admin/data-health.ts — READ-SIDE data access for the dedicated data-health
// dashboard (M5 / T33, /admin/data-health). Server-only: uses the shared service
// pg pool (lib/db/client). EVERY statement here is a SELECT — nothing mutates.
//
// This file owns the two genuinely-new read surfaces the general /admin/dashboard
// didn't already provide:
//   • G-T33-1  source-freshness SLA — the aggregate "% of enabled sources meeting
//              their cadence" rollup, vs the ≥95% target. (The dashboard's Ingestion
//              health table shows per-source latest-run detail, but there was no
//              aggregate cadence-adherence percentage anywhere — this is that gap.)
//   • G-T33-3  coverage matrix — launch-region × P0-activity-family × source-network,
//              with an EXPLICIT "gap" for every combination that has zero coverage
//              (the G2 "coverage-or-gap board" gate criterion). Nothing like this
//              existed before.
//   • G-T33-4  corrections queue summary — open count + oldest-open aggregate over
//              correction_report (complements, not duplicates, getRecentCorrections'
//              recent-list read).
//
// The already-built G-T33-2 (failed + stale sources) is REUSED wholesale from
// lib/admin/dashboard.ts (getHealthAlerts) and G-T33-4's recent-list from
// getRecentCorrections — imported below, never re-implemented.
//
// Pure math helpers are exported (and unit-tested without a DB) exactly like
// lib/analytics/kpi.ts; the DB reads assemble raw rows and hand them to those pure
// builders so the SLA % and coverage/gap logic are testable on known inputs.
import { query } from '@/lib/db/client';
import {
  DEFAULT_CADENCE_SECONDS,
  ENABLED_TERMS_STATUS,
  getHealthAlerts,
  getRecentCorrections,
  type HealthAlerts,
  type RecentCorrection,
} from '@/lib/admin/dashboard';

// ─────────────────────────────────────────────────────────────────────────────
// Constants — targets and canonical taxonomy. The region/family lists are NOT
// invented here: they mirror the exact taxonomy the rest of the app already uses.
//   • families = the `category` rows with is_primary_eligible = true
//                (supabase/seeds/categories_tags.sql, TSD §5A.2 canonical set).
//   • regions  = the launch municipalities in `region` (supabase/seeds/regions.sql),
//                whose chip ids match REGION_CHIPS in app/search/_lib/params.ts.
// Held as constants (not read from the DB) so the coverage board always renders the
// FULL grid — a region or family with zero coverage shows an explicit "gap" cell
// rather than silently vanishing. A DB-backed test asserts these stay in lock-step
// with the seeded taxonomy so they can never drift.
// ─────────────────────────────────────────────────────────────────────────────

/** §12.5 / T33 target: source-freshness SLA — ≥95% of enabled sources on-cadence. */
export const SLA_CADENCE_TARGET_PCT = 95;
/**
 * Cadence-adherence grace: a source "meets its cadence" (SLA-adherent) when its last
 * successful check is within grace × its configured cadence. 1 = strict on-time (a
 * successful refresh within one full cadence interval). This is deliberately STRICTER
 * than the dashboard's staleness rule (STALE_CADENCE_GRACE = 2, "a real problem"),
 * giving a three-step gradient: adherent (≤1×) → lagging (1–2×) → stale (>2×).
 */
export const SLA_CADENCE_GRACE = 1;

/** Launch region (column) definitions — mirrors regions.sql municipalities + REGION_CHIPS. */
export interface RegionDef {
  /** REGION_CHIPS id (app/search/_lib/params.ts) — the same id /search uses. */
  key: string;
  /** region.name as stored in the DB — the join key for occurrence attribution. */
  name: string;
  /** Human column label. */
  label: string;
}

/** The 5 launch municipalities, in REGION_CHIPS order (van, nvan, wvan, bby, rmd). */
export const LAUNCH_REGIONS: RegionDef[] = [
  { key: 'van', name: 'Vancouver', label: 'Vancouver' },
  { key: 'nvan', name: 'North Vancouver', label: 'North Van' },
  { key: 'wvan', name: 'West Vancouver', label: 'West Van' },
  { key: 'bby', name: 'Burnaby', label: 'Burnaby' },
  { key: 'rmd', name: 'Richmond', label: 'Richmond' },
];

/** P0 activity-family (row) definition — a primary-eligible `category`. */
export interface FamilyDef {
  /** category.key. */
  key: string;
  /** category.label. */
  label: string;
}

/**
 * The P0 activity families (rows) — the primary-eligible categories, in the seed's
 * canonical order (categories_tags.sql / TSD §5A.2). Excludes secondary-only
 * categories (miniature_train, tobogganing) which are never a listing's primary.
 */
export const P0_FAMILIES: FamilyDef[] = [
  { key: 'open_gym', label: 'Open Gym' },
  { key: 'public_swim', label: 'Public / Family Swim' },
  { key: 'skate', label: 'Public / Family Skate' },
  { key: 'storytime', label: 'Storytime' },
  { key: 'indoor_play', label: 'Indoor Play' },
  { key: 'museum_venue', label: 'Museum / Cultural Venue' },
  { key: 'attraction', label: 'Attraction' },
  { key: 'festival_event', label: 'Festival / One-off Event' },
  { key: 'outdoor_park', label: 'Parks / Nature / Farms' },
  { key: 'class_program', label: 'Class / Program' },
];

/**
 * The P0 source-networks the coverage board cares about first (canonical spec).
 * Other source families (library_*, venue_html, …) still appear if they contribute
 * coverage — these two just sort first and get a friendly label/short code.
 */
export const P0_SOURCE_NETWORKS = ['activenet', 'perfectmind'] as const;

/** Friendly display names for the source.family networks (fallback = raw family). */
export const NETWORK_LABELS: Record<string, string> = {
  activenet: 'ActiveNet',
  perfectmind: 'PerfectMind',
  library_bibliocommons: 'Library (BiblioCommons)',
  library_communico: 'Library (Communico)',
  venue_html: 'Venue site',
  seasonal_watcher: 'Seasonal watcher',
  city_calendar: 'City calendar',
  eventbrite_organizer: 'Eventbrite (organizer)',
};

/** Compact per-cell chip codes for the networks (fallback = first 2 chars, upper). */
export const NETWORK_SHORT: Record<string, string> = {
  activenet: 'AN',
  perfectmind: 'PM',
  library_bibliocommons: 'LB',
  library_communico: 'LC',
  venue_html: 'VH',
  seasonal_watcher: 'SW',
  city_calendar: 'CC',
  eventbrite_organizer: 'EB',
};

export function networkLabel(family: string): string {
  return NETWORK_LABELS[family] ?? family;
}
export function networkShort(family: string): string {
  return NETWORK_SHORT[family] ?? family.slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure, DB-free helpers — exported for unit tests + reuse by the UI. Null-safe.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is a source SLA-adherent (meeting its cadence)? True iff it has a successful check
 * within grace × its effective cadence. A source that has NEVER succeeded is NOT
 * adherent (it isn't delivering fresh data), regardless of whether it has run.
 *
 * RECONCILIATION (Round 23 / Task RR, G-T15-3): the canonical worker-side health SLA lives
 * in worker/health/sla.ts (cadenceAdherent), which computes the broader operational health
 * (adherence + check-success + parse-yield). This function is the /admin/data-health DISPLAY
 * read path and deliberately stays separate — the Next app does not import from worker/ (that
 * boundary is enforced by tsconfig excluding worker/ + eslint ignoring it). The two adherence
 * formulas are identical and pinned together by tests/health/sla-consistency.test.ts, so they
 * cannot silently diverge. See the Task RR findings doc for the full reasoning.
 */
export function isCadenceAdherent(
  input: { lastSuccessAtMs: number | null; cadenceSeconds: number | null },
  nowMs: number,
  grace: number = SLA_CADENCE_GRACE
): boolean {
  if (input.lastSuccessAtMs == null) return false;
  const cadence =
    input.cadenceSeconds != null && input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
  const thresholdMs = cadence * 1000 * grace;
  return nowMs - input.lastSuccessAtMs <= thresholdMs;
}

/**
 * A whole-number percentage numer/denom, or `null` when denom ≤ 0 ("not enough data
 * to state a rate") so the UI shows an em-dash rather than a misleading 0%.
 */
export function adherencePct(adherent: number, total: number): number | null {
  if (!Number.isFinite(adherent) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((adherent / total) * 100);
}

/** Does an adherence % meet the SLA target? A null % (no enabled sources) does not. */
export function meetsSlaTarget(pct: number | null, target: number = SLA_CADENCE_TARGET_PCT): boolean {
  return pct != null && pct >= target;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// G-T33-1 — source-freshness SLA (aggregate cadence adherence).
// ─────────────────────────────────────────────────────────────────────────────

/** One enabled source's cadence-adherence status, for the SLA breakdown. */
export interface SlaSourceRow {
  sourceId: string;
  name: string;
  family: string;
  /** COALESCE(near_date_cadence, baseline_cadence) in seconds. */
  cadenceSeconds: number | null;
  lastSuccessAt: string | null;
  adherent: boolean;
}

export interface SourceFreshnessSla {
  targetPct: number;
  enabledCount: number;
  adherentCount: number;
  /** adherent ÷ enabled as a whole %, or null when there are no enabled sources. */
  adherencePct: number | null;
  meetsTarget: boolean;
  /** Per-source breakdown, worst (non-adherent) first, so the drift is scannable. */
  sources: SlaSourceRow[];
}

/**
 * Aggregate source-freshness SLA: what share of enabled sources are currently meeting
 * their cadence, vs the ≥95% target. Cadence + last-success come straight from
 * source / source_check_run (ground truth); adherence is computed in TS via the pure
 * isCadenceAdherent so it's unit-testable and consistent with the staleness gradient.
 */
export async function getSourceFreshnessSla(nowMs: number = Date.now()): Promise<SourceFreshnessSla> {
  const rows = await query<{
    id: string;
    name: string;
    family: string;
    cadence_seconds: number | null;
    last_success_at: Date | null;
  }>(
    `
    SELECT
      s.id,
      s.name,
      s.family,
      extract(epoch FROM COALESCE(s.near_date_cadence, s.baseline_cadence))::float8 AS cadence_seconds,
      success.last_success_at
    FROM source s
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

  const sources: SlaSourceRow[] = rows.map((r) => {
    const lastSuccessAt = toIso(r.last_success_at);
    const cadenceSeconds = r.cadence_seconds ?? null;
    const adherent = isCadenceAdherent(
      { lastSuccessAtMs: lastSuccessAt ? Date.parse(lastSuccessAt) : null, cadenceSeconds },
      nowMs
    );
    return { sourceId: r.id, name: r.name, family: r.family, cadenceSeconds, lastSuccessAt, adherent };
  });

  // Non-adherent first (the ones a human needs to see), then by name.
  sources.sort((a, b) => Number(a.adherent) - Number(b.adherent) || a.name.localeCompare(b.name));

  const enabledCount = sources.length;
  const adherentCount = sources.reduce((n, s) => n + (s.adherent ? 1 : 0), 0);
  const pct = adherencePct(adherentCount, enabledCount);
  return {
    targetPct: SLA_CADENCE_TARGET_PCT,
    enabledCount,
    adherentCount,
    adherencePct: pct,
    meetsTarget: meetsSlaTarget(pct),
    sources,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G-T33-3 — coverage matrix (launch-region × P0-family × source-network).
// ─────────────────────────────────────────────────────────────────────────────

/** Raw per-(region,family,network) occurrence count from the DB. */
export interface CoverageRawRow {
  regionName: string;
  familyKey: string;
  network: string;
  cnt: number;
}

/** One cell of the coverage grid: a single region × family combination. */
export interface CoverageCell {
  regionKey: string;
  familyKey: string;
  /** Live (non-archived) occurrence count across all contributing networks. */
  total: number;
  /** Per-source-network breakdown (source.family → count); empty on a gap. */
  byNetwork: Record<string, number>;
  /** true ⟺ total === 0 — an EXPLICIT coverage gap (never a blank/silent cell). */
  gap: boolean;
}

/** One matrix row: a P0 family across all region columns. */
export interface CoverageRow {
  family: FamilyDef;
  total: number;
  /** One cell per region, in LAUNCH_REGIONS order. */
  cells: CoverageCell[];
}

export interface CoverageMatrix {
  regions: RegionDef[];
  families: FamilyDef[];
  /** Distinct networks that actually contribute coverage (P0 nets sorted first). */
  networks: string[];
  rows: CoverageRow[];
  /** Column totals, in region order. */
  regionTotals: number[];
  grandTotal: number;
  /** regions × families. */
  cellCount: number;
  coveredCount: number;
  gapCount: number;
}

/**
 * PURE assembler — builds the full region × family grid from raw counts, marking every
 * zero-coverage combination as an explicit gap. Rows whose region/family aren't in the
 * canonical lists are ignored (defensive; the DB read already constrains them). Exported
 * so the coverage/gap logic is unit-testable on known inputs without a database.
 */
export function buildCoverageMatrix(
  regions: RegionDef[],
  families: FamilyDef[],
  raw: CoverageRawRow[]
): CoverageMatrix {
  const regionKeyByName = new Map(regions.map((r) => [r.name, r.key]));
  const familyKeys = new Set(families.map((f) => f.key));

  // cellKey → byNetwork accumulator.
  const acc = new Map<string, Record<string, number>>();
  const cellKey = (regionKey: string, familyKey: string) => `${regionKey} ${familyKey}`;
  const networksSeen = new Set<string>();

  for (const row of raw) {
    const regionKey = regionKeyByName.get(row.regionName);
    if (!regionKey || !familyKeys.has(row.familyKey)) continue; // outside the canonical grid
    if (!Number.isFinite(row.cnt) || row.cnt <= 0) continue;
    networksSeen.add(row.network);
    const key = cellKey(regionKey, row.familyKey);
    const byNetwork = acc.get(key) ?? {};
    byNetwork[row.network] = (byNetwork[row.network] ?? 0) + row.cnt;
    acc.set(key, byNetwork);
  }

  const regionTotals = regions.map(() => 0);
  let grandTotal = 0;
  let coveredCount = 0;
  let gapCount = 0;

  const rows: CoverageRow[] = families.map((family) => {
    let rowTotal = 0;
    const cells: CoverageCell[] = regions.map((region, colIdx) => {
      const byNetwork = acc.get(cellKey(region.key, family.key)) ?? {};
      const total = Object.values(byNetwork).reduce((n, v) => n + v, 0);
      const gap = total === 0;
      if (gap) gapCount += 1;
      else coveredCount += 1;
      rowTotal += total;
      regionTotals[colIdx] += total;
      grandTotal += total;
      return { regionKey: region.key, familyKey: family.key, total, byNetwork, gap };
    });
    return { family, total: rowTotal, cells };
  });

  // Networks: P0 (ActiveNet, PerfectMind) first, then the rest alphabetically.
  const p0 = P0_SOURCE_NETWORKS.filter((n) => networksSeen.has(n));
  const rest = [...networksSeen].filter((n) => !(P0_SOURCE_NETWORKS as readonly string[]).includes(n)).sort();
  const networks = [...p0, ...rest];

  return {
    regions,
    families,
    networks,
    rows,
    regionTotals,
    grandTotal,
    cellCount: regions.length * families.length,
    coveredCount,
    gapCount,
  };
}

/**
 * Raw coverage counts: live (non-archived) occurrences grouped by launch region ×
 * P0 family × source-network. Region is attributed via the occurrence's series →
 * venue → municipality (rolling a sub-area up one hop to its parent municipality);
 * family via the occurrence's primary category (falling back to the series default),
 * restricted to primary-eligible categories; network via the source's family. Sources
 * are NOT filtered by terms_status — coverage reflects whatever data actually exists.
 */
export async function getCoverageRawCounts(): Promise<CoverageRawRow[]> {
  const rows = await query<{ region_name: string; family_key: string; network: string; cnt: number }>(
    `
    WITH occ AS (
      SELECT
        CASE
          WHEN r.level = 'municipality' THEN r.name
          WHEN rp.level = 'municipality' THEN rp.name
        END AS region_name,
        cat.key AS family_key,
        src.family AS network
      FROM activity_occurrence o
      JOIN activity_series s  ON s.id = o.series_id
      JOIN source src         ON src.id = s.source_id
      LEFT JOIN venue v       ON v.id = s.venue_id
      LEFT JOIN region r      ON r.id = v.municipality_id
      LEFT JOIN region rp     ON rp.id = r.parent_id
      JOIN category cat       ON cat.id = COALESCE(o.primary_category_id, s.default_primary_category)
                             AND cat.is_primary_eligible
      WHERE o.archived_at IS NULL
    )
    SELECT region_name, family_key, network, count(*)::int AS cnt
    FROM occ
    WHERE region_name IS NOT NULL
    GROUP BY region_name, family_key, network
    `
  );
  return rows.map((r) => ({
    regionName: r.region_name,
    familyKey: r.family_key,
    network: r.network,
    cnt: r.cnt,
  }));
}

/** The assembled coverage matrix over the canonical launch-region × P0-family grid. */
export async function getCoverageMatrix(): Promise<CoverageMatrix> {
  return buildCoverageMatrix(LAUNCH_REGIONS, P0_FAMILIES, await getCoverageRawCounts());
}

// ─────────────────────────────────────────────────────────────────────────────
// G-T33-4 — corrections queue summary (open count + oldest-open). The recent LIST
// is reused from getRecentCorrections; this is the complementary aggregate only.
// ─────────────────────────────────────────────────────────────────────────────

export interface CorrectionsQueueSummary {
  /** correction_report rows in 'open' status (not archived). */
  openCount: number;
  /** …in 'in_review' status (not archived). */
  inReviewCount: number;
  /** All non-archived, non-resolved reports (the live queue depth). */
  unresolvedCount: number;
  /** created_at of the oldest still-open report, or null if none open. */
  oldestOpenAt: string | null;
}

export async function getCorrectionsQueueSummary(): Promise<CorrectionsQueueSummary> {
  const rows = await query<{
    open_count: number;
    in_review_count: number;
    unresolved_count: number;
    oldest_open_at: Date | null;
  }>(
    `
    SELECT
      count(*) FILTER (WHERE status = 'open')::int                          AS open_count,
      count(*) FILTER (WHERE status = 'in_review')::int                     AS in_review_count,
      count(*) FILTER (WHERE status <> 'resolved')::int                     AS unresolved_count,
      min(created_at) FILTER (WHERE status = 'open')                        AS oldest_open_at
    FROM correction_report
    WHERE archived_at IS NULL
    `
  );
  const r = rows[0];
  return {
    openCount: r?.open_count ?? 0,
    inReviewCount: r?.in_review_count ?? 0,
    unresolvedCount: r?.unresolved_count ?? 0,
    oldestOpenAt: toIso(r?.oldest_open_at ?? null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly — everything the /admin/data-health page renders, in one read.
// ─────────────────────────────────────────────────────────────────────────────

export interface DataHealthData {
  generatedAt: string;
  /** G-T33-1 */
  sla: SourceFreshnessSla;
  /** G-T33-3 */
  coverage: CoverageMatrix;
  /** G-T33-4 aggregate */
  correctionsSummary: CorrectionsQueueSummary;
  /** G-T33-2 — reused from lib/admin/dashboard.ts. */
  alerts: HealthAlerts;
  /** G-T33-4 recent list — reused from lib/admin/dashboard.ts. */
  corrections: RecentCorrection[];
}

/**
 * One call that assembles the whole data-health payload. All five read groups run
 * concurrently. Fails closed/gracefully on empty data (zeros / null → em-dash), never
 * a crash. `nowMs` threads a single clock through the SLA + staleness reads so both
 * agree on "now".
 */
export async function getDataHealthData(nowMs: number = Date.now()): Promise<DataHealthData> {
  const [sla, coverage, correctionsSummary, alerts, corrections] = await Promise.all([
    getSourceFreshnessSla(nowMs),
    getCoverageMatrix(),
    getCorrectionsQueueSummary(),
    getHealthAlerts(nowMs),
    getRecentCorrections(),
  ]);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    sla,
    coverage,
    correctionsSummary,
    alerts,
    corrections,
  };
}
