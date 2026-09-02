// lib/admin/operating.ts — the OPERATING dashboard's single read (M7 / T41, G-T41-1/2).
//
// The assembler behind /admin/operating. It is the operating dashboard's equivalent
// of getAdminDashboardData() and getDataHealthData(): one call, everything the page
// renders, every read concurrent, every statement a SELECT.
//
// ── WHY THIS LIVES IN lib/admin/ AND NOT lib/analytics/ ────────────────────────
// The operating review deliberately spans four domains that until now had four
// separate surfaces: product analytics (analytics_event), data health
// (source_check_run), the corrections/bug queue (correction_report), and production
// errors (Sentry). lib/analytics/* is scoped to analytics_event and stays that way —
// so the cross-domain assembly belongs here, next to lib/admin/data-health.ts, which
// already sets the precedent of composing lib/admin/dashboard.ts rather than
// duplicating it.
//
// ── NOTHING IS RE-IMPLEMENTED ─────────────────────────────────────────────────
// The KPI maths, the window constants, the rolling DAU/WAU/MAU series, the
// corrections queue aggregate and the source-freshness SLA are all IMPORTED from the
// canonical modules T32/T33/T36 already built. What this file adds is the two ops-side
// PERIOD SERIES that had no implementation anywhere (corrections opened/resolved per
// period, and source-check success per period) plus the composition.
import { query } from '@/lib/db/client';
import { getProductHealthKpis, type ProductHealthKpis } from '@/lib/analytics/kpi';
import { getActivityTrend, type ActivityTrend } from '@/lib/analytics/trends';
import {
  buildOperatingKpi,
  buildOperatingKpis,
  clampPeriods,
  getDataCoverage,
  getOperatingPeriodCounts,
  grainInterval,
  isPreHistory,
  periodLabel,
  type DataCoverage,
  type OperatingGrain,
  type OperatingKpi,
  type OperatingKpiDef,
  type OperatingPeriodCounts,
} from '@/lib/analytics/operating';
import { pct } from '@/lib/analytics/kpi';
import {
  getCorrectionsQueueSummary,
  getSourceFreshnessSla,
  SLA_CADENCE_TARGET_PCT,
  type CorrectionsQueueSummary,
  type SourceFreshnessSla,
} from './data-health';
import { getSentryIssueTrend, type SentryIssueTrend } from '@/lib/observability/sentry-issues';

/** One period bucket of ops-side (non-analytics_event) counters. */
export interface OperatingOpsPeriod {
  period: string;
  label: string;
  partial: boolean;
  /** correction_report rows created in the period (non-archived). */
  correctionsOpened: number;
  /** …rows resolved in the period (non-archived). */
  correctionsResolved: number;
  /** source_check_run rows started in the period. */
  checkRuns: number;
  /** …that finished 'success' or 'partial' (the data-health numerator). */
  okCheckRuns: number;
  /** …that finished 'failed'. */
  failedCheckRuns: number;
}

interface OpsRow {
  period_start: string;
  corrections_opened: number;
  corrections_resolved: number;
  check_runs: number;
  ok_check_runs: number;
  failed_check_runs: number;
}

/**
 * Per-period corrections + ingestion-run counters.
 *
 * correction_report is joined TWICE (once on created_at, once on resolved_at) because
 * "opened in this period" and "resolved in this period" are different row sets — so
 * both counts use count(DISTINCT id) to defeat the cartesian product the double join
 * otherwise produces inside a bucket. Archived (soft-deleted) reports are excluded on
 * both sides, matching getCorrectionsQueueSummary()'s definition exactly.
 */
/**
 * Per-period ops counters: corrections opened, corrections resolved, source check runs.
 *
 * ═══ REWRITTEN 2026-09-01. THE PREVIOUS FORM BUILT A CARTESIAN PRODUCT. ═══
 * It LEFT JOINed `periods` to THREE tables in one query — correction_report twice (once on
 * created_at, once on resolved_at) and source_check_run — so every period emitted
 * (opened x resolved x runs) rows. The `count(DISTINCT ...)` wrappers were not a business rule;
 * they were undoing that multiplication. That is why the query looked reasonable.
 *
 * MEASURED against modest data — 600 correction_report rows and 50,000 source_check_run rows:
 *
 *     join emitted            9,898,120 rows   (planner ESTIMATED 24,730,002,047)
 *     sort spilled                  708 MB     external merge
 *     execution                  28,661 ms
 *     this form                      39.7 ms   -- 722x, byte-identical output
 *
 * Production is larger than that fixture, and this was the live blocker on /admin/operating: the
 * page returned nothing at all within 60s, with two of its queries caught on DataFileRead and
 * BuffileWrite.
 *
 * ═══ THE FIX IS THE SAME SHAPE USED THREE TIMES ELSEWHERE TODAY ═══
 * Aggregate each table ONCE on its own, to at most one row per period, then join those small
 * results to `periods`. Three independent 30-row relations cannot multiply. The DISTINCTs are gone
 * because there is no longer any duplication for them to remove — which is the tell that they were
 * compensating rather than expressing intent.
 *
 * NOTE THE TWO CORRECTION SCANS ARE GENUINELY SEPARATE: `opened` buckets by created_at and
 * `resolved` by resolved_at, so one row can legitimately appear in both, in different periods.
 * They cannot be collapsed into a single pass without changing what is counted.
 */
async function getOpsSeries(grain: OperatingGrain, periods: number): Promise<OpsRow[]> {
  return query<OpsRow>(
    `
    WITH periods AS (
      SELECT gs AS pstart
      FROM generate_series(
        date_trunc($1::text, now()) - (($3::int - 1) * $2::interval),
        date_trunc($1::text, now()),
        $2::interval
      ) AS gs
    ),
    bounds AS (
      SELECT min(pstart) AS lo, max(pstart) + $2::interval AS hi FROM periods
    ),
    opened AS (
      SELECT date_trunc($1::text, c.created_at) AS pstart, count(*)::int AS n
        FROM correction_report c, bounds b
       WHERE c.archived_at IS NULL
         AND c.created_at >= b.lo AND c.created_at < b.hi
       GROUP BY 1
    ),
    resolved AS (
      SELECT date_trunc($1::text, c.resolved_at) AS pstart, count(*)::int AS n
        FROM correction_report c, bounds b
       WHERE c.archived_at IS NULL
         AND c.resolved_at >= b.lo AND c.resolved_at < b.hi
       GROUP BY 1
    ),
    runs AS (
      SELECT date_trunc($1::text, r.started_at) AS pstart,
             count(*)::int AS n,
             count(*) FILTER (WHERE r.status IN ('success', 'partial'))::int AS ok,
             count(*) FILTER (WHERE r.status = 'failed')::int AS failed
        FROM source_check_run r, bounds b
       WHERE r.started_at >= b.lo AND r.started_at < b.hi
       GROUP BY 1
    )
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD') AS period_start,
      COALESCE(o.n, 0) AS corrections_opened,
      COALESCE(rs.n, 0) AS corrections_resolved,
      COALESCE(ru.n, 0) AS check_runs,
      COALESCE(ru.ok, 0) AS ok_check_runs,
      COALESCE(ru.failed, 0) AS failed_check_runs
    FROM periods p
    LEFT JOIN opened o ON o.pstart = p.pstart
    LEFT JOIN resolved rs ON rs.pstart = p.pstart
    LEFT JOIN runs ru ON ru.pstart = p.pstart
    ORDER BY p.pstart
    `,
    [grain, grainInterval(grain), periods]
  );
}

/** Fetch the ops-side period series, shaped and partial-flagged like the analytics one. */
export async function getOperatingOpsPeriods(
  grain: OperatingGrain,
  periodsRequested?: number
): Promise<OperatingOpsPeriod[]> {
  const periods = clampPeriods(periodsRequested, grain);
  const rows = await getOpsSeries(grain, periods);
  const lastIndex = rows.length - 1;
  return rows.map((row, index) => ({
    period: row.period_start,
    label: periodLabel(row.period_start, grain),
    partial: index === lastIndex,
    correctionsOpened: row.corrections_opened ?? 0,
    correctionsResolved: row.corrections_resolved ?? 0,
    checkRuns: row.check_runs ?? 0,
    okCheckRuns: row.ok_check_runs ?? 0,
    failedCheckRuns: row.failed_check_runs ?? 0,
  }));
}

/** How far back the OPS tables' own history goes — the ops half of DataCoverage. */
export interface OpsDataCoverage {
  /** Oldest source_check_run.started_at, or null when none have ever run. */
  firstCheckRunAt: string | null;
  /** Oldest non-archived correction_report.created_at, or null when none exist. */
  firstCorrectionAt: string | null;
}

/**
 * Read where the ops tables' histories actually begin.
 *
 * Deliberately a separate, tiny read rather than something folded into the bucketed
 * ops query: it is two index-friendly `min()`s over whole tables, and keeping it apart
 * means the per-bucket aggregate stays a per-bucket aggregate. Safe on empty tables
 * (both fields null → nothing is ever treated as pre-history).
 */
export async function getOpsCoverage(): Promise<OpsDataCoverage> {
  const rows = await query<{ first_check_run_at: Date | null; first_correction_at: Date | null }>(
    `
    SELECT
      (SELECT min(started_at) FROM source_check_run)                            AS first_check_run_at,
      (SELECT min(created_at) FROM correction_report WHERE archived_at IS NULL) AS first_correction_at
    `
  );
  const toIso = (v: Date | null | undefined): string | null => {
    if (v == null) return null;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  return {
    firstCheckRunAt: toIso(rows[0]?.first_check_run_at),
    firstCorrectionAt: toIso(rows[0]?.first_correction_at),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ops-side KPI definitions — same model as the analytics ones so the trends UI
// renders both from a single component.
// ─────────────────────────────────────────────────────────────────────────────

const CORRECTIONS_OPENED_DEF: OperatingKpiDef = {
  key: 'corrections_opened',
  label: 'Corrections / bugs reported',
  description: 'Parent-submitted "report wrong info" reports created in the period (archived ones excluded).',
  format: 'count',
  better: 'lower',
  provenance: 'correction_report — same non-archived definition as getCorrectionsQueueSummary()',
  cadence: 'both',
};

const CORRECTIONS_RESOLVED_DEF: OperatingKpiDef = {
  key: 'corrections_resolved',
  label: 'Corrections resolved',
  description: 'Reports moved to resolved in the period — the triage side of the same queue.',
  format: 'count',
  better: 'higher',
  provenance: 'correction_report.resolved_at',
  cadence: 'both',
};

const DATA_HEALTH_DEF: OperatingKpiDef = {
  key: 'ingest_success_rate',
  label: 'Data health — ingestion success rate',
  description: 'Share of source check runs in the period that finished success or partial (not failed).',
  format: 'pct',
  better: 'higher',
  provenance: `source_check_run; target reuses data-health.ts SLA_CADENCE_TARGET_PCT (${SLA_CADENCE_TARGET_PCT}%)`,
  cadence: 'both',
  target: { value: SLA_CADENCE_TARGET_PCT, direction: 'gte', source: 'data-health.ts SLA_CADENCE_TARGET_PCT' },
};

/**
 * The instant each data domain's history actually starts. One entry per underlying
 * TABLE, because pre-history is a property of the table a KPI reads — not of the
 * product as a whole.
 *
 * ── WHY THIS TYPE EXISTS (regression guard, R1) ────────────────────────────────
 * The first version of this file anchored the ops KPIs on `analytics_event`'s first
 * row. That is wrong and it hid real data: `source_check_run` has been recording
 * since the early ingestion rounds, while analytics instrumentation only landed at
 * T32 — so every ingestion run older than the first analytics event was reported as
 * "nothing to measure". Independent QA reproduced it live: three genuinely FAILED
 * check runs on a day before analytics began (a total-ingestion-outage day, i.e.
 * exactly what the daily review exists to catch) rendered as an em-dash, and the
 * detail row was dropped under a caption claiming there was nothing to measure.
 *
 * It also got worse with time rather than better: lib/analytics/retention.ts purges
 * `analytics_event` on a 13-month window, so the analytics anchor MOVES FORWARD and
 * the suppression window grows.
 *
 * Each KPI is therefore anchored on its own table's `min()`. A domain with no rows at
 * all yields `null`, which {@link isPreHistory} treats as "suppress nothing".
 */
export interface OperatingDataAnchors {
  /** min(analytics_event.created_at) — anchors the product-analytics KPIs. */
  analyticsMs: number | null;
  /** min(source_check_run.started_at) — anchors the ingestion-success KPI. */
  checkRunMs: number | null;
  /** min(correction_report.created_at) — anchors the corrections KPIs. */
  correctionMs: number | null;
}

/**
 * The earliest instant ANY domain recorded something. A bucket that closed before
 * this had nothing to measure in any table, and is the only kind of bucket the detail
 * table may legitimately drop.
 */
export function earliestDataMs(anchors: OperatingDataAnchors): number | null {
  const known = [anchors.analyticsMs, anchors.checkRunMs, anchors.correctionMs].filter(
    (ms): ms is number => ms != null && Number.isFinite(ms)
  );
  return known.length ? Math.min(...known) : null;
}

/**
 * Build the three ops-side KPIs from the ops period series. Pure.
 *
 * Each KPI is anchored on the table it actually reads (see {@link OperatingDataAnchors}).
 * Passing no anchors suppresses nothing, which is the safe default: showing a real
 * zero is always recoverable, hiding a real outage is not.
 */
export function buildOpsKpis(
  ops: OperatingOpsPeriod[],
  grain: OperatingGrain = 'day',
  anchors: Partial<OperatingDataAnchors> = {}
): OperatingKpi[] {
  const point =
    (anchorMs: number | null) =>
    (o: OperatingOpsPeriod, value: number | null, sample: number | null) => {
      const preHistory = isPreHistory(o.period, grain, anchorMs);
      return {
        period: o.period,
        label: o.label,
        value: preHistory ? null : value,
        sample: preHistory ? null : sample,
        partial: o.partial,
        preHistory,
      };
    };

  const correctionPoint = point(anchors.correctionMs ?? null);
  const checkRunPoint = point(anchors.checkRunMs ?? null);

  return [
    buildOperatingKpi(
      CORRECTIONS_OPENED_DEF,
      ops.map((o) => correctionPoint(o, o.correctionsOpened, null))
    ),
    buildOperatingKpi(
      CORRECTIONS_RESOLVED_DEF,
      ops.map((o) => correctionPoint(o, o.correctionsResolved, null))
    ),
    buildOperatingKpi(
      DATA_HEALTH_DEF,
      // pct(0, 0) is already null, so a bucket with genuinely no runs reads "—" on its
      // own merits; the anchor only suppresses buckets that predate ingestion itself.
      ops.map((o) => checkRunPoint(o, pct(o.okCheckRuns, o.checkRuns), o.checkRuns))
    ),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface OperatingDashboardData {
  generatedAt: string;
  grain: OperatingGrain;
  /**
   * The bucket axis shared by every KPI series, oldest→newest. `preHistory` here means
   * "no domain could have recorded anything in this bucket" — the only condition under
   * which the detail table may drop a row.
   */
  periods: { period: string; label: string; partial: boolean; preHistory: boolean }[];
  /** How much real analytics_event data exists — the guard against reading noise as signal. */
  coverage: DataCoverage;
  /** Where the ops tables' own histories begin (they differ from analytics — see R1). */
  opsCoverage: OpsDataCoverage;
  /** The per-table pre-history anchors actually applied to each KPI. */
  anchors: OperatingDataAnchors;
  /** The canonical current-window KPI snapshot (reused verbatim from T32). */
  snapshot: ProductHealthKpis;
  /** Rolling DAU/WAU/MAU + volume lines (reused verbatim from T32). */
  activeUserTrend: ActivityTrend;
  /** Every operating KPI, product-side then ops-side, each with its trend read. */
  kpis: OperatingKpi[];
  /** Production error trend — or an explicit "cannot tell", never a fake zero. */
  sentry: SentryIssueTrend;
  /** Live corrections queue depth (reused verbatim from T33). */
  correctionsQueue: CorrectionsQueueSummary;
  /** Live source-freshness SLA (reused verbatim from T33). */
  sourceFreshness: SourceFreshnessSla;
  /** Raw per-period analytics counters, for the review's detail table. */
  counts: OperatingPeriodCounts[];
  /** Raw per-period ops counters, for the review's detail table. */
  opsCounts: OperatingOpsPeriod[];
}

/**
 * One call that assembles the whole operating-review payload for a grain.
 *
 * Every read runs concurrently. The Sentry read cannot throw or hang the page (see
 * getSentryIssueTrend); the database reads behave exactly like their siblings on
 * /admin/data-health — an empty/near-empty database yields zeros and null rates, not
 * an error, and `coverage` tells the reader how much history those numbers are drawn
 * from so a thin dataset is never mistaken for a confident one.
 */
export async function getOperatingDashboardData(
  grain: OperatingGrain,
  periodsRequested?: number,
  nowMs: number = Date.now()
): Promise<OperatingDashboardData> {
  const [
    counts,
    opsCounts,
    snapshot,
    activeUserTrend,
    coverage,
    opsCoverage,
    correctionsQueue,
    sourceFreshness,
    sentry,
  ] = await Promise.all([
    getOperatingPeriodCounts(grain, periodsRequested),
    getOperatingOpsPeriods(grain, periodsRequested),
    getProductHealthKpis(),
    getActivityTrend(),
    getDataCoverage(),
    getOpsCoverage(),
    getCorrectionsQueueSummary(),
    getSourceFreshnessSla(nowMs),
    getSentryIssueTrend(nowMs),
  ]);

  // One pre-history anchor PER TABLE. Using the analytics anchor for the ops KPIs hid
  // real ingestion failures that predated analytics instrumentation — see
  // OperatingDataAnchors for the full account of that defect.
  const parse = (iso: string | null): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };
  const anchors: OperatingDataAnchors = {
    analyticsMs: parse(coverage.firstEventAt),
    checkRunMs: parse(opsCoverage.firstCheckRunAt),
    correctionMs: parse(opsCoverage.firstCorrectionAt),
  };

  // A bucket may only be dropped from the detail table (and excluded from the
  // "complete periods" count) when NO domain could have recorded anything in it —
  // otherwise a row carrying real ops data disappears under a caption insisting there
  // was nothing to measure.
  const earliestMs = earliestDataMs(anchors);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    grain,
    periods: counts.map((c) => ({
      period: c.period,
      label: c.label,
      partial: c.partial,
      preHistory: isPreHistory(c.period, grain, earliestMs),
    })),
    coverage,
    opsCoverage,
    anchors,
    snapshot,
    activeUserTrend,
    kpis: [
      ...buildOperatingKpis(counts, grain, anchors.analyticsMs),
      ...buildOpsKpis(opsCounts, grain, anchors),
    ],
    sentry,
    correctionsQueue,
    sourceFreshness,
    counts,
    opsCounts,
  };
}
