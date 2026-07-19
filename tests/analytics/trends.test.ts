// tests/analytics/trends.test.ts — READ-SIDE daily product-health TRENDS (T32, G-T32-6).
//
// DB-gated (skipped without DATABASE_URL), like the kpi/retention suites. Rather than
// truncate the shared analytics_event table, it seeds rows keyed to GLOBALLY-UNIQUE
// uuid session ids and asserts the DELTA the seed produces on the always-present
// "today" point — deterministic regardless of what else is already in the table, and
// timezone-independent (it asserts only relative window membership: an event today is
// in today's DAU/WAU/MAU; an event 3 days ago is in WAU/MAU but NOT DAU).
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, query } from '../../lib/db/client';
import { getActivityTrend, TREND_WINDOW_DAYS } from '../../lib/analytics/trends';

const hasDb = Boolean(process.env.DATABASE_URL);

/** Insert one analytics_event at a chosen age for a chosen session. */
async function insertEvent(session: string, hoursAgo: number): Promise<void> {
  await query(
    `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('listing_viewed', $1, now() - ($2 || ' hours')::interval)`,
    [session, String(hoursAgo)]
  );
}

describe.skipIf(!hasDb)('getActivityTrend (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('returns one gap-free point per day, oldest→newest, all-numeric', async () => {
    const trend = await getActivityTrend();
    expect(trend.days).toBe(TREND_WINDOW_DAYS);
    expect(trend.points).toHaveLength(TREND_WINDOW_DAYS);
    expect(trend.windows).toMatchObject({ wauDays: 7, mauDays: 30 });
    // Dates strictly ascending, ISO 'YYYY-MM-DD'.
    for (let i = 1; i < trend.points.length; i++) {
      expect(trend.points[i].date > trend.points[i - 1].date).toBe(true);
      expect(trend.points[i].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const p of trend.points) {
      for (const v of [p.dau, p.wau, p.mau, p.events]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('clamps the requested window to [1, 120]', async () => {
    expect((await getActivityTrend(0)).days).toBe(1);
    expect((await getActivityTrend(7)).days).toBe(7);
    expect((await getActivityTrend(9999)).days).toBe(120);
  });

  it('counts today’s distinct actors into today’s DAU/WAU/MAU + volume', async () => {
    const before = await getActivityTrend();
    const last0 = before.points[before.points.length - 1];

    const sessions = [randomUUID(), randomUUID(), randomUUID()];
    for (const s of sessions) await insertEvent(s, 0); // now() → today's bucket

    const after = await getActivityTrend();
    const last1 = after.points[after.points.length - 1];

    expect(last1.dau - last0.dau).toBe(3);
    expect(last1.wau - last0.wau).toBe(3);
    expect(last1.mau - last0.mau).toBe(3);
    expect(last1.events - last0.events).toBe(3);
  });

  it('rolls a 3-day-old actor into today’s WAU/MAU but not today’s DAU', async () => {
    const before = await getActivityTrend();
    const last0 = before.points[before.points.length - 1];

    await insertEvent(randomUUID(), 72); // 3 days ago

    const after = await getActivityTrend();
    const last1 = after.points[after.points.length - 1];

    expect(last1.dau - last0.dau).toBe(0); // not active *today*
    expect(last1.wau - last0.wau).toBe(1); // within trailing 7d
    expect(last1.mau - last0.mau).toBe(1); // within trailing 30d
  });
});
