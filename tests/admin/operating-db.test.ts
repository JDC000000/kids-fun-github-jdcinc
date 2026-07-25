// tests/admin/operating-db.test.ts — DB-backed tests for the operating assembler (T41).
//
// Skips when DATABASE_URL is unset (mirrors tests/admin/data-health-db.test.ts, whose
// seed/teardown pattern this follows exactly). Seeds a controlled, uniquely-tagged
// graph — one enabled source with a success AND a failed check run today, plus
// correction reports opened and resolved today — then asserts the DELTA those known
// rows produce on today's bucket, so the assertions hold regardless of what else is
// already in the shared database. Everything inserted is removed afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpsKpis, getOperatingDashboardData, getOperatingOpsPeriods } from '../../lib/admin/operating';
import { closePool, query } from '../../lib/db/client';

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
       VALUES ($1, 'success', now() - interval '3 hours')`,
      [ids.srcId]
    );
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'partial', now() - interval '2 hours')`,
      [ids.srcId]
    );
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'failed', now() - interval '1 hour')`,
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

    // Two reports opened today; one of them also resolved today.
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at)
       VALUES ($1, 'wrong_time', 'open', now() - interval '4 hours')`,
      [ids.occId]
    );
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at, resolved_at)
       VALUES ($1, 'wrong_price', 'resolved', now() - interval '5 hours', now() - interval '1 hour')`,
      [ids.occId]
    );
    // An ARCHIVED report opened today — must be excluded on both sides, exactly as
    // getCorrectionsQueueSummary() excludes it.
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at, archived_at)
       VALUES ($1, 'other', 'open', now() - interval '3 hours', now())`,
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
