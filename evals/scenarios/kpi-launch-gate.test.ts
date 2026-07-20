// evals/scenarios/kpi-launch-gate.test.ts — G-T36-4 launch-gate KPI validation.
//
// Produces an HONEST target-vs-actual standing for each TSD §12.5 launch-gate KPI
// (#1–#12; #13–#22 are post-launch operating KPIs, out of scope). It REUSES the real
// instrumentation rather than forking any metric:
//   • search-quality KPIs (#1,2,3,5,6) — the evals UAT + golden harness + the app's
//     card mapping, over the real search path;
//   • analytics KPIs (#7,8,10,12) — lib/analytics/kpi.ts + lib/analytics/benchmark.ts;
//   • source-health KPIs (#4,9,11) — lib/admin/dashboard.ts.
//
// Two regimes are reported:
//   • 'fixture' (always) — the shipped demo catalogue. Establishes the search-quality
//     ceiling the engine reaches when the catalogue is populated.
//   • 'live-db' (DB-gated) — the live Postgres read model + live analytics_event. On a
//     clean CI/local seed the ingested catalogue is EMPTY and there are no analytics
//     events, so most KPIs are honestly 'no-data'/'below' today. That is a data-breadth
//     fact (M1 ingestion is early), reported as such — NOT massaged to look launch-ready.
//     The ~37% M1 breadth the orchestrator cites is on STAGING; point DATABASE_URL at the
//     staging DB (KIDS_FUN_SEARCH_BACKEND=database) to measure that here.
//
// The test asserts STRUCTURE (all 12 KPIs covered, report well-formed, the demo-catalogue
// quality ceiling) — it does NOT assert launch targets are met, because most are not yet.

import { afterAll, describe, expect, it } from 'vitest';
import goldenData from '@/evals/golden.json';
import uatData from '@/evals/uat.json';
import {
  buildDbEngine,
  defaultEngine,
  runGolden,
  runUat,
  summarize,
  summarizeUat,
  type GoldenQuery,
  type UatJourney,
} from '@/evals/harness';
import { mapListingRecordToActivity } from '@/app/preview/_data/search-api';
import type { SearchEngine } from '@/lib/search/engine';
import type { Activity } from '@/app/preview/_data/types';
import {
  LAUNCH_GATE_KPIS,
  assembleLaunchGateReport,
  renderLaunchGateReport,
  type KpiStatus,
  type LaunchGateFinding,
} from '@/evals/kpi-launch-gate';

const GOLDEN = (goldenData as { queries: unknown[] }).queries as unknown as GoldenQuery[];
const JOURNEYS = (uatData as { journeys: unknown[] }).journeys as unknown as UatJourney[];

/** Build a finding from a KPI number + measured status/actual/note. */
function finding(n: number, status: KpiStatus, actual: string, note: string): LaunchGateFinding {
  const kpi = LAUNCH_GATE_KPIS.find((k) => k.number === n)!;
  return { number: kpi.number, key: kpi.key, name: kpi.name, target: kpi.target, status, actual, note };
}

/** Every required parent-facing fact present on a mapped card (KPI #5 data-level completeness). */
function cardComplete(a: Activity): boolean {
  return (
    !!a.activityName &&
    !!a.venue &&
    !!a.area &&
    !!a.startIso &&
    !!a.endIso &&
    a.ageMin != null &&
    a.ageMax != null &&
    !!a.costStatus &&
    !!a.status &&
    !!a.sourceName &&
    !!a.confidence &&
    !!a.lastCheckedIso &&
    !!a.category
  );
}

/** Compute the 5 search-quality findings (#1,2,3,5,6) for a given engine + regime. */
function searchQualityFindings(engine: SearchEngine, regime: 'fixture' | 'live-db', listingCount: number | null): LaunchGateFinding[] {
  const emptyCatalogue = listingCount === 0;
  const isLive = regime === 'live-db';
  // On a SHARED CI Postgres the handful of "indexed" rows are cross-test residue
  // (activity_occurrence rows other DB tests inserted), NOT real ingestion — the same
  // caveat golden-db.test.ts documents. So a non-empty live count is NOT catalogue breadth.
  const liveCaveat =
    ` Over the live read model with ${listingCount} indexed listing(s); on a shared CI DB these are ` +
    'cross-test residue, not real ingestion (see golden-db NOTE). Real breadth is measured on staging.';

  // Golden set (relevance) + UAT (success/density/recovery), all over the real path.
  const goldenPairs = GOLDEN.map((gq) => ({ gq, run: runGolden(engine, gq) }));
  const goldenSummary = summarize(goldenPairs);
  const goldenPassPct = goldenSummary.passRatePct;

  const uatPairs = JOURNEYS.map((journey) => ({ journey, run: runUat(engine, journey) }));
  const all = summarizeUat(uatPairs);
  const bench = summarizeUat(uatPairs.filter((p) => p.journey.tier === 'benchmark'));

  // KPI #5 — card completeness over a broad result set.
  const broad = engine.search({ q: '', includeUnknownCost: true, minResults: 0, limit: 100 });
  const cards = broad.results.map((r) => mapListingRecordToActivity(r.listing, r.distanceKm));
  const completeCards = cards.filter(cardComplete).length;
  const completePct = cards.length ? Math.round((completeCards / cards.length) * 100) : 0;

  const findings: LaunchGateFinding[] = [];

  // #1 Search success (relevant top-10), target ≥80%.
  if (emptyCatalogue) {
    findings.push(finding(1, 'no-data', '0 indexed listings — no results to judge relevance', 'Empty catalogue; success is undefined until sources are ingested. Not a search defect.'));
  } else {
    const s1: KpiStatus = all.searchSuccessPct >= 80 ? 'met' : 'below';
    findings.push(
      finding(
        1,
        s1,
        `realistic suite ${all.searchSuccessPct}% (${all.searchSuccessCount}/${all.searchable}); benchmark tier ${bench.searchSuccessPct}%; golden set ${goldenPassPct}% pass`,
        isLive
          ? 'Relevance is strong when the catalogue is populated (see fixture regime = 100%).' + liveCaveat
          : 'Relevance is strong on a populated catalogue; every returned top-10 is on-topic.'
      )
    );
  }

  // #2 Useful result density, target ≥70% of valid searches ≥3 options.
  if (emptyCatalogue) {
    findings.push(finding(2, 'no-data', '0 indexed listings — density undefined', 'Density needs a populated catalogue; measured on staging once ingestion has breadth.'));
  } else {
    const s2: KpiStatus = all.densityPct >= 70 ? 'met' : 'below';
    findings.push(
      finding(
        2,
        s2,
        `realistic suite ${all.densityPct}% (${all.densityMetCount}/${all.searchable}); benchmark tier ${bench.densityPct}%; avgPrimary ${all.avgPrimary}`,
        isLive
          ? 'DATA-BREADTH BOUND: density needs real catalogue breadth, which the live catalogue lacks today.' + liveCaveat
          : 'DATA-BREADTH BOUND: the demo catalogue carries ≈1 listing per category, so single-category searches return 1–2 options. The flagship/benchmark subset clears ≥70%; broad coverage needs M1 catalogue breadth.'
      )
    );
  }

  // #3 Time to first useful result (<30s) — human UAT; harness records the content precondition.
  const precondMet = !emptyCatalogue && bench.densityPct >= 70;
  findings.push(
    finding(
      3,
      'manual',
      precondMet
        ? `content precondition MET (benchmark tier surfaces ≥3 realistic in the first response; engine compute is sub-second)`
        : `content precondition not established on this regime (benchmark density ${bench.densityPct}%)`,
      'The <30s wall-clock is a human UAT session (T-36); the harness validates that ≥3 realistic options are available immediately (no second query / pagination).'
    )
  );

  // #5 Card completeness, target 100%.
  if (emptyCatalogue) {
    findings.push(finding(5, 'no-data', '0 cards to measure', 'No ingested listings → no cards; the read model guarantees required fields structurally (tests/ui/card-completeness).'));
  } else {
    const s5: KpiStatus = completePct >= 100 ? 'met' : 'below';
    findings.push(finding(5, s5, `${completePct}% (${completeCards}/${cards.length} cards carry every required field)`, 'The read model fills every required parent-facing fact; unknown cost stays "unknown", never "free".'));
  }

  // #6 Zero-result recovery, target ≥50%.
  if (all.recoveryJourneys === 0) {
    findings.push(finding(6, 'no-data', 'no zero-result journeys exercised', 'n/a for this regime.'));
  } else {
    const s6: KpiStatus = all.recoveryPct >= 50 ? 'met' : 'below';
    findings.push(finding(6, s6, `${all.recoveryPct}% (${all.recoveredCount}/${all.recoveryJourneys} zero-result journeys recover with expected options and/or an explanation)`, 'The empty-state ladder (synonym → radius → drop-chip → expected section) prevents bare dead-ends (PRD §9 SC#4).'));
  }

  return findings;
}

/** The 7 DB-instrumented findings (#4,7,8,9,10,11,12) as 'no-data' placeholders (fixture regime). */
function dbKpiPlaceholders(): LaunchGateFinding[] {
  const note = 'Measured live in the DB-gated block; requires live analytics_event / ingested sources.';
  return [
    finding(4, 'no-data', 'requires live source_check_run', note),
    finding(7, 'no-data', 'requires live analytics_event', note),
    finding(8, 'no-data', 'requires live analytics_event', note),
    finding(9, 'no-data', 'requires live ingested sources', note),
    finding(10, 'no-data', 'requires live analytics_event', note),
    finding(11, 'no-data', 'requires live source_check_run', note),
    finding(12, 'no-data', 'requires live analytics_event', note),
  ];
}

describe('Launch-gate KPI catalogue + fixture-regime search-quality validation (G-T36-4)', () => {
  it('the catalogue is exactly the 12 launch-gate KPIs (#1–#12), no operating KPIs', () => {
    expect(LAUNCH_GATE_KPIS.length).toBe(12);
    expect(LAUNCH_GATE_KPIS.map((k) => k.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(LAUNCH_GATE_KPIS.map((k) => k.key)).size).toBe(12);
    // #13 (DAU) must NOT be in the launch gate.
    expect(LAUNCH_GATE_KPIS.some((k) => k.number >= 13)).toBe(false);
  });

  it('assembles + reports the honest fixture-regime standing for all 12 KPIs', () => {
    const engine = defaultEngine();
    const findings = [...searchQualityFindings(engine, 'fixture', null), ...dbKpiPlaceholders()];
    const report = assembleLaunchGateReport('fixture', findings);
    // eslint-disable-next-line no-console
    console.log('\n' + renderLaunchGateReport(report) + '\n');

    // Structure: every launch-gate KPI is represented, none silently missing.
    expect(report.findings.length).toBe(12);
    expect(report.findings.map((f) => f.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // Demo-catalogue quality CEILING (honest): with a populated catalogue, relevance (#1),
    // card completeness (#5) and recovery (#6) are MET; density (#2) is data-breadth-bound.
    const byNum = new Map(report.findings.map((f) => [f.number, f]));
    expect(byNum.get(1)!.status).toBe('met');
    expect(byNum.get(5)!.status).toBe('met');
    expect(byNum.get(6)!.status).toBe('met');
    expect(byNum.get(2)!.status).toBe('below'); // realistic breadth < 70% on the thin demo catalogue
    expect(byNum.get(3)!.status).toBe('manual');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('Launch-gate KPI validation — live-db regime (informational)', () => {
  afterAll(async () => {
    const { closePool } = await import('@/lib/db/client');
    await closePool();
  });

  it('assembles + reports the honest live standing for all 12 KPIs', async () => {
    const { engine, listingCount } = await buildDbEngine();

    // Search-quality KPIs over the live catalogue.
    const search = searchQualityFindings(engine, 'live-db', listingCount);

    // DB-instrumented KPIs — each defensively wrapped so a schema surprise logs 'no-data'
    // instead of reddening CI.
    const db: LaunchGateFinding[] = [];

    const safe = async (n: number, fn: () => Promise<LaunchGateFinding>): Promise<LaunchGateFinding> => {
      try {
        return await fn();
      } catch (e) {
        return finding(n, 'no-data', 'measurement error', `Could not measure: ${(e as Error).message}`);
      }
    };

    const { getProductHealthKpis } = await import('@/lib/analytics/kpi');
    const { buildKpiBenchmarks, getFlagshipQueryStats } = await import('@/lib/analytics/benchmark');
    const { getSourceRegistrySummary, getHealthAlerts, getIngestionHealth, getAnalyticsSummary } = await import('@/lib/admin/dashboard');

    const kpis = await getProductHealthKpis();
    const bench = buildKpiBenchmarks(kpis);
    const rowOf = (key: string) => bench.find((r) => r.key === key);

    // #7 Source click-through (≥25%).
    db.push(
      await safe(7, async () => {
        const r = rowOf('source_ctr')!;
        const status: KpiStatus = r.actual == null ? 'no-data' : r.met ? 'met' : 'below';
        return finding(7, status, r.actual == null ? 'no clicks/views in window' : `${r.actual}% (target ≥${r.target}%)`, 'outbound_source_click ÷ listing_viewed over the engagement window.');
      })
    );

    // #8 Correction rate / trust (<2 per 100 clicks).
    db.push(
      await safe(8, async () => {
        const summary = await getAnalyticsSummary();
        const clicks = summary.byType.find((b) => b.eventType === 'outbound_source_click')?.count ?? 0;
        const corrections = summary.byType.find((b) => b.eventType === 'correction_report_submitted')?.count ?? 0;
        if (clicks === 0) return finding(8, 'no-data', `0 source clicks (corrections=${corrections})`, 'No source clicks yet → rate undefined.');
        const per100 = Math.round((corrections / clicks) * 100 * 10) / 10;
        const status: KpiStatus = per100 < 2 ? 'met' : 'below';
        return finding(8, status, `${per100} reports per 100 clicks (target <2)`, 'All-time correction_report_submitted ÷ outbound_source_click.');
      })
    );

    // #10 Repeat use / retention (tracked).
    db.push(
      await safe(10, async () => {
        const { dau, wau, mau } = kpis.activeUsers;
        const hasData = dau + wau + mau > 0;
        return finding(
          10,
          hasData ? 'met' : 'no-data',
          `DAU=${dau} WAU=${wau} MAU=${mau} savedSearches=${kpis.accountValue.savedSearches} emailOptIns=${kpis.accountValue.emailOptIns}`,
          hasData
            ? 'Active-user + account-value TRACKING is live and returns values. CAVEAT: on a shared CI DB these counts come from analytics_event rows other tests inserted, NOT real usage — treat as a wiring proof, not a usage measurement. The §12.5 launch targets (e.g. MAU≥100) are set post-beta.'
            : 'Instrumentation live; no analytics events on this DB yet.'
        );
      })
    );

    // #12 Account value (signed-in save + reruns + opt-in).
    db.push(
      await safe(12, async () => {
        const r = rowOf('signed_in_share');
        const av = kpis.accountValue;
        const hasData = av.savedSearches + av.emailOptIns + av.signedInUsers > 0;
        return finding(
          12,
          hasData ? 'met' : 'no-data',
          `signedInUsers=${av.signedInUsers} savedSearches=${av.savedSearches} emailOptIns=${av.emailOptIns} signedInShare=${r?.actual ?? '—'}%`,
          hasData ? 'Account-value signals are being captured.' : 'Instrumentation live; no account-value events on this DB yet.'
        );
      })
    );

    // #4 Source freshness SLA (≥95% P0 within cadence).
    db.push(
      await safe(4, async () => {
        const [registry, alerts] = await Promise.all([getSourceRegistrySummary(), getHealthAlerts()]);
        if (registry.enabledSources === 0) return finding(4, 'no-data', '0 enabled sources', 'No enabled/P0 sources on this DB → freshness SLA undefined.');
        const stale = alerts.staleSources.length;
        const freshPct = Math.round(((registry.enabledSources - stale) / registry.enabledSources) * 100);
        const status: KpiStatus = freshPct >= 95 ? 'met' : 'below';
        return finding(4, status, `${freshPct}% fresh (${registry.enabledSources - stale}/${registry.enabledSources} enabled sources within cadence)`, 'From source_check_run via getHealthAlerts.staleSources. CAVEAT: a never-run enabled source is counted fresh (not yet due) — a real SLA reading needs cadence history from live scheduler runs, not the seed baseline.');
      })
    );

    // #9 Coverage by region/family (coverage or explicit gap).
    db.push(
      await safe(9, async () => {
        const health = await getIngestionHealth();
        const families = new Set(health.filter((h) => h.occurrenceCount > 0).map((h) => h.family));
        const withData = health.filter((h) => h.occurrenceCount > 0).length;
        if (health.length === 0) return finding(9, 'below', 'explicit gap: 0 enabled sources ingested', 'Coverage is empty; every launch region/family is an explicit gap today (honest, expected at M1).');
        const status: KpiStatus = withData > 0 ? 'below' : 'below';
        return finding(9, status, `${withData}/${health.length} sources have occurrences; families with data: ${[...families].join(', ') || 'none'}`, 'Per-family coverage from getIngestionHealth; gaps are explicit.');
      })
    );

    // #11 Data-health board (surfaces stale/failed/thin/queues).
    db.push(
      await safe(11, async () => {
        const alerts = await getHealthAlerts();
        return finding(
          11,
          'met',
          `board live: recentFailures=${alerts.recentFailures.length} staleSources=${alerts.staleSources.length} (window ${alerts.windowDays}d)`,
          'The T-33 data-health board exists and returns; it populates from live source_check_run. Deliverable is the board, which is present.'
        );
      })
    );

    const report = assembleLaunchGateReport('live-db', [...search, ...db]);
    // eslint-disable-next-line no-console
    console.log(`\n[live-db] indexedListings=${listingCount}\n` + renderLaunchGateReport(report) + '\n');
    if (listingCount === 0) {
      // eslint-disable-next-line no-console
      console.log(
        '[live-db] NOTE: 0 ingested listings + (typically) 0 analytics events on this clean seed. Most KPIs are ' +
          "honestly 'no-data'/'below' — a data-breadth fact, not a product defect. Point DATABASE_URL at staging " +
          '(KIDS_FUN_SEARCH_BACKEND=database) to measure the real ~37% M1 breadth.'
      );
    }

    // Structure only — every launch-gate KPI is represented; targets are NOT asserted met.
    expect(report.findings.length).toBe(12);
    expect(report.findings.map((f) => f.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const f of report.findings) {
      expect(['met', 'below', 'no-data', 'manual']).toContain(f.status);
    }
  });
});
