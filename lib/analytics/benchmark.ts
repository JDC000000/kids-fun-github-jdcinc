// lib/analytics/benchmark.ts — READ-SIDE product-health BENCHMARKS (M5 / T32, G-T32-5).
//
// Two things the /admin/product-health benchmark tile needs, both pure consumers of
// the same live analytics_event data kpi.ts reads (SELECT-only; imports NOTHING from
// the analytics write side):
//
//   1. TARGET-vs-ACTUAL for the KPIs Round 16 already computes. A small, explicit
//      table of launch targets (the ONE real, ratified target — source CTR ≥ 25%,
//      TSD §12.5 KPI #7 — is reused verbatim from kpi.ts; the rest are launch goals
//      declared here so every KPI has a bar to read against, clearly labelled as such
//      so nobody mistakes a working goal for a ratified SLA). evaluateBenchmark() is a
//      pure function: (target, actual) → met / below / no-data, unit-tested with no DB.
//
//   2. The flagship "open gym near East Van" query as a NAMED benchmark — how the
//      canonical query actually performs (run count, average result size, zero-result
//      and broadened rates), read live from the search_performed events. A canonical
//      flagship query is exactly the kind of thing a product owner wants a standing
//      benchmark on: if *that* search starts coming back thin or empty, the catalogue
//      has a hole.
import { query } from '@/lib/db/client';
import {
  SOURCE_CTR_TARGET_PCT,
  perDay,
  pct,
  signedInSharePct,
  sourceCtrPct,
  zeroResultPct,
  type ProductHealthKpis,
} from './kpi';

// ── Launch targets ───────────────────────────────────────────────────────────
// Provenance is explicit per target. Only SOURCE_CTR_TARGET_PCT is a ratified KPI
// target (TSD §12.5 #7); the others are launch GOALS set here purely so the tile can
// show target-vs-actual — tune them as real targets are agreed. Kept as named
// constants (not literals buried in the config) so a future round can move any of
// them to the spec without hunting.
/** Zero-result search rate should stay at/under this (catalogue-coverage goal). */
export const ZERO_RESULT_TARGET_PCT = 10;
/** Searches/day launch engagement floor. */
export const SEARCHES_PER_DAY_TARGET = 20;
/** Monthly-active-users launch reach goal. */
export const MAU_TARGET = 100;
/** Share of MAU that has signed in at least once — account-adoption goal. */
export const SIGNED_IN_SHARE_TARGET_PCT = 20;

/** Whether higher (`gte`) or lower (`lte`) is better for a metric. */
export type BenchmarkDirection = 'gte' | 'lte';
/** How the tile should render a benchmark's numbers. */
export type BenchmarkFormat = 'pct' | 'perDay' | 'count' | 'results';

/** A named target and how to read it. */
export interface BenchmarkTargetDef {
  key: string;
  label: string;
  target: number;
  direction: BenchmarkDirection;
  format: BenchmarkFormat;
  /** Where the target comes from — 'TSD §12.5 KPI #7' vs 'launch goal'. */
  source: string;
}

/** A target joined to its live actual and the verdict — the tile's row model. */
export interface BenchmarkRow extends BenchmarkTargetDef {
  /** The live value, or null when there is not enough data to state it. */
  actual: number | null;
  /** true = target met, false = below target, null = no data (→ em-dash, neutral). */
  met: boolean | null;
}

/**
 * Evaluate one target against its live actual. Pure & null-safe: a null actual
 * ("not enough data") is never scored as a miss — it returns met=null so the UI
 * shows a neutral em-dash instead of a misleading "below target".
 */
export function evaluateBenchmark(def: BenchmarkTargetDef, actual: number | null): BenchmarkRow {
  let met: boolean | null;
  if (actual == null || !Number.isFinite(actual)) {
    met = null;
  } else if (def.direction === 'gte') {
    met = actual >= def.target;
  } else {
    met = actual <= def.target;
  }
  return { ...def, actual, met };
}

/** The KPI benchmark targets, in display order. */
export const KPI_BENCHMARK_TARGETS: readonly BenchmarkTargetDef[] = [
  {
    key: 'source_ctr',
    label: 'Source click-through rate',
    target: SOURCE_CTR_TARGET_PCT,
    direction: 'gte',
    format: 'pct',
    source: 'TSD §12.5 KPI #7 (ratified)',
  },
  {
    key: 'zero_result',
    label: 'Zero-result search rate',
    target: ZERO_RESULT_TARGET_PCT,
    direction: 'lte',
    format: 'pct',
    source: 'launch goal',
  },
  {
    key: 'searches_per_day',
    label: 'Searches per day',
    target: SEARCHES_PER_DAY_TARGET,
    direction: 'gte',
    format: 'perDay',
    source: 'launch goal',
  },
  {
    key: 'mau',
    label: 'Monthly active users',
    target: MAU_TARGET,
    direction: 'gte',
    format: 'count',
    source: 'launch goal',
  },
  {
    key: 'signed_in_share',
    label: 'Signed-in share of MAU',
    target: SIGNED_IN_SHARE_TARGET_PCT,
    direction: 'gte',
    format: 'pct',
    source: 'launch goal',
  },
] as const;

/**
 * Join the KPI targets to the live actuals derived from a ProductHealthKpis snapshot,
 * reusing kpi.ts's own pure derivation helpers so the benchmark actuals are computed
 * exactly the way the KPI tiles compute them (one source of truth, no drift). Pure.
 */
export function buildKpiBenchmarks(kpis: ProductHealthKpis): BenchmarkRow[] {
  const { windows, engagement, activeUsers, accountValue } = kpis;

  const actuals: Record<string, number | null> = {
    source_ctr: sourceCtrPct(engagement.outboundClicks, engagement.listingViews),
    zero_result: zeroResultPct(engagement.zeroResultSearches, engagement.searchesWithResults),
    searches_per_day: perDay(engagement.searches, windows.engagementDays),
    mau: activeUsers.mau,
    signed_in_share: signedInSharePct(accountValue.signedInUsers, activeUsers.mau),
  };

  return KPI_BENCHMARK_TARGETS.map((def) => evaluateBenchmark(def, actuals[def.key] ?? null));
}

// ── Flagship named query benchmark ────────────────────────────────────────────

/** How many trailing days the flagship-query benchmark aggregates over. */
export const FLAGSHIP_WINDOW_DAYS = 30;

/** The canonical flagship query we hold a standing benchmark on. */
export const FLAGSHIP_QUERY = {
  label: 'open gym near East Van',
  /** A flagship query should essentially never come back empty. */
  maxZeroResultPct: 0,
  /** …and should surface a healthy result set on average. */
  minAvgResults: 5,
} as const;

/** Live performance of the flagship query over the benchmark window. */
export interface FlagshipQueryStats {
  label: string;
  windowDays: number;
  /** Matching search_performed runs in the window. */
  runs: number;
  /** …of those, how many carried a result `total` (the rate denominator). */
  searchesWithResults: number;
  /** …of those, how many returned zero results. */
  zeroResultRuns: number;
  /** …how many the engine had to broaden to fill. */
  broadenedRuns: number;
  /** Mean result `total` across runs that reported one; null when none did. */
  avgResults: number | null;
  /** Most recent time the flagship query was run; null if never (in window). */
  lastRunAt: string | null;
}

/**
 * Read the flagship "open gym near East Van" query's live performance. It matches
 * search_performed events whose captured query text mentions a gym AND that carry an
 * East-Van location signal (the `van` region chip, a near-me filter, or "van" in the
 * text) — the same non-PII search_context_json fields lib/analytics/record.ts writes.
 * String comparisons on the ->> extractions and a digit-guard before the ::numeric
 * cast keep a legacy/hand-inserted row from erroring the whole query, exactly as
 * kpi.ts does. Safe on an empty table (all zeros, avg null, lastRunAt null).
 */
export async function getFlagshipQueryStats(
  windowDays: number = FLAGSHIP_WINDOW_DAYS
): Promise<FlagshipQueryStats> {
  const days = Number.isFinite(windowDays) ? Math.min(120, Math.max(1, Math.trunc(windowDays))) : FLAGSHIP_WINDOW_DAYS;

  const rows = await query<{
    runs: number;
    searches_with_results: number;
    zero_result_runs: number;
    broadened_runs: number;
    avg_results: string | null;
    last_run_at: string | null;
  }>(
    `
    WITH flagship AS (
      SELECT result_summary_json, created_at
      FROM analytics_event
      WHERE event_type = 'search_performed'
        AND created_at >= now() - ($1::int * interval '1 day')
        AND lower(coalesce(search_context_json ->> 'q', '')) LIKE '%gym%'
        AND (
              (search_context_json -> 'regions' ? 'van')
          OR  (search_context_json -> 'filters' ? 'near_me')
          OR  lower(coalesce(search_context_json ->> 'q', '')) LIKE '%van%'
        )
    )
    SELECT
      count(*)::int AS runs,
      count(*) FILTER (WHERE result_summary_json ? 'total')::int AS searches_with_results,
      count(*) FILTER (
        WHERE result_summary_json ? 'total' AND (result_summary_json ->> 'total') = '0'
      )::int AS zero_result_runs,
      count(*) FILTER (WHERE (result_summary_json ->> 'broadened') = 'true')::int AS broadened_runs,
      avg((result_summary_json ->> 'total')::numeric) FILTER (
        WHERE result_summary_json ? 'total' AND (result_summary_json ->> 'total') ~ '^[0-9]+$'
      ) AS avg_results,
      max(created_at) AS last_run_at
    FROM flagship
    `,
    [days]
  );

  const r = rows[0];
  const avg = r?.avg_results == null ? null : Number(r.avg_results);
  return {
    label: FLAGSHIP_QUERY.label,
    windowDays: days,
    runs: r?.runs ?? 0,
    searchesWithResults: r?.searches_with_results ?? 0,
    zeroResultRuns: r?.zero_result_runs ?? 0,
    broadenedRuns: r?.broadened_runs ?? 0,
    avgResults: avg == null || Number.isNaN(avg) ? null : Math.round(avg * 10) / 10,
    lastRunAt: r?.last_run_at ?? null,
  };
}

/**
 * The flagship query's own target-vs-actual rows (zero-result rate ≤ target and
 * average results ≥ target), reusing the shared evaluateBenchmark(). Pure.
 */
export function buildFlagshipBenchmarks(stats: FlagshipQueryStats): BenchmarkRow[] {
  const zeroPct = pct(stats.zeroResultRuns, stats.searchesWithResults);
  return [
    evaluateBenchmark(
      {
        key: 'flagship_zero_result',
        label: 'Zero-result rate',
        target: FLAGSHIP_QUERY.maxZeroResultPct,
        direction: 'lte',
        format: 'pct',
        source: 'flagship benchmark',
      },
      zeroPct
    ),
    evaluateBenchmark(
      {
        key: 'flagship_avg_results',
        label: 'Average results returned',
        target: FLAGSHIP_QUERY.minAvgResults,
        direction: 'gte',
        format: 'results',
        source: 'flagship benchmark',
      },
      stats.avgResults
    ),
  ];
}
