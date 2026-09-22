// tests/analytics/operating.test.ts — operating-KPI period series + trend model (T41).
//
// Two layers, mirroring the kpi/trends suites this module sits beside:
//  1. Pure model + derivation helpers — always run, no DB. This is where the honesty
//     properties are PINNED: the in-progress period never becomes a trend endpoint,
//     "no data" is null (never 0), a small denominator raises lowSample, and a KPI
//     with fewer than two complete periods reports 'unknown' rather than a made-up
//     arrow. Those are the behaviours a future change could silently regress.
//  2. The real SQL against real Postgres — DB-gated (skipped without DATABASE_URL,
//     like every sibling suite). Rather than truncate the shared analytics_event
//     table, it seeds rows keyed to GLOBALLY-UNIQUE uuid session ids and asserts the
//     DELTA the seed produces on the always-present "today" bucket. Deterministic
//     regardless of what else is already in the table.
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, query } from '../../lib/db/client';
import {
  ACTIVATION_EVENT_TYPES,
  DAILY_REVIEW_PERIODS,
  MAX_PERIODS,
  MIN_RATE_SAMPLE,
  MONTHLY_REVIEW_PERIODS,
  SEARCH_OUTCOME_WINDOW_MINUTES,
  activationPct,
  buildOperatingKpi,
  buildOperatingKpis,
  clampPeriods,
  daysInPeriod,
  defaultPeriods,
  getDataCoverage,
  getOperatingPeriodCounts,
  grainInterval,
  isPreHistory,
  meetsTarget,
  nonEmptyResultPct,
  parseGrain,
  periodEndMs,
  periodLabel,
  retentionPct,
  savedSearchAndEmailTotal,
  searchEngagementPct,
  trendDirection,
  trendVerdict,
  zeroResultRecoveryPct,
  type KpiPoint,
  type OperatingKpiDef,
  type OperatingPeriodCounts,
} from '../../lib/analytics/operating';
import { SOURCE_CTR_TARGET_PCT } from '../../lib/analytics/kpi';
import { getActivityTrend } from '../../lib/analytics/trends';
import { ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD } from '../../lib/security/search-rate-limit';
import {
  MAU_TARGET,
  SEARCHES_PER_DAY_TARGET,
  SIGNED_IN_SHARE_TARGET_PCT,
  ZERO_RESULT_TARGET_PCT,
} from '../../lib/analytics/benchmark';

const hasDb = Boolean(process.env.DATABASE_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: grain / window utilities
// ─────────────────────────────────────────────────────────────────────────────

describe('grain utilities', () => {
  it('maps a grain to its Postgres interval and default window', () => {
    expect(grainInterval('day')).toBe('1 day');
    expect(grainInterval('month')).toBe('1 month');
    expect(defaultPeriods('day')).toBe(DAILY_REVIEW_PERIODS);
    expect(defaultPeriods('month')).toBe(MONTHLY_REVIEW_PERIODS);
  });

  it('clamps a requested period count into a bounded, sane range', () => {
    expect(clampPeriods(undefined, 'day')).toBe(DAILY_REVIEW_PERIODS);
    expect(clampPeriods(Number.NaN, 'month')).toBe(MONTHLY_REVIEW_PERIODS);
    expect(clampPeriods(7, 'day')).toBe(7);
    expect(clampPeriods(1, 'day')).toBe(2); // a trend needs at least two buckets
    expect(clampPeriods(-5, 'day')).toBe(2);
    expect(clampPeriods(10_000, 'day')).toBe(MAX_PERIODS); // never an unbounded scan
  });

  it('parses the review-mode param, defaulting to the daily review', () => {
    expect(parseGrain('monthly')).toBe('month');
    expect(parseGrain('month')).toBe('month');
    expect(parseGrain('daily')).toBe('day');
    expect(parseGrain(undefined)).toBe('day');
    expect(parseGrain('nonsense')).toBe('day');
    expect(parseGrain(['monthly', 'daily'])).toBe('month'); // first value wins
  });

  it('labels a bucket by grain', () => {
    expect(periodLabel('2026-07-25', 'day')).toBe('2026-07-25');
    expect(periodLabel('2026-07-01', 'month')).toBe('2026-07');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: targets must be IMPORTED, not copied (A2/A3)
//
// The UI renders a provenance line naming benchmark.ts / kpi.ts as each target's
// source. If a target were a hardcoded literal, tuning a launch goal would move
// /admin/product-health while /admin/operating silently kept the stale number and
// went on citing the constant as its authority. These tests bind the two together, so
// changing a constant either updates this dashboard or fails the build.
// ─────────────────────────────────────────────────────────────────────────────

describe('KPI targets are bound to the canonical constants', () => {
  const byKey = (key: string) => {
    const daily = buildOperatingKpis([counts()], 'day').find((k) => k.key === key);
    const monthly = buildOperatingKpis([counts()], 'month').find((k) => k.key === key);
    return daily ?? monthly;
  };

  it('sources every target from benchmark.ts / kpi.ts rather than a literal', () => {
    expect(byKey('source_ctr')?.target?.value).toBe(SOURCE_CTR_TARGET_PCT);
    expect(byKey('zero_result_rate')?.target?.value).toBe(ZERO_RESULT_TARGET_PCT);
    expect(byKey('searches_per_day')?.target?.value).toBe(SEARCHES_PER_DAY_TARGET);
    expect(byKey('signed_in_share')?.target?.value).toBe(SIGNED_IN_SHARE_TARGET_PCT);
  });

  it('derives the non-empty-result target as the complement of the zero-result target', () => {
    // Not "90" — the two KPIs are complements, so their targets must move together.
    expect(byKey('non_empty_results')?.target?.value).toBe(100 - ZERO_RESULT_TARGET_PCT);
  });

  it('renders the MAU target it promises in its provenance line (A3)', () => {
    const mau = byKey('active_actors');
    expect(mau?.provenance).toContain('MAU_TARGET');
    expect(mau?.target?.value).toBe(MAU_TARGET);
    expect(mau?.target?.direction).toBe('gte');
  });

  it('never NAMES a target constant in its provenance without rendering one', () => {
    // Matches an actual constant identifier (SOURCE_CTR_TARGET_PCT, MAU_TARGET…), which
    // is a positive claim that a target exists — this is exactly the A3 defect shape.
    // It deliberately does NOT match lowercase prose like "not a ratified … target",
    // which several PROPOSED KPIs use to DISCLAIM having one. (An earlier, naive
    // /target/i here failed on precisely that distinction.)
    const NAMES_A_TARGET_CONSTANT = /[A-Z][A-Z0-9_]*TARGET[A-Z0-9_]*/;
    for (const kpi of [...buildOperatingKpis([counts()], 'day'), ...buildOperatingKpis([counts()], 'month')]) {
      if (NAMES_A_TARGET_CONSTANT.test(kpi.provenance)) {
        expect(kpi.target, `${kpi.key} names a target constant in its provenance`).toBeDefined();
      }
    }
  });

  it('the PROPOSED KPIs correctly carry no target at all', () => {
    // The other half of the contract: an unratified definition must not invent one.
    for (const key of ['activation', 'retention', 'zero_result_recovery', 'search_engagement']) {
      expect(byKey(key)?.target, `${key} must not carry an invented target`).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: pre-history suppression — "we measured zero" vs "nothing to measure"
// ─────────────────────────────────────────────────────────────────────────────

describe('periodEndMs', () => {
  it('returns the exclusive end of a day bucket', () => {
    expect(periodEndMs('2026-07-25', 'day')).toBe(Date.UTC(2026, 6, 26));
  });

  it('returns the exclusive end of a month bucket, respecting month length', () => {
    expect(periodEndMs('2026-07-01', 'month')).toBe(Date.UTC(2026, 7, 1));
    expect(periodEndMs('2026-02-01', 'month')).toBe(Date.UTC(2026, 2, 1));
  });
});

describe('isPreHistory', () => {
  const launch = Date.parse('2026-07-21T00:00:00Z');

  it('marks buckets that closed before the first recorded event', () => {
    expect(isPreHistory('2026-06-01', 'month', launch)).toBe(true);
    expect(isPreHistory('2026-07-19', 'day', launch)).toBe(true);
  });

  it('does NOT mark the bucket containing the first event, or any later one', () => {
    expect(isPreHistory('2026-07-01', 'month', launch)).toBe(false); // July contains launch
    expect(isPreHistory('2026-07-21', 'day', launch)).toBe(false);
    expect(isPreHistory('2026-07-25', 'day', launch)).toBe(false);
  });

  it('does NOT mark a genuinely empty day AFTER launch — a traffic cliff must stay visible', () => {
    // This is the whole point of anchoring on the first event rather than on
    // "the bucket has no rows": a zero-traffic day post-launch is a REAL measurement
    // and the daily review's outage check depends on seeing it as 0, not as "—".
    expect(isPreHistory('2026-07-24', 'day', launch)).toBe(false);
  });

  it('suppresses nothing when there is no recorded history to anchor against', () => {
    expect(isPreHistory('2020-01-01', 'day', null)).toBe(false);
    expect(isPreHistory('2020-01-01', 'day', Number.NaN)).toBe(false);
  });
});

describe('buildOperatingKpis pre-history suppression', () => {
  const launch = Date.parse('2026-07-21T00:00:00Z');
  const series = [
    counts({ period: '2026-05-01', label: '2026-05' }),
    counts({ period: '2026-06-01', label: '2026-06' }),
    counts({ period: '2026-07-01', label: '2026-07', activeActors: 32, partial: true }),
  ];

  it('reports "not enough data" instead of a confident "steady 0" for pre-launch months', () => {
    const mau = buildOperatingKpis(series, 'month', launch).find((k) => k.key === 'active_actors')!;
    expect(mau.current).toBeNull();
    expect(mau.previous).toBeNull();
    expect(mau.direction).toBe('unknown');
    expect(mau.verdict).toBe('unknown');
    expect(mau.inProgress).toBe(32);
    expect(mau.points.filter((p) => p.preHistory)).toHaveLength(2);
  });

  it('without the anchor, the same series would have read as a misleading flat zero', () => {
    // Regression guard: this documents the exact defect the anchor fixes. If someone
    // removes the firstEventAtMs plumbing, this assertion still passes but the one
    // above starts failing — which is the alarm we want.
    const mau = buildOperatingKpis(series, 'month').find((k) => k.key === 'active_actors')!;
    expect(mau.current).toBe(0);
    expect(mau.verdict).toBe('steady');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: trend model
// ─────────────────────────────────────────────────────────────────────────────

describe('trendDirection', () => {
  it('reports raw movement between two known values', () => {
    expect(trendDirection(10, 5)).toBe('up');
    expect(trendDirection(5, 10)).toBe('down');
    expect(trendDirection(5, 5)).toBe('flat');
  });

  it('is "unknown" — not "flat" — when either side is missing', () => {
    expect(trendDirection(null, 5)).toBe('unknown');
    expect(trendDirection(5, null)).toBe('unknown');
    expect(trendDirection(null, null)).toBe('unknown');
    expect(trendDirection(Number.NaN, 5)).toBe('unknown');
  });
});

describe('trendVerdict', () => {
  it('reads direction through whether up is good for the metric', () => {
    expect(trendVerdict('up', 'higher')).toBe('improving');
    expect(trendVerdict('down', 'higher')).toBe('worsening');
    expect(trendVerdict('up', 'lower')).toBe('worsening');
    expect(trendVerdict('down', 'lower')).toBe('improving');
  });

  it('never claims improvement for a flat, neutral or unknown movement', () => {
    expect(trendVerdict('flat', 'higher')).toBe('steady');
    expect(trendVerdict('up', 'neutral')).toBe('steady');
    expect(trendVerdict('unknown', 'higher')).toBe('unknown');
    expect(trendVerdict('unknown', 'lower')).toBe('unknown');
  });
});

describe('meetsTarget', () => {
  it('evaluates both target directions', () => {
    expect(meetsTarget(30, { value: 25, direction: 'gte', source: 't' })).toBe(true);
    expect(meetsTarget(20, { value: 25, direction: 'gte', source: 't' })).toBe(false);
    expect(meetsTarget(5, { value: 10, direction: 'lte', source: 't' })).toBe(true);
    expect(meetsTarget(15, { value: 10, direction: 'lte', source: 't' })).toBe(false);
  });

  it('never scores "no data" as a miss', () => {
    expect(meetsTarget(null, { value: 25, direction: 'gte', source: 't' })).toBeNull();
    expect(meetsTarget(30, undefined)).toBeNull();
  });
});

// ── buildOperatingKpi: the honesty contract ──────────────────────────────────

const DEF: OperatingKpiDef = {
  key: 'test',
  label: 'Test KPI',
  description: 'test',
  format: 'pct',
  better: 'higher',
  provenance: 'test',
  cadence: 'both',
};

function point(period: string, value: number | null, sample: number | null, partial = false): KpiPoint {
  return { period, label: period, value, sample, partial };
}

describe('buildOperatingKpi', () => {
  it('reads current/previous off the last two COMPLETE periods, never the partial one', () => {
    const kpi = buildOperatingKpi(DEF, [
      point('2026-07-21', 10, 100),
      point('2026-07-22', 20, 100),
      point('2026-07-23', 30, 100),
      point('2026-07-24', 999, 100, true), // in progress — must not be an endpoint
    ]);
    expect(kpi.current).toBe(30);
    expect(kpi.previous).toBe(20);
    expect(kpi.inProgress).toBe(999);
    expect(kpi.delta).toBe(10);
    expect(kpi.direction).toBe('up');
    expect(kpi.verdict).toBe('improving');
  });

  it('reports "unknown" rather than inventing an arrow with <2 complete periods', () => {
    const kpi = buildOperatingKpi(DEF, [point('2026-07-24', 42, 100), point('2026-07-25', 7, 100, true)]);
    expect(kpi.current).toBe(42);
    expect(kpi.previous).toBeNull();
    expect(kpi.delta).toBeNull();
    expect(kpi.direction).toBe('unknown');
    expect(kpi.verdict).toBe('unknown');
  });

  it('reports "unknown" when there is no complete period at all', () => {
    const kpi = buildOperatingKpi(DEF, [point('2026-07-25', 7, 100, true)]);
    expect(kpi.current).toBeNull();
    expect(kpi.inProgress).toBe(7);
    expect(kpi.direction).toBe('unknown');
  });

  it('flags a small — but non-zero — denominator as low sample', () => {
    const low = buildOperatingKpi(DEF, [point('a', 50, 2), point('b', 50, MIN_RATE_SAMPLE - 1)]);
    expect(low.lowSample).toBe(true);

    const ok = buildOperatingKpi(DEF, [point('a', 50, 100), point('b', 50, MIN_RATE_SAMPLE)]);
    expect(ok.lowSample).toBe(false);
  });

  it('does NOT flag low sample when the denominator is zero (the value is already null)', () => {
    const kpi = buildOperatingKpi(DEF, [point('a', null, 0), point('b', null, 0)]);
    expect(kpi.current).toBeNull();
    expect(kpi.lowSample).toBe(false);
  });

  it('propagates the target verdict', () => {
    const withTarget: OperatingKpiDef = { ...DEF, target: { value: 25, direction: 'gte', source: 'test' } };
    expect(buildOperatingKpi(withTarget, [point('a', 10, 50), point('b', 30, 50)]).met).toBe(true);
    expect(buildOperatingKpi(withTarget, [point('a', 10, 50), point('b', 20, 50)]).met).toBe(false);
    expect(buildOperatingKpi(withTarget, [point('a', 10, 50), point('b', null, 0)]).met).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: per-KPI derivations
// ─────────────────────────────────────────────────────────────────────────────

/** A zeroed counter row, so each test states only the fields it cares about. */
function counts(overrides: Partial<OperatingPeriodCounts> = {}): OperatingPeriodCounts {
  return {
    period: '2026-07-25',
    label: '2026-07-25',
    partial: false,
    events: 0,
    activeActors: 0,
    searches: 0,
    searchesWithResults: 0,
    zeroResultSearches: 0,
    nonEmptySearches: 0,
    broadenedSearches: 0,
    attributableSearches: 0,
    engagedSearches: 0,
    attributableZeroResultSearches: 0,
    recoveredZeroResultSearches: 0,
    listingViews: 0,
    outboundClicks: 0,
    savedSearches: 0,
    emailOptIns: 0,
    signInEvents: 0,
    signedInActors: 0,
    newActors: 0,
    activatedNewActors: 0,
    returningActors: 0,
    priorActors: 0,
    retainedActors: 0,
    ...overrides,
  };
}

describe('KPI derivations', () => {
  it('activation = activated new actors ÷ new actors', () => {
    expect(activationPct(counts({ newActors: 8, activatedNewActors: 2 }))).toBe(25);
    expect(activationPct(counts({ newActors: 0, activatedNewActors: 0 }))).toBeNull();
  });

  it('retention = returning prior-period actors ÷ prior-period actors', () => {
    expect(retentionPct(counts({ priorActors: 10, retainedActors: 4 }))).toBe(40);
    expect(retentionPct(counts({ priorActors: 0, retainedActors: 0 }))).toBeNull();
  });

  it('non-empty result rate is the exact complement of the zero-result rate', () => {
    expect(nonEmptyResultPct(counts({ searchesWithResults: 10, zeroResultSearches: 2 }))).toBe(80);
    expect(nonEmptyResultPct(counts({ searchesWithResults: 10, zeroResultSearches: 0 }))).toBe(100);
    expect(nonEmptyResultPct(counts({ searchesWithResults: 0 }))).toBeNull();
  });

  it('search-engagement proxy = engaged searches ÷ attributable searches', () => {
    expect(searchEngagementPct(counts({ attributableSearches: 4, engagedSearches: 3 }))).toBe(75);
    expect(searchEngagementPct(counts({ attributableSearches: 0 }))).toBeNull();
  });

  it('zero-result recovery = recovered ÷ attributable zero-result searches', () => {
    expect(zeroResultRecoveryPct(counts({ attributableZeroResultSearches: 5, recoveredZeroResultSearches: 1 }))).toBe(20);
    expect(zeroResultRecoveryPct(counts({ attributableZeroResultSearches: 0 }))).toBeNull();
  });

  it('account-value counter sums saved searches and email opt-ins', () => {
    expect(savedSearchAndEmailTotal(counts({ savedSearches: 3, emailOptIns: 4 }))).toBe(7);
  });

  it('daysInPeriod knows a day is 1 and reads real month lengths', () => {
    expect(daysInPeriod(counts({ label: '2026-07-25' }))).toBe(1);
    expect(daysInPeriod(counts({ label: '2026-07' }))).toBe(31);
    expect(daysInPeriod(counts({ label: '2026-02' }))).toBe(28);
    expect(daysInPeriod(counts({ label: '2024-02' }))).toBe(29); // leap year
  });
});

describe('buildOperatingKpis', () => {
  const series = [counts({ period: '2026-07-23', label: '2026-07-23' }), counts({ period: '2026-07-24', label: '2026-07-24', partial: true })];

  it('selects the KPI set that belongs to each review cadence', () => {
    const daily = buildOperatingKpis(series, 'day').map((k) => k.key);
    const monthly = buildOperatingKpis(series, 'month').map((k) => k.key);

    expect(daily).toContain('dau');
    expect(daily).not.toContain('active_actors');
    expect(monthly).toContain('active_actors');
    expect(monthly).not.toContain('dau');

    // The KPIs the scope names as "both" must appear in BOTH reviews.
    for (const key of [
      'activation',
      'retention',
      'signed_in_share',
      'saved_search_email',
      'non_empty_results',
      'search_engagement',
      'zero_result_recovery',
      'source_ctr',
    ]) {
      expect(daily).toContain(key);
      expect(monthly).toContain(key);
    }
  });

  it('returns em-dash-able nulls (never fabricated zeros) for every rate on empty data', () => {
    for (const kpi of buildOperatingKpis(series, 'day')) {
      if (kpi.format !== 'pct') continue;
      expect(kpi.current).toBeNull();
      expect(kpi.direction).toBe('unknown');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: the real SQL against real Postgres
// ─────────────────────────────────────────────────────────────────────────────

/** Insert one analytics_event at a chosen age (minutes) for a chosen session. Optionally
 *  stamps `search_minute_request_count` (the 2026-09-22 high-frequency signal — see
 *  lib/analytics/high-frequency-exclusion.ts) so a test can mint a threshold-crossing row. */
async function insertEvent(
  session: string,
  eventType: string,
  minutesAgo: number,
  resultSummary?: Record<string, unknown>,
  searchMinuteRequestCount: number | null = null
): Promise<void> {
  await query(
    `INSERT INTO analytics_event
       (event_type, user_or_session, created_at, result_summary_json, search_minute_request_count)
       VALUES ($1, $2, now() - ($3 || ' minutes')::interval, $4, $5)`,
    [
      eventType,
      session,
      String(minutesAgo),
      resultSummary ? JSON.stringify(resultSummary) : null,
      searchMinuteRequestCount,
    ]
  );
}

describe.skipIf(!hasDb)('getOperatingPeriodCounts (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('returns a gap-free, ascending bucket axis with only the newest flagged partial', async () => {
    const series = await getOperatingPeriodCounts('day', 10);
    expect(series).toHaveLength(10);
    for (let i = 1; i < series.length; i++) {
      expect(series[i].period > series[i - 1].period).toBe(true);
      expect(series[i].period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(series.filter((p) => p.partial)).toHaveLength(1);
    expect(series[series.length - 1].partial).toBe(true);
    for (const p of series) {
      expect(Number.isInteger(p.events)).toBe(true);
      expect(p.events).toBeGreaterThanOrEqual(0);
      expect(p.activeActors).toBeGreaterThanOrEqual(0);
    }
  });

  it('buckets by month with a YYYY-MM label when asked for the monthly review', async () => {
    const series = await getOperatingPeriodCounts('month', 3);
    expect(series).toHaveLength(3);
    for (const p of series) {
      expect(p.label).toMatch(/^\d{4}-\d{2}$/);
      expect(p.period).toMatch(/^\d{4}-\d{2}-01$/); // buckets start on the 1st
    }
  });

  it('counts a seeded search funnel into today, including the outcome proxies', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    // Actor A: a zero-result search, then a successful re-search inside the window,
    // then a listing view. → 1 zero-result, 1 recovered, and both searches engaged
    // (the listing view follows each of them within the window).
    const a = randomUUID();
    await insertEvent(a, 'search_performed', 20, { total: 0 });
    await insertEvent(a, 'search_performed', 15, { total: 4 });
    await insertEvent(a, 'listing_viewed', 10);

    // Actor B: one search that returned results and was never followed up. → not engaged.
    const b = randomUUID();
    await insertEvent(b, 'search_performed', 12, { total: 9 });

    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    expect(after.searches - before.searches).toBe(3);
    expect(after.searchesWithResults - before.searchesWithResults).toBe(3);
    expect(after.zeroResultSearches - before.zeroResultSearches).toBe(1);
    expect(after.nonEmptySearches - before.nonEmptySearches).toBe(2);
    expect(after.listingViews - before.listingViews).toBe(1);
    expect(after.attributableSearches - before.attributableSearches).toBe(3);

    // Actor A's two searches both precede the listing view within the window; actor
    // B's search has no follow-on. So exactly 2 more engaged searches.
    expect(after.engagedSearches - before.engagedSearches).toBe(2);

    // The zero-result search was followed by a same-actor search that DID return
    // results, inside SEARCH_OUTCOME_WINDOW_MINUTES → exactly one recovery.
    expect(after.attributableZeroResultSearches - before.attributableZeroResultSearches).toBe(1);
    expect(after.recoveredZeroResultSearches - before.recoveredZeroResultSearches).toBe(1);
  });

  it('does NOT credit a recovery that falls outside the outcome window', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;
    const actor = randomUUID();
    // A zero-result search, and a successful re-search well beyond the window.
    await insertEvent(actor, 'search_performed', SEARCH_OUTCOME_WINDOW_MINUTES + 90, { total: 0 });
    await insertEvent(actor, 'search_performed', 5, { total: 3 });
    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    expect(after.zeroResultSearches - before.zeroResultSearches).toBe(1);
    expect(after.attributableZeroResultSearches - before.attributableZeroResultSearches).toBe(1);
    expect(after.recoveredZeroResultSearches - before.recoveredZeroResultSearches).toBe(0);
  });

  it('counts a brand-new actor as new, and as activated once it reaches a value moment', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    // A brand-new uuid actor cannot have existed before today, so it is unambiguously
    // "new" — and it reaches an activation moment.
    const activated = randomUUID();
    await insertEvent(activated, 'search_performed', 25, { total: 6 });
    await insertEvent(activated, ACTIVATION_EVENT_TYPES[0], 20);

    // …and one that searches but never reaches a value moment.
    const unactivated = randomUUID();
    await insertEvent(unactivated, 'search_performed', 25, { total: 6 });

    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;
    expect(after.newActors - before.newActors).toBe(2);
    expect(after.activatedNewActors - before.activatedNewActors).toBe(1);
  });

  it('counts an actor first seen in a prior period as returning, not new', async () => {
    const before = (await getOperatingPeriodCounts('day', 3)).at(-1) as OperatingPeriodCounts;
    const actor = randomUUID();
    await insertEvent(actor, 'listing_viewed', 60 * 24 * 2); // two days ago → first seen then
    await insertEvent(actor, 'listing_viewed', 5); // and active again today
    const after = (await getOperatingPeriodCounts('day', 3)).at(-1) as OperatingPeriodCounts;

    expect(after.newActors - before.newActors).toBe(0);
    expect(after.returningActors - before.returningActors).toBe(1);
  });

  it('counts distinct signed-in actors separately from raw sign-in events', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;
    const actor = randomUUID();
    await insertEvent(actor, 'account_signed_in', 30);
    await insertEvent(actor, 'account_signed_in', 10); // same actor, second sign-in
    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    expect(after.signInEvents - before.signInEvents).toBe(2);
    expect(after.signedInActors - before.signedInActors).toBe(1);
  });

  it('counts only opted-IN weekly-email events, matching kpi.ts exactly', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;
    const actor = randomUUID();
    await insertEvent(actor, 'weekly_email_opt_in', 20, { optedIn: true });
    await insertEvent(actor, 'weekly_email_opt_in', 10, { optedIn: false }); // opt-OUT
    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    expect(after.emailOptIns - before.emailOptIns).toBe(1);
  });

  // The 2026-09-22 high-frequency exclusion (lib/analytics/high-frequency-exclusion.ts), wired
  // into getEngagementSeries/getLifecycleSeries. Baseline: a session that fires a
  // threshold-crossing row in ITS OWN period must be excluded from that period's
  // activeActors/signedInActors — same contract kpi.ts and trends.ts already prove.
  it('excludes a flagged actor from active_actors and signed_in_actors within its own period', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    const flagged = randomUUID();
    await insertEvent(flagged, 'account_signed_in', 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);

    const clean = randomUUID();
    await insertEvent(clean, 'account_signed_in', 5);

    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    // Only the clean control actor is counted; the flagged one is excluded entirely.
    expect(after.activeActors - before.activeActors).toBe(1);
    expect(after.signedInActors - before.signedInActors).toBe(1);
  });

  // REVISED (2026-09-22, THIRD review round, 6f176ae2): this test used to pin active_actors to
  // PER-BUCKET-ONLY exclusion (a flag 5 days ago must not affect today's count). That behaviour
  // was superseded when active_actors/signed_in_actors moved onto kpi.ts's/trends.ts's shared
  // 30-day window — see the "DELIBERATE ARCHITECTURAL DECISION, REVISED" comment above
  // getEngagementSeries's `flagged` CTE for why: /admin/operating renders the DAU chart
  // (getActivityTrend, already on the shared window) directly above this table's "Active" column,
  // and the two must not show different numbers for the same day. Per the reviewers' own
  // standard, this test is REWRITTEN to match the new intended behaviour, not deleted or
  // weakened — it still needs to prove active_actors' exclusion window is BOUNDED (exactly
  // MAU_WINDOW_DAYS), not the two wrong extremes: not the whole per-page scan range (unbounded
  // — the original wide-window bug) and not still per-bucket-only (the now-superseded
  // behaviour this test used to pin).
  it('excludes an actor from TODAY when flagged within the shared 30-day window (matching trends.ts’s dau), even on an unrelated day', async () => {
    const beforeSeries = await getOperatingPeriodCounts('day', 10);
    const beforeToday = beforeSeries.at(-1) as OperatingPeriodCounts;

    const actor = randomUUID();
    // 20 days ago: well outside the 10-day DISPLAYED series, but inside the shared 30-day
    // exclusion window — must still reach today, proving the window is neither "this page's
    // display range" nor "this bucket alone", but the actual MAU_WINDOW_DAYS width.
    await insertEvent(actor, 'listing_viewed', 60 * 24 * 20 + 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);
    await insertEvent(actor, 'listing_viewed', 5); // ordinary activity TODAY

    const afterSeries = await getOperatingPeriodCounts('day', 10);
    const afterToday = afterSeries.at(-1) as OperatingPeriodCounts;

    expect(afterToday.activeActors - beforeToday.activeActors).toBe(0);
  });

  // 🔴 The OTHER extreme: the window must be BOUNDED at MAU_WINDOW_DAYS, not the actor's whole
  // history — the exact 40-vs-30-day gap 2dfdbb2c originally caught between kpi.ts and trends.ts,
  // reproduced here as a regression test one file over rather than assumed safe by analogy.
  it('🔴 does NOT exclude an actor from TODAY when their only qualifying row is OUTSIDE the shared 30-day window', async () => {
    const beforeSeries = await getOperatingPeriodCounts('day', 10);
    const beforeToday = beforeSeries.at(-1) as OperatingPeriodCounts;

    const actor = randomUUID();
    // 40 days ago: outside MAU_WINDOW_DAYS (30) from today — must NOT reach today.
    await insertEvent(actor, 'listing_viewed', 60 * 24 * 40 + 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);
    await insertEvent(actor, 'listing_viewed', 5); // ordinary activity TODAY

    const afterSeries = await getOperatingPeriodCounts('day', 10);
    const afterToday = afterSeries.at(-1) as OperatingPeriodCounts;

    expect(afterToday.activeActors - beforeToday.activeActors).toBe(1);
  });

  // Direct SAME-PAGE agreement check — the actual property 6f176ae2's finding is about.
  // /admin/operating renders getActivityTrend's DAU chart directly above this table's "Active"
  // column (getOperatingPeriodCounts's activeActors); a reader has no reason to expect those two
  // numbers to mean different things unless told so. Calls BOTH in the SAME test against the SAME
  // flagged actor, asserting their deltas are IDENTICAL — not just separately correct — mirroring
  // tests/analytics/trends.test.ts's kpi.ts-vs-trends.ts cross-file test for the same reason.
  it('🔴 activeActors (this table’s “Active” column) agrees with trends.ts’s DAU (the chart on the SAME page) for the SAME flagged actor', async () => {
    const opsBefore = await getOperatingPeriodCounts('day', 10);
    const opsTodayBefore = opsBefore.at(-1) as OperatingPeriodCounts;
    const trendBefore = await getActivityTrend();
    const trendTodayBefore = trendBefore.points[trendBefore.points.length - 1];

    const actor = randomUUID();
    // 10 days ago — the exact scenario 6f176ae2 measured: inside the shared 30-day window, so
    // both surfaces must exclude it from TODAY.
    await insertEvent(actor, 'listing_viewed', 60 * 24 * 10 + 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);
    await insertEvent(actor, 'listing_viewed', 5); // ordinary activity TODAY

    const opsAfter = await getOperatingPeriodCounts('day', 10);
    const opsTodayAfter = opsAfter.at(-1) as OperatingPeriodCounts;
    const trendAfter = await getActivityTrend();
    const trendTodayAfter = trendAfter.points[trendAfter.points.length - 1];

    const opsDelta = opsTodayAfter.activeActors - opsTodayBefore.activeActors;
    const trendDauDelta = trendTodayAfter.dau! - trendTodayBefore.dau!;

    expect(opsDelta).toBe(trendDauDelta);
    expect(opsDelta).toBe(0);
  });

  // Baseline for the lifecycle site specifically (new/activated/returning/retained), verified
  // against real Postgres rather than inferred from the cross-period test below or from reading
  // the SQL — 2dfdbb2c flagged that this call site had only been checked by reading the query,
  // not by reproducing against a live DB, so this closes that gap directly: a brand-new actor
  // whose ONLY activity is a threshold-crossing burst must not be counted as new, activated, or
  // returning at all today.
  it('excludes a flagged actor from the lifecycle cohorts (new/activated/returning) within its own period', async () => {
    const before = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    const flagged = randomUUID();
    await insertEvent(flagged, ACTIVATION_EVENT_TYPES[0], 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);

    const clean = randomUUID();
    await insertEvent(clean, ACTIVATION_EVENT_TYPES[0], 5);

    const after = (await getOperatingPeriodCounts('day', 2)).at(-1) as OperatingPeriodCounts;

    // Only the clean control actor is counted as new+activated; the flagged one contributes
    // nothing to new, activated, or returning.
    expect(after.newActors - before.newActors).toBe(1);
    expect(after.activatedNewActors - before.activatedNewActors).toBe(1);
    expect(after.returningActors - before.returningActors).toBe(0);
  });

  // REVISED (2026-09-22, round 4, B4, 0bab6a97): this test used to pin new_actors/returning_actors
  // to PER-BUCKET-ONLY exclusion — the same behaviour active_actors had before 2febba9. That
  // became a bug the moment active_actors moved to the shared 30-day window and seen did not:
  // new_actors + returning_actors is an IDENTITY equal to |seen| for a period (see the "REVISED A
  // FOURTH TIME" comment above getLifecycleSeries's `seen` CTE for the exact mechanism), so
  // seen's exclusion window diverging from active_actors's produced literally self-contradictory
  // rows ("Active=0, New=0, Returning=1"). seen now shares the identical window, so per the
  // established standard this test is REWRITTEN, not deleted or weakened — same shape as
  // actor_counts's equivalent pair below getEngagementSeries.
  it('lifecycle presence reaches 20 days back, matching the shared 30-day window (not per-bucket-only)', async () => {
    const beforeSeries = await getOperatingPeriodCounts('day', 10);
    const beforeToday = beforeSeries.at(-1) as OperatingPeriodCounts;

    const actor = randomUUID();
    // 20 days ago: well outside the 10-day DISPLAYED series, inside the shared 30-day window.
    await insertEvent(actor, 'listing_viewed', 60 * 24 * 20 + 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);
    await insertEvent(actor, 'listing_viewed', 5); // ordinary activity TODAY

    const afterSeries = await getOperatingPeriodCounts('day', 10);
    const afterToday = afterSeries.at(-1) as OperatingPeriodCounts;

    expect(afterToday.newActors + afterToday.returningActors - (beforeToday.newActors + beforeToday.returningActors)).toBe(0);
  });

  // 🔴 The other extreme: bounded at MAU_WINDOW_DAYS (30), not unbounded — mirrors
  // actor_counts's equivalent 40-day boundary test and kpi.ts's/trends.ts's own.
  it('🔴 does NOT exclude lifecycle presence when the only qualifying row is OUTSIDE the shared 30-day window', async () => {
    const beforeSeries = await getOperatingPeriodCounts('day', 10);
    const beforeToday = beforeSeries.at(-1) as OperatingPeriodCounts;

    const actor = randomUUID();
    await insertEvent(actor, 'listing_viewed', 60 * 24 * 40 + 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);
    await insertEvent(actor, 'listing_viewed', 5); // ordinary activity TODAY

    const afterSeries = await getOperatingPeriodCounts('day', 10);
    const afterToday = afterSeries.at(-1) as OperatingPeriodCounts;

    expect(afterToday.newActors + afterToday.returningActors - (beforeToday.newActors + beforeToday.returningActors)).toBe(1);
  });

  // 🔴 B4 (0bab6a97, round 4): the actual IDENTITY that broke, asserted directly and
  // permanently — not inferred from the two tests above. new_actors + returning_actors
  // PARTITIONS every actor `seen` counts for a period (per_actor's two FILTER conditions,
  // af.first_at >= p.pstart vs < p.pstart, are exhaustive and mutually exclusive over every
  // non-null seen row), so this must equal active_actors for EVERY period, always — with or
  // without a bot actor in play, seeded or not. This is the guard the reviewer asked for: had it
  // existed before 2febba9, it would have failed the moment active_actors moved to the shared
  // window while seen stayed per-bucket, independent of any specific flagged-actor scenario.
  it('🔴 IDENTITY: new_actors + returning_actors === active_actors for every period, always', async () => {
    // A flagged actor plus a clean actor, both touching multiple periods, so the identity is
    // exercised under real exclusion activity rather than trivially on an all-clean series.
    const flagged = randomUUID();
    await insertEvent(flagged, 'listing_viewed', 5, undefined, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD);
    await insertEvent(flagged, 'listing_viewed', 60 * 24 * 3 + 5);
    const clean = randomUUID();
    await insertEvent(clean, 'listing_viewed', 5);
    await insertEvent(clean, 'listing_viewed', 60 * 24 * 6 + 5);

    const series = await getOperatingPeriodCounts('day', 10);
    for (const p of series) {
      expect(p.newActors + p.returningActors, p.period).toBe(p.activeActors);
    }
  });
});

describe.skipIf(!hasDb)('getDataCoverage (DB)', () => {
  it('reports real coverage without crashing on any table state', async () => {
    const coverage = await getDataCoverage();
    expect(coverage.totalEvents).toBeGreaterThanOrEqual(0);
    expect(coverage.daysOfData).toBeGreaterThanOrEqual(0);
    if (coverage.totalEvents > 0) {
      expect(coverage.firstEventAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } else {
      expect(coverage.firstEventAt).toBeNull();
    }
  });
});
