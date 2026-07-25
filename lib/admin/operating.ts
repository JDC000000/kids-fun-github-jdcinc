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
    )
    SELECT
      to_char(p.pstart, 'YYYY-MM-DD') AS period_start,
      count(DISTINCT opened.id)::int AS corrections_opened,
      count(DISTINCT resolved.id)::int AS corrections_resolved,
      count(DISTINCT run.id)::int AS check_runs,
      count(DISTINCT run.id) FILTER (WHERE run.status IN ('success', 'partial'))::int AS ok_check_runs,
      count(DISTINCT run.id) FILTER (WHERE run.status = 'failed')::int AS failed_check_runs
    FROM periods p
    LEFT JOIN correction_report opened
      ON opened.created_at >= p.pstart AND opened.created_at < p.pstart + $2::interval
     AND opened.archived_at IS NULL
    LEFT JOIN correction_report resolved
      ON resolved.resolved_at >= p.pstart AND resolved.resolved_at < p.pstart + $2::interval
     AND resolved.archived_at IS NULL
    LEFT JOIN source_check_run run
      ON run.started_at >= p.pstart AND run.started_at < p.pstart + $2::interval
    GROUP BY p.pstart
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
 * Build the three ops-side KPIs from the ops period series. Pure.
 *
 * `grain`/`firstEventAtMs` apply the same pre-history suppression the analytics KPIs
 * use (see isPreHistory in lib/analytics/operating.ts) so a monthly review does not
 * report "0 corrections, steady" for months in which the product did not exist.
 */
export function buildOpsKpis(
  ops: OperatingOpsPeriod[],
  grain: OperatingGrain = 'day',
  firstEventAtMs: number | null = null
): OperatingKpi[] {
  const point = (o: OperatingOpsPeriod, value: number | null, sample: number | null) => {
    const preHistory = isPreHistory(o.period, grain, firstEventAtMs);
    return {
      period: o.period,
      label: o.label,
      value: preHistory ? null : value,
      sample: preHistory ? null : sample,
      partial: o.partial,
      preHistory,
    };
  };

  return [
    buildOperatingKpi(
      CORRECTIONS_OPENED_DEF,
      ops.map((o) => point(o, o.correctionsOpened, null))
    ),
    buildOperatingKpi(
      CORRECTIONS_RESOLVED_DEF,
      ops.map((o) => point(o, o.correctionsResolved, null))
    ),
    buildOperatingKpi(
      DATA_HEALTH_DEF,
      ops.map((o) => point(o, pct(o.okCheckRuns, o.checkRuns), o.checkRuns))
    ),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface OperatingDashboardData {
  generatedAt: string;
  grain: OperatingGrain;
  /** The bucket axis shared by every KPI series, oldest→newest. */
  periods: { period: string; label: string; partial: boolean; preHistory: boolean }[];
  /** How much real data exists — the guard against reading noise as signal. */
  coverage: DataCoverage;
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
  const [counts, opsCounts, snapshot, activeUserTrend, coverage, correctionsQueue, sourceFreshness, sentry] =
    await Promise.all([
      getOperatingPeriodCounts(grain, periodsRequested),
      getOperatingOpsPeriods(grain, periodsRequested),
      getProductHealthKpis(),
      getActivityTrend(),
      getDataCoverage(),
      getCorrectionsQueueSummary(),
      getSourceFreshnessSla(nowMs),
      getSentryIssueTrend(nowMs),
    ]);

  // The pre-history anchor: buckets that closed before this instant had nothing to
  // measure, and are reported as "no data" rather than as a measured zero.
  const firstEventAtMs = coverage.firstEventAt ? Date.parse(coverage.firstEventAt) : null;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    grain,
    periods: counts.map((c) => ({
      period: c.period,
      label: c.label,
      partial: c.partial,
      preHistory: isPreHistory(c.period, grain, firstEventAtMs),
    })),
    coverage,
    snapshot,
    activeUserTrend,
    kpis: [
      ...buildOperatingKpis(counts, grain, firstEventAtMs),
      ...buildOpsKpis(opsCounts, grain, firstEventAtMs),
    ],
    sentry,
    correctionsQueue,
    sourceFreshness,
    counts,
    opsCounts,
  };
}
