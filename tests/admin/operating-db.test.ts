// tests/admin/operating-db.test.ts — DB-backed tests for the operating assembler (T41).
//
// Skips when DATABASE_URL is unset (mirrors tests/admin/data-health-db.test.ts, whose
// seed/teardown pattern this follows exactly). Seeds a controlled, uniquely-tagged
// graph — one enabled source with a success AND a failed check run today, plus
// correction reports opened and resolved today — then asserts the DELTA those known
// rows produce on today's bucket, so the assertions hold regardless of what else is
// already in the shared database. Everything inserted is removed afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildOpsKpis,
  earliestDataMs,
  getOperatingDashboardData,
  getOperatingOpsPeriods,
  getOpsCoverage,
  type OperatingOpsPeriod,
} from '../../lib/admin/operating';
import { closePool, query } from '../../lib/db/client';
import { TODAY_SEED_ANCHOR_SQL } from '../../lib/testing/today-seed-anchor';

const hasDb = Boolean(process.env.DATABASE_URL);

const TAG = `t41test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

interface Ids {
  srcId: string;
  venueId: string;
  seriesId: string;
  occId: string;
}

async function scalar<T>(sql: string, params?: unknown[]): Promise<T> {
  const rows = await query<Record<string, T>>(sql, params);
  return Object.values(rows[0])[0];
}

async function insertReturningId(sql: string, params: unknown[]): Promise<string> {
  const rows = await query<{ id: string }>(sql, params);
  return rows[0].id;
}

describe.skipIf(!hasDb)('operating ops series (DB)', () => {
  const ids = {} as Ids;
  let before: Awaited<ReturnType<typeof getOperatingOpsPeriods>>;

  beforeAll(async () => {
    before = await getOperatingOpsPeriods('day', 3);

    const vanRegionId = await scalar<string>(
      `SELECT id::text FROM region WHERE name = 'Vancouver' AND level = 'municipality' LIMIT 1`
    );
    const openGymCatId = await scalar<string>(`SELECT id::text FROM category WHERE key = 'open_gym' LIMIT 1`);

    ids.srcId = await insertReturningId(
      `INSERT INTO source (family, name, terms_status, baseline_cadence)
       VALUES ('activenet', $1, 'allowed', '1 day') RETURNING id::text AS id`,
      [`${TAG} Operating Source`]
    );

    // Three runs started today: 2 ok (success + partial) and 1 failed → 67% success.
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'success', ${TODAY_SEED_ANCHOR_SQL} - interval '3 hours')`,
      [ids.srcId]
    );
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'partial', ${TODAY_SEED_ANCHOR_SQL} - interval '2 hours')`,
      [ids.srcId]
    );
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'failed', ${TODAY_SEED_ANCHOR_SQL} - interval '1 hour')`,
      [ids.srcId]
    );

    ids.venueId = await insertReturningId(
      `INSERT INTO venue (name, municipality_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`${TAG} Rec Centre`, vanRegionId]
    );
    ids.seriesId = await insertReturningId(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id, default_primary_category)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [`${TAG} Open Gym`, ids.srcId, ids.venueId, openGymCatId]
    );
    ids.occId = await insertReturningId(
      `INSERT INTO activity_occurrence (series_id, activity_name, primary_category_id, start_datetime_utc)
       VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id::text AS id`,
      [ids.seriesId, `${TAG} Saturday Open Gym`, openGymCatId]
    );

    // An OLD failed check run, well before anything this suite writes to
    // analytics_event. Under the R1 defect this day's genuine 0% ingestion success was
    // suppressed by the analytics anchor; it must now survive.
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'failed', ${TODAY_SEED_ANCHOR_SQL} - interval '6 days')`,
      [ids.srcId]
    );

    // Two reports opened today; one of them also resolved today.
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at)
       VALUES ($1, 'wrong_time', 'open', ${TODAY_SEED_ANCHOR_SQL} - interval '4 hours')`,
      [ids.occId]
    );
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at, resolved_at)
       VALUES ($1, 'wrong_price', 'resolved', ${TODAY_SEED_ANCHOR_SQL} - interval '5 hours', ${TODAY_SEED_ANCHOR_SQL} - interval '1 hour')`,
      [ids.occId]
    );
    // An ARCHIVED report opened today — must be excluded on both sides, exactly as
    // getCorrectionsQueueSummary() excludes it.
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at, archived_at)
       VALUES ($1, 'other', 'open', ${TODAY_SEED_ANCHOR_SQL} - interval '3 hours', now())`,
      [ids.occId]
    );
  });

  afterAll(async () => {
    if (ids.occId) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [ids.occId]);
    if (ids.srcId) await query(`DELETE FROM source_check_run WHERE source_id = $1`, [ids.srcId]);
    if (ids.occId) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [ids.occId]);
    if (ids.seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [ids.seriesId]);
    if (ids.venueId) await query(`DELETE FROM venue WHERE id = $1`, [ids.venueId]);
    if (ids.srcId) await query(`DELETE FROM source WHERE id = $1`, [ids.srcId]);
    await closePool();
  });

  it('returns a gap-free bucket axis with only the newest flagged partial', async () => {
    const series = await getOperatingOpsPeriods('day', 5);
    expect(series).toHaveLength(5);
    expect(series.filter((p) => p.partial)).toHaveLength(1);
    expect(series[series.length - 1].partial).toBe(true);
    for (let i = 1; i < series.length; i++) {
      expect(series[i].period > series[i - 1].period).toBe(true);
    }
  });

  it('counts seeded check runs into today, split by ok vs failed', async () => {
    const after = await getOperatingOpsPeriods('day', 3);
    const b = before.at(-1)!;
    const a = after.at(-1)!;

    expect(a.checkRuns - b.checkRuns).toBe(3);
    expect(a.okCheckRuns - b.okCheckRuns).toBe(2); // success + partial
    expect(a.failedCheckRuns - b.failedCheckRuns).toBe(1);
  });

  it('counts corrections opened and resolved without double-counting, excluding archived', async () => {
    const after = await getOperatingOpsPeriods('day', 3);
    const b = before.at(-1)!;
    const a = after.at(-1)!;

    // 2 non-archived reports created today (the archived third is excluded). The
    // double LEFT JOIN would inflate these without count(DISTINCT …) — this is the
    // regression guard for exactly that.
    expect(a.correctionsOpened - b.correctionsOpened).toBe(2);
    expect(a.correctionsResolved - b.correctionsResolved).toBe(1);
  });

  it('INVARIANT: any bucket with real check runs is never suppressed (R1)', async () => {
    // Stated as an invariant rather than an exact-value assertion so it holds no
    // matter what else lives in the shared test database. This is the property the
    // R1 defect violated: a bucket containing real source_check_run rows was reported
    // as "nothing to measure" because analytics_event happened to start later.
    const data = await getOperatingDashboardData('day', 10);
    const ingest = data.kpis.find((k) => k.key === 'ingest_success_rate')!;
    const opsByPeriod = new Map(data.opsCounts.map((o) => [o.period, o]));

    let checked = 0;
    for (const point of ingest.points) {
      const ops = opsByPeriod.get(point.period);
      if (!ops || ops.checkRuns === 0) continue;
      checked++;
      expect(point.preHistory ?? false).toBe(false);
      expect(point.value).not.toBeNull();
      expect(point.sample).toBe(ops.checkRuns);
      // …and the bucket must still be renderable in the detail table.
      expect(data.periods.find((p) => p.period === point.period)?.preHistory).toBe(false);
    }
    // The seed guarantees at least the 6-days-ago outage day and today.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('INVARIANT: corrections are anchored on THEIR table, not the earliest domain (ADV-1)', async () => {
    // The symmetric partner to the check-run invariant above, and the one QA's M2
    // mutation slipped past: collapsing all three anchors to earliestDataMs at the call
    // site is a plausible "just use the earliest" simplification that leaves the rest of
    // the suite green while silently reintroducing the corrections false-zero — because
    // earliestDataMs is the CHECK-RUN anchor here (ingestion is older than corrections),
    // so corrections buckets between the two anchors would flip from "—" to a fake 0.
    const data = await getOperatingDashboardData('day', 10);
    const { checkRunMs, correctionMs } = data.anchors;
    expect(checkRunMs, 'seed must provide a check-run anchor').not.toBeNull();
    expect(correctionMs, 'seed must provide a corrections anchor').not.toBeNull();
    // The seed puts a check run 6 days ago and corrections today, so the two anchors
    // genuinely differ — without that, this test could not tell the wirings apart.
    expect(checkRunMs!).toBeLessThan(correctionMs!);

    const opened = data.kpis.find((k) => k.key === 'corrections_opened')!;
    const ingest = data.kpis.find((k) => k.key === 'ingest_success_rate')!;

    // A bucket strictly between the two anchors: ingestion could measure it, the
    // corrections table could not. The two KPIs MUST disagree about that bucket.
    const between = opened.points.filter((p) => {
      const endMs = Date.parse(`${p.period}T00:00:00Z`) + 86_400_000;
      return endMs > checkRunMs! && endMs <= correctionMs!;
    });
    expect(between.length, 'seed should straddle the two anchors').toBeGreaterThan(0);

    for (const point of between) {
      expect(point.preHistory, `${point.period} predates corrections`).toBe(true);
      expect(point.value, `${point.period} must be "—", never a fake 0`).toBeNull();
      const ingestPoint = ingest.points.find((p) => p.period === point.period)!;
      expect(ingestPoint.preHistory, `${point.period} does NOT predate ingestion`).toBe(false);
    }
  });

  it('reads the ops tables OWN history start, independently of analytics', async () => {
    const opsCoverage = await getOpsCoverage();
    // The seed inserted check runs and corrections today, so both anchors must exist
    // and be real timestamps — never silently null (which would disable suppression).
    expect(opsCoverage.firstCheckRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(opsCoverage.firstCorrectionAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('builds ops KPIs whose ingestion success rate reflects the seeded runs', async () => {
    const series = await getOperatingOpsPeriods('day', 3);
    const kpis = buildOpsKpis(series);
    const keys = kpis.map((k) => k.key);
    expect(keys).toEqual(['corrections_opened', 'corrections_resolved', 'ingest_success_rate']);

    const ingest = kpis.find((k) => k.key === 'ingest_success_rate')!;
    // Today's bucket is the PARTIAL one, so it appears as inProgress, never current.
    const todaysPoint = ingest.points.at(-1)!;
    expect(todaysPoint.partial).toBe(true);
    expect(todaysPoint.value).not.toBeNull();
    expect(ingest.inProgress).toBe(todaysPoint.value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 regression — ops KPIs must NOT be suppressed by the analytics anchor.
//
// This is the exact scenario independent QA reproduced live against the built server:
// real FAILED source_check_run rows on a day BEFORE the first analytics event — i.e. a
// total-ingestion-outage day, precisely what the daily review exists to catch — were
// rendered as an em-dash and their detail row was dropped under a caption claiming
// there was nothing to measure. Pure test (no DB): the bug lived entirely in which
// anchor was handed to which KPI.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOpsKpis anchoring (R1 regression)', () => {
  // Analytics started on the 21st; ingestion has been running since the 19th.
  const analyticsMs = Date.parse('2026-07-21T00:00:00Z');
  const checkRunMs = Date.parse('2026-07-19T00:00:00Z');
  const correctionMs = Date.parse('2026-07-19T00:00:00Z');

  /** The outage day: 3 runs, all failed → a real, measured 0% success. */
  const outageDay: OperatingOpsPeriod = {
    period: '2026-07-19',
    label: '2026-07-19',
    partial: false,
    correctionsOpened: 2,
    correctionsResolved: 0,
    checkRuns: 3,
    okCheckRuns: 0,
    failedCheckRuns: 3,
  };
  const laterDay: OperatingOpsPeriod = {
    ...outageDay,
    period: '2026-07-22',
    label: '2026-07-22',
    correctionsOpened: 1,
    okCheckRuns: 3,
    failedCheckRuns: 0,
  };
  const series = [outageDay, laterDay];

  it('surfaces a real 0%-ingestion day that predates analytics instrumentation', () => {
    const ingest = buildOpsKpis(series, 'day', { analyticsMs, checkRunMs, correctionMs }).find(
      (k) => k.key === 'ingest_success_rate'
    )!;
    const outagePoint = ingest.points.find((p) => p.period === '2026-07-19')!;

    expect(outagePoint.value).toBe(0); // a measured 0%, NOT an em-dash
    expect(outagePoint.preHistory).toBe(false); // and NOT droppable from the table
    expect(outagePoint.sample).toBe(3);
  });

  it('surfaces corrections filed before analytics began', () => {
    const opened = buildOpsKpis(series, 'day', { analyticsMs, checkRunMs, correctionMs }).find(
      (k) => k.key === 'corrections_opened'
    )!;
    const point = opened.points.find((p) => p.period === '2026-07-19')!;
    expect(point.value).toBe(2);
    expect(point.preHistory).toBe(false);
  });

  it('DOES still suppress buckets that predate the ops table itself', () => {
    // Ingestion genuinely started on the 20th here, so the 19th had nothing to measure.
    const ingest = buildOpsKpis(series, 'day', {
      analyticsMs,
      checkRunMs: Date.parse('2026-07-20T00:00:00Z'),
      correctionMs,
    }).find((k) => k.key === 'ingest_success_rate')!;
    const point = ingest.points.find((p) => p.period === '2026-07-19')!;
    expect(point.value).toBeNull();
    expect(point.preHistory).toBe(true);
  });

  it('suppresses nothing when no anchors are supplied (safe default)', () => {
    for (const kpi of buildOpsKpis(series, 'day')) {
      expect(kpi.points.every((p) => p.preHistory === false)).toBe(true);
    }
  });

  it('earliestDataMs takes the oldest domain, ignoring domains with no history', () => {
    expect(earliestDataMs({ analyticsMs, checkRunMs, correctionMs })).toBe(checkRunMs);
    expect(earliestDataMs({ analyticsMs, checkRunMs: null, correctionMs: null })).toBe(analyticsMs);
    expect(earliestDataMs({ analyticsMs: null, checkRunMs: null, correctionMs: null })).toBeNull();
  });
});

describe.skipIf(!hasDb)('getOperatingDashboardData (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('assembles a complete, self-consistent payload for the daily review', async () => {
    const data = await getOperatingDashboardData('day', 6);

    expect(data.grain).toBe('day');
    expect(data.periods).toHaveLength(6);
    expect(data.counts).toHaveLength(6);
    expect(data.opsCounts).toHaveLength(6);
    // Both series must share a byte-identical bucket axis, or the detail table's
    // period join would silently drop rows.
    expect(data.opsCounts.map((o) => o.period)).toEqual(data.counts.map((c) => c.period));

    expect(data.kpis.length).toBeGreaterThan(0);
    for (const kpi of data.kpis) {
      expect(kpi.points).toHaveLength(6);
      expect(kpi.points.filter((p) => p.partial)).toHaveLength(1);
      expect(['up', 'down', 'flat', 'unknown']).toContain(kpi.direction);
      expect(['improving', 'worsening', 'steady', 'unknown']).toContain(kpi.verdict);
    }

    // Reused canonical payloads must be present and shaped, not re-derived here.
    expect(data.snapshot.windows.mauDays).toBe(30);
    expect(data.activeUserTrend.points.length).toBeGreaterThan(0);
    expect(data.correctionsQueue.unresolvedCount).toBeGreaterThanOrEqual(0);
    expect(data.sourceFreshness.targetPct).toBeGreaterThan(0);

    // Sentry is unconfigured in test/CI — it must say so, never fabricate zeros.
    expect(['ok', 'unconfigured', 'unavailable']).toContain(data.sentry.state);
    expect(data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('assembles the monthly review with month-labelled buckets and its own KPI set', async () => {
    const data = await getOperatingDashboardData('month', 3);
    expect(data.grain).toBe('month');
    expect(data.periods).toHaveLength(3);
    for (const p of data.periods) {
      expect(p.label).toMatch(/^\d{4}-\d{2}$/);
    }
    const keys = data.kpis.map((k) => k.key);
    expect(keys).toContain('active_actors');
    expect(keys).not.toContain('dau');
  });
});
