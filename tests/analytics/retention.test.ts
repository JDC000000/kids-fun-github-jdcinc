// tests/analytics/retention.test.ts — the retention job REALLY deletes expired
// rows, against real Postgres. DB-gated (skipped without DATABASE_URL, like the
// email suite). Proves G-T31-3: past-retention events are purged on a job run,
// fresh rows are untouched, dry-run deletes nothing, and the window is enforced.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import { purgeExpiredAnalyticsEvents } from '../../lib/analytics/retention';
import { emitEvent } from '../../lib/analytics/emit';

const hasDb = Boolean(process.env.DATABASE_URL);

/** Insert an analytics_event row with an explicit retained_until offset (days from now). */
async function insertEvent(tag: string, retainedOffsetDays: number): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO analytics_event (event_type, user_or_session, retained_until)
       VALUES ('search_performed', $1, now() + ($2 || ' days')::interval)
     RETURNING id`,
    [tag, String(retainedOffsetDays)]
  );
  return row.id;
}

async function countByTag(tag: string, onlyExpired = false): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM analytics_event
      WHERE user_or_session = $1 ${onlyExpired ? 'AND retained_until < now()' : ''}`,
    [tag]
  );
  return Number(rows[0]?.n ?? '0');
}

describe.skipIf(!hasDb)('purgeExpiredAnalyticsEvents (real Postgres)', () => {
  let tag = '';
  beforeEach(() => {
    tag = `ret-test-${randomUUID().slice(0, 8)}`;
  });
  afterAll(async () => {
    // Best-effort cleanup of any test-tagged rows, then close the pool.
    try {
      await query(`DELETE FROM analytics_event WHERE user_or_session LIKE 'ret-test-%'`);
    } finally {
      await closePool();
    }
  });

  it('DRY-RUN counts expired rows but deletes nothing', async () => {
    await insertEvent(tag, -10); // expired 10 days ago
    await insertEvent(tag, -1); // expired yesterday
    await insertEvent(tag, 100); // fresh

    const res = await purgeExpiredAnalyticsEvents({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deleted).toBe(0);
    expect(res.expired).toBeGreaterThanOrEqual(2);
    // Nothing was actually removed.
    expect(await countByTag(tag)).toBe(3);
    expect(await countByTag(tag, true)).toBe(2);
  });

  it('REAL run deletes ONLY rows past retained_until, keeping fresh rows', async () => {
    await insertEvent(tag, -30);
    await insertEvent(tag, -0.001); // just expired
    const freshId = await insertEvent(tag, 200);

    const res = await purgeExpiredAnalyticsEvents({ dryRun: false });
    expect(res.dryRun).toBe(false);
    expect(res.deleted).toBeGreaterThanOrEqual(2);

    // My expired rows are gone; my fresh row survives.
    expect(await countByTag(tag, true)).toBe(0);
    expect(await countByTag(tag)).toBe(1);
    const survivors = await query<{ id: string }>(
      `SELECT id FROM analytics_event WHERE user_or_session = $1`,
      [tag]
    );
    expect(survivors.map((r) => r.id)).toEqual([freshId]);
  });

  it('drains MORE expired rows than one batch (batched delete loops to completion)', async () => {
    for (let i = 0; i < 5; i++) await insertEvent(tag, -5);
    expect(await countByTag(tag, true)).toBe(5);

    const res = await purgeExpiredAnalyticsEvents({ dryRun: false, batchSize: 2 });
    expect(res.deleted).toBeGreaterThanOrEqual(5);
    expect(res.batches).toBeGreaterThanOrEqual(3); // ceil(5/2) = 3 batches minimum
    expect(await countByTag(tag, true)).toBe(0);
  });

  it('emitEvent stamps retained_until from the configured window', async () => {
    const saved = process.env.ANALYTICS_RETENTION_DAYS;
    process.env.ANALYTICS_RETENTION_DAYS = '30';
    try {
      const r = await emitEvent('listing_viewed', null, { probe: true }, tag);
      expect(r.ok).toBe(true);
      const rows = await query<{ days: string }>(
        `SELECT round(extract(epoch FROM (retained_until - now())) / 86400)::text AS days
           FROM analytics_event WHERE user_or_session = $1 LIMIT 1`,
        [tag]
      );
      // ~30 days out (allow the rounding to land on 30).
      expect(Number(rows[0]?.days)).toBe(30);
    } finally {
      if (saved === undefined) delete process.env.ANALYTICS_RETENTION_DAYS;
      else process.env.ANALYTICS_RETENTION_DAYS = saved;
    }
  });
});
