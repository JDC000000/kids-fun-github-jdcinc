// tests/coverage-status-db.test.ts — DB-backed tests for the PUBLIC coverage/status page's
// read layer (lib/coverage-status.ts). Skips when DATABASE_URL is unset (mirrors
// tests/admin/data-health-db.test.ts). Seeds a controlled, uniquely-tagged graph — one
// terms-allowed source with a clean successful run against a Vancouver venue, and one
// PENDING (not yet allowed) source against the same venue — and asserts the connected-count
// and last-crawl-time read on those known inputs, then removes everything it inserted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCoverageStatus } from '../lib/coverage-status';
import { LAUNCH_REGIONS } from '../lib/admin/data-health';
import { closePool, query } from '../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// Unique tag so this run's rows never collide with a concurrent test file / re-run.
const TAG = `coverage_status_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

interface Ids {
  vanRegionId: string;
  allowedSourceId: string;
  pendingSourceId: string;
  venueId: string;
  allowedSeriesId: string;
  pendingSeriesId: string;
}

async function scalar<T>(sql: string, params?: unknown[]): Promise<T> {
  const rows = await query<Record<string, T>>(sql, params);
  return Object.values(rows[0])[0];
}

async function insertReturningId(sql: string, params: unknown[]): Promise<string> {
  const rows = await query<{ id: string }>(sql, params);
  return rows[0].id;
}

describe.skipIf(!hasDb)('lib/coverage-status DB read layer', () => {
  const ids = {} as Ids;

  beforeAll(async () => {
    ids.vanRegionId = await scalar<string>(
      `SELECT id::text FROM region WHERE name = 'Vancouver' AND level = 'municipality' LIMIT 1`
    );
    const openGymCatId = await scalar<string>(`SELECT id::text FROM category WHERE key = 'open_gym' LIMIT 1`);

    ids.allowedSourceId = await insertReturningId(
      `INSERT INTO source (family, name, terms_status, baseline_cadence)
       VALUES ('activenet', $1, 'allowed', '1 day') RETURNING id::text AS id`,
      [`${TAG} Allowed ActiveNet`]
    );
    // Same municipality, but NOT connected (terms review still pending) — must not count
    // toward Vancouver's connected-source total, even though it has a venue there too.
    ids.pendingSourceId = await insertReturningId(
      `INSERT INTO source (family, name, terms_status, baseline_cadence)
       VALUES ('perfectmind', $1, 'pending', '1 day') RETURNING id::text AS id`,
      [`${TAG} Pending PerfectMind`]
    );

    // A clean successful run 2 hours ago for the allowed source — this is the "last crawl".
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'success', now() - interval '2 hours')`,
      [ids.allowedSourceId]
    );
    // A FAILED run 5 minutes ago — more recent, but not clean, so it must NOT win as "last crawl".
    await query(
      `INSERT INTO source_check_run (source_id, status, started_at)
       VALUES ($1, 'failed', now() - interval '5 minutes')`,
      [ids.allowedSourceId]
    );

    ids.venueId = await insertReturningId(
      `INSERT INTO venue (name, municipality_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [`${TAG} Vancouver Rec Centre`, ids.vanRegionId]
    );
    ids.allowedSeriesId = await insertReturningId(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id, default_primary_category)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [`${TAG} Allowed Open Gym`, ids.allowedSourceId, ids.venueId, openGymCatId]
    );
    ids.pendingSeriesId = await insertReturningId(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id, default_primary_category)
       VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [`${TAG} Pending Open Gym`, ids.pendingSourceId, ids.venueId, openGymCatId]
    );
  });

  afterAll(async () => {
    // FK-safe teardown (children first). Guarded so a partial setup still cleans up.
    if (ids.allowedSeriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [ids.allowedSeriesId]);
    if (ids.pendingSeriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [ids.pendingSeriesId]);
    if (ids.venueId) await query(`DELETE FROM venue WHERE id = $1`, [ids.venueId]);
    for (const sid of [ids.allowedSourceId, ids.pendingSourceId]) {
      if (sid) await query(`DELETE FROM source_check_run WHERE source_id = $1`, [sid]);
    }
    for (const sid of [ids.allowedSourceId, ids.pendingSourceId]) {
      if (sid) await query(`DELETE FROM source WHERE id = $1`, [sid]);
    }
    await closePool();
  });

  it('renders every launch region, even ones with zero connected sources', async () => {
    const status = await getCoverageStatus();
    expect(status.regions.map((r) => r.region.key)).toEqual(LAUNCH_REGIONS.map((r) => r.key));
  });

  it('counts only the terms-allowed source, not the pending one, toward Vancouver', async () => {
    const status = await getCoverageStatus();
    const van = status.regions.find((r) => r.region.key === 'van')!;
    // At least our one allowed source; a real DB may already have other allowed Vancouver
    // sources, so this is a floor, not an exact count — the DECISIVE part is the next test.
    expect(van.connectedSources).toBeGreaterThanOrEqual(1);
  });

  it('DECISIVE: the pending source contributes nothing — connecting a source is what counts, not merely having a venue', async () => {
    const before = await getCoverageStatus();
    const vanBefore = before.regions.find((r) => r.region.key === 'van')!.connectedSources;

    // Flip the allowed source to pending too and re-read: Vancouver's count must drop by
    // exactly one (our allowed source), proving the pending source was never counted.
    await query(`UPDATE source SET terms_status = 'pending' WHERE id = $1`, [ids.allowedSourceId]);
    try {
      const after = await getCoverageStatus();
      const vanAfter = after.regions.find((r) => r.region.key === 'van')!.connectedSources;
      expect(vanAfter).toBe(vanBefore - 1);
    } finally {
      await query(`UPDATE source SET terms_status = 'allowed' WHERE id = $1`, [ids.allowedSourceId]);
    }
  });

  it('last crawl is the most recent CLEAN successful run, never a more-recent failed one', async () => {
    const status = await getCoverageStatus();
    const van = status.regions.find((r) => r.region.key === 'van')!;
    expect(van.lastCrawlAt).not.toBeNull();
    // The failed run was 5 minutes ago; the clean success was 2 hours ago. If the failed run
    // had won, this would be well under 2 hours old.
    const ageMs = Date.now() - Date.parse(van.lastCrawlAt!);
    expect(ageMs).toBeGreaterThan(60 * 60 * 1000);
  });

  it('a region with no connected source anywhere reports null lastCrawlAt, not a fabricated time', async () => {
    const status = await getCoverageStatus();
    for (const r of status.regions) {
      if (r.connectedSources === 0) expect(r.lastCrawlAt).toBeNull();
    }
  });
});
