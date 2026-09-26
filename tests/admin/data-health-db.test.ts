// tests/admin/data-health-db.test.ts — DB-backed tests for the data-health read layer.
// Skips when DATABASE_URL is unset (mirrors tests/admin/dashboard-data.test.ts). Seeds
// a controlled, uniquely-tagged graph (enabled sources + source_check_run rows, a
// Vancouver open-gym occurrence via ActiveNet, and correction reports), asserts the SLA
// adherence + coverage-or-gap + corrections logic on those KNOWN inputs, then removes
// everything it inserted. Shape/invariant assertions stay robust to any other data in
// the DB; exact assertions are scoped to the rows this test owns.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_REGIONS,
  P0_FAMILIES,
  getCorrectionsQueueSummary,
  getCoverageMatrix,
  getSourceFreshnessSla,
} from '../../lib/admin/data-health';
import { getRecentCorrections } from '../../lib/admin/dashboard';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// Unique tag so this run's rows never collide with a concurrent test file / re-run.
const TAG = `t33test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

interface Ids {
  dbNowMs: number;
  srcFreshId: string;
  srcLagId: string;
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

describe.skipIf(!hasDb)('data-health DB read layer', () => {
  const ids = {} as Ids;

  beforeAll(async () => {
    ids.dbNowMs = Date.parse(await scalar<string>('SELECT now()::text'));
    const vanRegionId = await scalar<string>(
      `SELECT id::text FROM region WHERE name = 'Vancouver' AND level = 'municipality' LIMIT 1`
    );
    const openGymCatId = await scalar<string>(`SELECT id::text FROM category WHERE key = 'open_gym' LIMIT 1`);

    // Two enabled sources for the SLA: one fresh (adherent), one lagging (not adherent).
    ids.srcFreshId = await insertReturningId(
      `INSERT INTO source (family, name, terms_status, baseline_cadence)
       VALUES ('activenet', $1, 'allowed', '1 day') RETURNING id::text AS id`,
      [`${TAG} Fresh ActiveNet`]
    );
    ids.srcLagId = await insertReturningId(
      `INSERT INTO source (family, name, terms_status, baseline_cadence)
       VALUES ('perfectmind', $1, 'allowed', '1 day') RETURNING id::text AS id`,
      [`${TAG} Lagging PerfectMind`]
    );

    // Successful check runs: fresh 2h ago (within 1d cadence), lagging 3d ago (past it).
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'success', now() - interval '2 hours')`,
      [ids.srcFreshId]
    );
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'success', now() - interval '3 days')`,
      [ids.srcLagId]
    );

    // A Vancouver open-gym occurrence via the fresh ActiveNet source → coverage in (van, open_gym).
    ids.venueId = await insertReturningId(
      `INSERT INTO venue (name, municipality_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`${TAG} Vancouver Rec Centre`, vanRegionId]
    );
    ids.seriesId = await insertReturningId(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id, default_primary_category)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [`${TAG} Open Gym`, ids.srcFreshId, ids.venueId, openGymCatId]
    );
    ids.occId = await insertReturningId(
      `INSERT INTO activity_occurrence (series_id, activity_name, primary_category_id, start_datetime_utc)
       VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id::text AS id`,
      [ids.seriesId, `${TAG} Saturday Open Gym`, openGymCatId]
    );

    // Corrections: one open (oldest, 10d), one in_review, one resolved.
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at)
       VALUES ($1, 'wrong_time', 'open', now() - interval '10 days')`,
      [ids.occId]
    );
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at)
       VALUES ($1, 'wrong_price', 'in_review', now() - interval '2 days')`,
      [ids.occId]
    );
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, status, created_at)
       VALUES ($1, 'other', 'resolved', now() - interval '1 day')`,
      [ids.occId]
    );
  });

  afterAll(async () => {
    // FK-safe teardown (children first). Guarded so a partial setup still cleans up.
    if (ids.occId) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [ids.occId]);
    for (const sid of [ids.srcFreshId, ids.srcLagId]) {
      if (sid) await query(`DELETE FROM source_check_run WHERE source_id = $1`, [sid]);
    }
    if (ids.occId) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [ids.occId]);
    if (ids.seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [ids.seriesId]);
    if (ids.venueId) await query(`DELETE FROM venue WHERE id = $1`, [ids.venueId]);
    for (const sid of [ids.srcFreshId, ids.srcLagId]) {
      if (sid) await query(`DELETE FROM source WHERE id = $1`, [sid]);
    }
    await closePool();
  });

  it('canonical family constant stays in lock-step with the seeded primary-eligible categories', async () => {
    const dbKeys = (
      await query<{ key: string }>(`SELECT key FROM category WHERE is_primary_eligible ORDER BY key`)
    ).map((r) => r.key);
    expect([...P0_FAMILIES.map((f) => f.key)].sort()).toEqual([...dbKeys].sort());
  });

  it('canonical launch-region constant matches the seeded municipalities', async () => {
    const dbNames = (
      await query<{ name: string }>(`SELECT name FROM region WHERE level = 'municipality' ORDER BY name`)
    ).map((r) => r.name);
    expect([...LAUNCH_REGIONS.map((r) => r.name)].sort()).toEqual([...dbNames].sort());
  });

  it('SLA marks a fresh source adherent and a lagging source non-adherent', async () => {
    const sla = await getSourceFreshnessSla(ids.dbNowMs);
    const fresh = sla.sources.find((s) => s.sourceId === ids.srcFreshId);
    const lagging = sla.sources.find((s) => s.sourceId === ids.srcLagId);
    expect(fresh?.adherent).toBe(true);
    expect(lagging?.adherent).toBe(false);

    // Aggregate is internally consistent and bounded.
    expect(sla.enabledCount).toBeGreaterThanOrEqual(2);
    expect(sla.adherentCount).toBeLessThanOrEqual(sla.enabledCount);
    if (sla.enabledCount > 0) {
      expect(sla.adherencePct).toBe(Math.round((sla.adherentCount / sla.enabledCount) * 100));
    }
    expect(sla.targetPct).toBe(95);
  });

  it('coverage matrix shows the seeded (Vancouver, open_gym) cell as covered via ActiveNet', async () => {
    const matrix = await getCoverageMatrix();
    const openGymRow = matrix.rows.find((r) => r.family.key === 'open_gym')!;
    const vanCell = openGymRow.cells.find((c) => c.regionKey === 'van')!;
    expect(vanCell.gap).toBe(false);
    expect(vanCell.total).toBeGreaterThanOrEqual(1);
    expect(vanCell.byNetwork.activenet ?? 0).toBeGreaterThanOrEqual(1);
    expect(matrix.networks).toContain('activenet');
  });

  it('coverage matrix is a full grid with the gap ⟺ zero-coverage invariant', async () => {
    const matrix = await getCoverageMatrix();
    expect(matrix.cellCount).toBe(LAUNCH_REGIONS.length * P0_FAMILIES.length);
    expect(matrix.rows).toHaveLength(P0_FAMILIES.length);
    let covered = 0;
    let gaps = 0;
    for (const row of matrix.rows) {
      expect(row.cells).toHaveLength(LAUNCH_REGIONS.length);
      for (const cell of row.cells) {
        expect(cell.gap).toBe(cell.total === 0); // never a blank/silent cell
        if (cell.gap) gaps += 1;
        else covered += 1;
      }
    }
    expect(covered).toBe(matrix.coveredCount);
    expect(gaps).toBe(matrix.gapCount);
    expect(covered + gaps).toBe(matrix.cellCount);
  });

  it('corrections queue summary counts open/in-review and finds the oldest-open', async () => {
    const summary = await getCorrectionsQueueSummary();
    expect(summary.openCount).toBeGreaterThanOrEqual(1);
    expect(summary.inReviewCount).toBeGreaterThanOrEqual(1);
    expect(summary.unresolvedCount).toBeGreaterThanOrEqual(summary.openCount + summary.inReviewCount - 0);
    expect(summary.oldestOpenAt).not.toBeNull();
    // The oldest open report can be no newer than the 10-day-old one we seeded.
    expect(Date.parse(summary.oldestOpenAt as string)).toBeLessThanOrEqual(ids.dbNowMs - 9 * 86_400_000);

    // The reused recent-list read surfaces our seeded reports.
    const recent = await getRecentCorrections({ redactPersonalData: false });
    expect(recent.some((c) => c.occurrenceId === ids.occId)).toBe(true);
  });
});
