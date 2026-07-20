// evals/scenarios/uat.test.ts — G-T36-3 UAT harness: realistic parent search
// journeys over the REAL search path (evals/harness.ts → runUat), measuring the
// two launch-gate quality bars the T-36 exit-AC names — benchmark SEARCH SUCCESS
// (KPI #1, ≥80%) and useful result DENSITY (KPI #2, ≥70%) — plus zero-result
// RECOVERY (KPI #6) and the PRD §9 SC#4 no-empty-screen invariant.
//
//   • Fixture path (always runs): the shipped FIXTURE_LISTINGS via defaultEngine()
//     (== /api/search default mode). Proves the harness AND that the benchmark-tier
//     journeys clear ≥80% success / ≥70% density on the demo catalogue. The broader
//     'realistic' tier is measured and logged honestly — NOT force-gated green,
//     because the demo catalogue is deliberately thin (≈1 listing per category), so
//     single-category density is data-breadth-bound, exactly like live M1.
//   • Live-DB path (DB-gated, informational): the SAME journeys through the live
//     Postgres read model, logging the real (currently thin) catalogue's numbers.

import { afterAll, describe, expect, it } from 'vitest';
import uatData from '@/evals/uat.json';
import {
  buildDbEngine,
  defaultEngine,
  runUat,
  summarizeUat,
  type UatJourney,
  type UatRun,
  type UatSummary,
} from '@/evals/harness';

const JOURNEYS = (uatData as { journeys: unknown[] }).journeys as unknown as UatJourney[];

function fmt(tag: string, s: UatSummary): string {
  return (
    `[${tag}] journeys=${s.journeys} searchable=${s.searchable} ` +
    `success=${s.searchSuccessCount}/${s.searchable} (${s.searchSuccessPct}%) ` +
    `density=${s.densityMetCount}/${s.searchable} (${s.densityPct}%) ` +
    `recovery=${s.recoveredCount}/${s.recoveryJourneys} (${s.recoveryPct}%) ` +
    `emptyScreens=${s.emptyScreens} avgPrimary=${s.avgPrimary} avgPresented=${s.avgPresented}`
  );
}

describe('UAT harness (G-T36-3) — realistic parent journeys, default/fixture path', () => {
  const engine = defaultEngine();
  const pairs: { journey: UatJourney; run: UatRun }[] = JOURNEYS.map((journey) => ({ journey, run: runUat(engine, journey) }));
  const benchmark = pairs.filter((p) => p.journey.tier === 'benchmark');

  const all = summarizeUat(pairs);
  const bench = summarizeUat(benchmark);

  it('uat.json is a non-empty, well-formed journey catalogue', () => {
    expect(JOURNEYS.length).toBeGreaterThan(0);
    for (const j of JOURNEYS) {
      expect(typeof j.id).toBe('string');
      expect(typeof j.request?.q).toBe('string');
      expect(['benchmark', 'realistic']).toContain(j.tier);
      expect(j.relevantCategories === '*' || Array.isArray(j.relevantCategories)).toBe(true);
    }
    expect(new Set(JOURNEYS.map((j) => j.id)).size).toBe(JOURNEYS.length);
    // The benchmark tier must exist and be big enough for its rate to mean something.
    expect(benchmark.length).toBeGreaterThanOrEqual(4);
  });

  it('leaves ZERO empty screens on any valid search (PRD §9 SC#4)', () => {
    const dead = pairs.filter((p) => p.run.emptyScreen).map((p) => p.journey.id);
    expect(dead, `empty screens on: ${dead.join(', ')}`).toEqual([]);
  });

  it('every zero-result journey RECOVERS (expected options and/or explanation) — KPI #6', () => {
    expect(all.recoveryJourneys).toBeGreaterThan(0);
    expect(all.recoveryPct).toBe(100);
  });

  it('benchmark tier clears the T-36 exit bar: ≥80% search success (KPI #1)', () => {
    // eslint-disable-next-line no-console
    console.log(fmt('uat:benchmark:fixture', bench));
    expect(bench.searchSuccessPct).toBeGreaterThanOrEqual(80);
  });

  it('benchmark tier clears the T-36 exit bar: ≥70% useful density (KPI #2)', () => {
    expect(bench.densityPct).toBeGreaterThanOrEqual(70);
  });

  it('each benchmark journey individually returns a relevant, dense result set', () => {
    for (const { journey, run } of benchmark) {
      expect(run.success, `${journey.id}: expected relevant non-empty top-10`).toBe(true);
      expect(run.densityMet, `${journey.id}: expected ≥3 realistic options, got ${run.primaryCount}`).toBe(true);
    }
  });

  it('reports the honest FULL-suite coverage summary (benchmark + realistic)', () => {
    // eslint-disable-next-line no-console
    console.log(fmt('uat:all:fixture', all));
    // The realistic tier is intentionally NOT gated: single-category searches over the
    // thin demo catalogue return 1–2 options, so full-suite density sits well below the
    // 70% bar. That is a truthful reflection of catalogue breadth (mirrors live M1), and
    // is reported in docs/uat-harness.md — not hidden behind a passing threshold.
    expect(all.searchable).toBeGreaterThan(benchmark.length);
    expect(all.avgPresented).toBeGreaterThan(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('UAT harness — live Postgres catalogue (informational)', () => {
  afterAll(async () => {
    const { closePool } = await import('@/lib/db/client');
    await closePool();
  });

  it('runs the same parent journeys over the live catalogue and reports real coverage', async () => {
    const { engine, listingCount } = await buildDbEngine();
    const pairs: { journey: UatJourney; run: UatRun }[] = JOURNEYS.map((journey) => ({ journey, run: runUat(engine, journey) }));
    const summary = summarizeUat(pairs);

    // eslint-disable-next-line no-console
    console.log(`[uat:live-db-path] indexedListings=${listingCount} ` + fmt('uat:all:live-db', summary));
    if (listingCount === 0) {
      // eslint-disable-next-line no-console
      console.log(
        '[uat:live-db-path] NOTE: 0 ingested listings on this DB (clean reference seed carries no activity ' +
          'listings), so every searchable journey is zero-result — search success and density are 0% by ' +
          'construction. Expected while M1 ingestion is early; the real breadth measurement comes from staging ' +
          'with KIDS_FUN_SEARCH_BACKEND=database. This is a data-breadth fact, not a harness or engine defect.'
      );
    }

    // The engine under test is the DB-composed one, not the fixture engine.
    expect(pairs[0]?.run).toBeTruthy();
    const { meta } = engine.search({ q: '', minResults: 0, limit: 1 });
    expect(meta.fixtureBacked).toBe(false);
    // Data-volume-independent invariant: with no data, the two positive rates are 0.
    if (listingCount === 0) {
      expect(summary.searchSuccessPct).toBe(0);
      expect(summary.densityPct).toBe(0);
    } else {
      expect(summary.searchSuccessPct).toBeGreaterThanOrEqual(0);
      expect(summary.densityPct).toBeGreaterThanOrEqual(0);
    }
  });
});
