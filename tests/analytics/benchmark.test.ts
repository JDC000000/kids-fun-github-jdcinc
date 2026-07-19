// tests/analytics/benchmark.test.ts — READ-SIDE product-health BENCHMARKS (T32, G-T32-5).
//
// Two layers, mirroring tests/analytics/kpi.test.ts:
//  1. Pure logic (evaluateBenchmark / buildKpiBenchmarks) — always run, no DB. These
//     drive the tile's on-target / off-target / no-data verdicts, so their edge cases
//     (a null actual must NEVER score as a miss) are pinned exactly.
//  2. The flagship-query SQL reader against real Postgres — DB-gated (skipped without
//     DATABASE_URL). It asserts the DELTA a uniquely-marked seed produces on the
//     additive count fields, so it's deterministic regardless of what else is already
//     in the shared analytics_event table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, query } from '../../lib/db/client';
import {
  buildFlagshipBenchmarks,
  buildKpiBenchmarks,
  evaluateBenchmark,
  getFlagshipQueryStats,
  KPI_BENCHMARK_TARGETS,
  type BenchmarkTargetDef,
} from '../../lib/analytics/benchmark';
import type { ProductHealthKpis } from '../../lib/analytics/kpi';

// ── Layer 1: pure logic (no DB) ──────────────────────────────────────────────
describe('evaluateBenchmark', () => {
  const gte: BenchmarkTargetDef = { key: 'g', label: 'G', target: 25, direction: 'gte', format: 'pct', source: 't' };
  const lte: BenchmarkTargetDef = { key: 'l', label: 'L', target: 10, direction: 'lte', format: 'pct', source: 't' };

  it('scores a "higher is better" target', () => {
    expect(evaluateBenchmark(gte, 30).met).toBe(true);
    expect(evaluateBenchmark(gte, 25).met).toBe(true); // boundary is inclusive
    expect(evaluateBenchmark(gte, 24).met).toBe(false);
  });

  it('scores a "lower is better" target', () => {
    expect(evaluateBenchmark(lte, 5).met).toBe(true);
    expect(evaluateBenchmark(lte, 10).met).toBe(true); // boundary inclusive
    expect(evaluateBenchmark(lte, 11).met).toBe(false);
  });

  it('never scores a null/non-finite actual as a miss — it is "no data" (met=null)', () => {
    expect(evaluateBenchmark(gte, null).met).toBeNull();
    expect(evaluateBenchmark(lte, null).met).toBeNull();
    expect(evaluateBenchmark(gte, Number.NaN).met).toBeNull();
  });

  it('carries the target definition through onto the row', () => {
    const row = evaluateBenchmark(gte, 30);
    expect(row).toMatchObject({ key: 'g', label: 'G', target: 25, direction: 'gte', actual: 30 });
  });
});

describe('buildKpiBenchmarks', () => {
  function kpis(overrides: Partial<ProductHealthKpis> = {}): ProductHealthKpis {
    return {
      windows: { engagementDays: 7, dauDays: 1, wauDays: 7, mauDays: 30, accountDays: 30 },
      engagement: {
        searches: 140, // 20/day over 7d → exactly the searches/day target
        listingViews: 100,
        outboundClicks: 30, // CTR 30% ≥ 25% target
        searchesWithResults: 10,
        zeroResultSearches: 1, // 10% ≤ 10% target
        broadenedSearches: 2,
      },
      activeUsers: { dau: 5, wau: 20, mau: 100 }, // MAU 100 ≥ 100 target
      accountValue: { savedSearches: 3, emailOptIns: 4, signInEvents: 8, signedInUsers: 20 }, // 20% ≥ 20%
      ...overrides,
    };
  }

  it('produces one row per target, all on-target for the tuned snapshot', () => {
    const rows = buildKpiBenchmarks(kpis());
    expect(rows).toHaveLength(KPI_BENCHMARK_TARGETS.length);
    expect(rows.every((r) => r.met === true)).toBe(true);
    const ctr = rows.find((r) => r.key === 'source_ctr');
    expect(ctr?.actual).toBe(30);
  });

  it('flags below-target metrics and reports no-data where the denominator is 0', () => {
    const rows = buildKpiBenchmarks(
      kpis({
        engagement: {
          searches: 14, // 2/day < 20/day target
          listingViews: 0, // CTR denominator 0 → null → no data
          outboundClicks: 3,
          searchesWithResults: 0, // zero-result denominator 0 → null → no data
          zeroResultSearches: 0,
          broadenedSearches: 0,
        },
        activeUsers: { dau: 1, wau: 2, mau: 0 }, // MAU 0 < target; signed-in share denom 0 → null
      })
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.source_ctr.met).toBeNull();
    expect(byKey.zero_result.met).toBeNull();
    expect(byKey.searches_per_day.met).toBe(false);
    expect(byKey.mau.met).toBe(false);
    expect(byKey.signed_in_share.met).toBeNull();
  });
});

describe('buildFlagshipBenchmarks (pure)', () => {
  it('derives zero-result and avg-results rows from stats', () => {
    const rows = buildFlagshipBenchmarks({
      label: 'x',
      windowDays: 30,
      runs: 10,
      searchesWithResults: 10,
      zeroResultRuns: 0,
      broadenedRuns: 1,
      avgResults: 7,
      lastRunAt: null,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.flagship_zero_result.actual).toBe(0);
    expect(byKey.flagship_zero_result.met).toBe(true); // 0% ≤ 0% target
    expect(byKey.flagship_avg_results.actual).toBe(7);
    expect(byKey.flagship_avg_results.met).toBe(true); // 7 ≥ 5 target
  });

  it('reports no-data avg results as met=null, not a miss', () => {
    const rows = buildFlagshipBenchmarks({
      label: 'x',
      windowDays: 30,
      runs: 0,
      searchesWithResults: 0,
      zeroResultRuns: 0,
      broadenedRuns: 0,
      avgResults: null,
      lastRunAt: null,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.flagship_avg_results.met).toBeNull();
    expect(byKey.flagship_zero_result.met).toBeNull(); // pct(0,0) → null
  });
});

// ── Layer 2: the flagship SQL reader against real Postgres ───────────────────
const hasDb = Boolean(process.env.DATABASE_URL);

/** Insert one search_performed row with the given query/region/result shape. */
async function insertSearch(opts: {
  q: string;
  regions?: string[];
  filters?: string[];
  total?: number | null;
  broadened?: boolean;
}): Promise<void> {
  const ctx = {
    q: opts.q,
    regions: opts.regions ?? [],
    filters: opts.filters ?? [],
  };
  const summary =
    opts.total == null && opts.broadened == null
      ? null
      : { total: opts.total ?? undefined, broadened: opts.broadened ?? false };
  await query(
    `INSERT INTO analytics_event (event_type, user_or_session, search_context_json, result_summary_json, created_at)
       VALUES ('search_performed', $1, $2::jsonb, $3::jsonb, now())`,
    [
      randomUUID(),
      JSON.stringify(ctx),
      summary == null ? null : JSON.stringify(summary),
    ]
  );
}

describe.skipIf(!hasDb)('getFlagshipQueryStats (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('counts only matching flagship runs and reports their result shape (delta-based)', async () => {
    const before = await getFlagshipQueryStats();

    // 3 matching runs: gym + a van/near-me location signal.
    await insertSearch({ q: 'open gym near east van', regions: ['van'], total: 8 });
    await insertSearch({ q: 'drop-in gym', filters: ['near_me'], total: 4 });
    await insertSearch({ q: 'gym in van', regions: [], total: 0 }); // zero-result, still matches via 'van' in q
    // 1 matching run that had to broaden.
    await insertSearch({ q: 'open gym van', regions: ['van'], total: 2, broadened: true });
    // Non-matching controls: no 'gym', or 'gym' without any van/near-me signal.
    await insertSearch({ q: 'swimming lessons', regions: ['van'], total: 5 });
    await insertSearch({ q: 'gym in richmond', regions: ['rmd'], total: 9 });

    const after = await getFlagshipQueryStats();

    expect(after.runs - before.runs).toBe(4);
    expect(after.searchesWithResults - before.searchesWithResults).toBe(4);
    expect(after.zeroResultRuns - before.zeroResultRuns).toBe(1);
    expect(after.broadenedRuns - before.broadenedRuns).toBe(1);
    expect(after.avgResults).not.toBeNull();
    expect(after.lastRunAt).not.toBeNull();
  });
});
