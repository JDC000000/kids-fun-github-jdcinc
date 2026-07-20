// evals/scenarios/golden.test.ts — G-T36-2 golden query set over the REAL default
// search path (evals/harness.ts → makeFixtureEngine, the same engine /api/search
// ships in fixture mode). Each golden query's expected top-results are asserted, and
// the flagship "open gym near East Van" reuses the ONE definition of that query that
// already exists — lib/analytics/benchmark.ts FLAGSHIP_QUERY — rather than inventing a
// second one. A coverage summary is logged for the findings doc / a future UAT harness.

import { describe, it, expect } from 'vitest';
import { FLAGSHIP_QUERY } from '@/lib/analytics/benchmark';
import goldenData from '@/evals/golden.json';
import {
  defaultEngine,
  runGolden,
  checkExpectations,
  summarize,
  type GoldenQuery,
  type GoldenRun,
} from '@/evals/harness';

const GOLDEN = (goldenData as { queries: unknown[] }).queries as unknown as GoldenQuery[];
const engine = defaultEngine();

describe('Golden query set (G-T36-2) — real default search path', () => {
  const pairs: { gq: GoldenQuery; run: GoldenRun }[] = GOLDEN.map((gq) => ({ gq, run: runGolden(engine, gq) }));

  it('golden.json is a non-empty, well-formed set', () => {
    expect(GOLDEN.length).toBeGreaterThan(0);
    for (const gq of GOLDEN) {
      expect(typeof gq.id).toBe('string');
      expect(typeof gq.request?.q).toBe('string');
      expect(gq.expect).toBeTruthy();
    }
    // ids are unique
    expect(new Set(GOLDEN.map((g) => g.id)).size).toBe(GOLDEN.length);
  });

  for (const { gq, run } of pairs) {
    it(`[${gq.id}] "${gq.label}" meets its asserted expectations`, () => {
      const failures = checkExpectations(gq, run);
      expect(failures, `${gq.id}: ${failures.join('; ')}`).toEqual([]);
    });
  }

  it('flagship reuses lib/analytics/benchmark.ts FLAGSHIP_QUERY (no second definition)', () => {
    const flagship = GOLDEN.find((g) => g.id === 'flagship-open-gym-east-van');
    expect(flagship, 'flagship golden query must exist').toBeTruthy();
    // The flagship golden thresholds are exactly the ratified benchmark thresholds.
    expect(flagship!.expect.minResults).toBe(FLAGSHIP_QUERY.minAvgResults);
    expect(flagship!.expect.maxZeroResultPct).toBe(FLAGSHIP_QUERY.maxZeroResultPct);
    expect(flagship!.label).toBe(FLAGSHIP_QUERY.label);
  });

  it('flagship "open gym near East Van" returns a relevant, non-empty top-10 (KPI #1)', () => {
    const flagship = GOLDEN.find((g) => g.id === 'flagship-open-gym-east-van')!;
    const run = runGolden(engine, flagship);
    // Non-empty and above the benchmark's minimum average.
    expect(run.zeroResult).toBe(false);
    expect(run.total).toBeGreaterThanOrEqual(FLAGSHIP_QUERY.minAvgResults);
    // The whole top-10 is on-topic (open gym / gymnasium play / family drop-in are all
    // primaryCategoryKey 'open_gym' in the catalogue) — no unrelated categories leak in.
    const top10 = run.response.results.slice(0, 10);
    expect(top10.every((r) => r.listing.primaryCategoryKey === 'open_gym')).toBe(true);
    // The nearest, freshest, free East-Van open gym ranks #1.
    expect(run.topId).toBe('l-opengym-van');
    // The hidden cancelled gym never surfaces.
    expect(run.resultIds).not.toContain('l-cancelled-gym');
  });

  it('reports the coverage summary the harness produces (default/fixture path)', () => {
    const summary = summarize(pairs);
    // eslint-disable-next-line no-console
    console.log(
      `[golden:default-fixture-path] queries=${summary.queries} pass=${summary.passedQueries}/${summary.queries} ` +
        `(${summary.passRatePct}%) zeroResult=${summary.zeroResultPct}% avgResults=${summary.avgResults}`
    );
    // On the curated fixture path the whole set is green — this is the engine working
    // over the shipped demo catalogue, NOT a claim that launch-quality search exists
    // over the (currently thin) live ingested data. See golden-db.test.ts for that.
    expect(summary.passRatePct).toBe(100);
    expect(summary.zeroResultQueries).toBe(0);
  });
});
