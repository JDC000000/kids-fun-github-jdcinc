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
import {
  buildTrendPoints,
  getActivityTrend,
  TREND_WINDOW_DAYS,
  type TrendPoint,
  type TrendRow,
} from '../../lib/analytics/trends';

const hasDb = Boolean(process.env.DATABASE_URL);

// ─────────────────────────────────────────────────────────────────────────────
// PURE pre-history rule (H1 item 1) — no database, fully deterministic.
//
// These run everywhere, including without DATABASE_URL, because the property they
// protect is the one most easily lost: /admin/product-health is LIVE production code
// and a genuinely quiet day must keep reading as a real, visible 0. The shared test
// database cannot pin that down (its first-event anchor is whatever previous suites
// left behind), so the rule is asserted at its pure seam instead.
// ─────────────────────────────────────────────────────────────────────────────

const row = (date: string, n: number): TrendRow => ({ date, dau: n, wau: n, mau: n, events: n });
const measures = (p: TrendPoint) => [p.dau, p.wau, p.mau, p.events];

describe('buildTrendPoints — pre-history vs. a genuine zero', () => {
  // Instrumentation's first event: mid-morning on 2026-07-21.
  const FIRST_EVENT = Date.parse('2026-07-21T09:30:00Z');

  it('NO-REGRESSION: a zero-traffic day AFTER the first event stays a real, visible 0', () => {
    // ── THE POINT OF THE WHOLE FEATURE ──────────────────────────────────────────
    // /admin/product-health and /admin/operating exist to make a traffic cliff
    // visible. If this fix over-corrected into "everything quiet is unknown", a real
    // outage would render identically to pre-history and the dashboards would go
    // blind — a strictly worse bug than the flat-zero line being fixed, because it
    // fails silent. 07-22 and 07-23 recorded genuine zeros. They must SHOW as zeros.
    const points = buildTrendPoints(
      [row('2026-07-21', 5), row('2026-07-22', 0), row('2026-07-23', 0), row('2026-07-24', 3)],
      FIRST_EVENT
    );

    const byDate = new Map(points.map((p) => [p.date, p]));
    for (const date of ['2026-07-22', '2026-07-23']) {
      const p = byDate.get(date)!;
      expect(p.preHistory).toBe(false);
      expect(measures(p)).toEqual([0, 0, 0, 0]);
      // Explicitly NOT null — `toEqual([0,0,0,0])` would also pass on nulls in a
      // looser matcher, so state the distinction that matters outright.
      for (const v of measures(p)) expect(v).not.toBeNull();
    }
  });

  it('a total outage sandwiched between busy days is preserved, not smoothed away', () => {
    const points = buildTrendPoints(
      [row('2026-07-22', 40), row('2026-07-23', 0), row('2026-07-24', 38)],
      FIRST_EVENT
    );
    expect(points.map((p) => p.events)).toEqual([40, 0, 38]);
    expect(points.every((p) => p.preHistory === false)).toBe(true);
  });

  it('suppresses only the days that CLOSED before the first event', () => {
    const points = buildTrendPoints(
      [row('2026-07-19', 0), row('2026-07-20', 0), row('2026-07-21', 5), row('2026-07-22', 0)],
      FIRST_EVENT
    );
    expect(points.map((p) => p.preHistory)).toEqual([true, true, false, false]);
    // The boundary day itself is measurable — instrumentation was live for part of it.
    expect(points[2].events).toBe(5);
  });

  it('INVARIANT: preHistory ⟺ every measure is null (a day is never half-measurable)', () => {
    const points = buildTrendPoints(
      [row('2026-07-18', 0), row('2026-07-19', 0), row('2026-07-21', 7), row('2026-07-22', 0)],
      FIRST_EVENT
    );
    for (const p of points) {
      const nulls = measures(p).filter((v) => v === null).length;
      expect(nulls).toBe(p.preHistory ? 4 : 0);
    }
  });

  it('suppresses NOTHING when the table is empty — byte-for-byte the pre-H1 series', () => {
    // The empty-database contract (see H1 item 2): with no anchor we cannot claim any
    // period predates anything, so every zero is reported as the real zero it is.
    const rows = [row('2020-01-01', 0), row('2026-07-19', 0), row('2026-07-22', 0)];
    const points = buildTrendPoints(rows, null);
    expect(points.every((p) => p.preHistory === false)).toBe(true);
    expect(points.flatMap(measures).every((v) => v === 0)).toBe(true);
  });

  it('never suppresses days after the anchor even when the anchor is very old', () => {
    // Guards the retention interaction: analytics_event is purged on a rolling 13-month
    // window, so the anchor moves forward over time. A window entirely after the anchor
    // must stay entirely measurable.
    const points = buildTrendPoints([row('2026-07-22', 0), row('2026-07-23', 0)], Date.parse('2025-01-01T00:00:00Z'));
    expect(points.every((p) => p.preHistory === false)).toBe(true);
    expect(points.flatMap(measures)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('preserves date order and one output point per input row', () => {
    const rows = [row('2026-07-19', 0), row('2026-07-21', 1), row('2026-07-22', 2)];
    const points = buildTrendPoints(rows, FIRST_EVENT);
    expect(points.map((p) => p.date)).toEqual(rows.map((r) => r.date));
  });
});

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

  it('returns one gap-free point per day, oldest→newest, every measured value numeric', async () => {
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
      for (const v of measures(p)) {
        // Measured days are finite and non-negative; unmeasurable days are null.
        // "0 or null" is NOT acceptable slack here — which one it is, is the point.
        if (p.preHistory) expect(v).toBeNull();
        else {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('derives preHistory from the live first-event anchor, queried INDEPENDENTLY', async () => {
    // Wires the pure rule to the real read. The anchor is re-queried here rather than
    // read back off the returned object, so the test does not take the module's own
    // word for what its anchor was — if getActivityTrend() ever read min(created_at)
    // differently from getDataCoverage(), this catches it. (This independence is why
    // dropping the unused `firstEventAt` field cost nothing: the stronger assertion
    // never wanted it.)
    const anchorRows = await query<{ first_event_at: Date | null }>(
      `SELECT min(created_at) AS first_event_at FROM analytics_event`
    );
    const raw = anchorRows[0]?.first_event_at ?? null;
    const anchorMs = raw ? new Date(raw).getTime() : null;

    const trend = await getActivityTrend();
    for (const p of trend.points) {
      const dayEnd = Date.parse(`${p.date}T00:00:00Z`) + 86_400_000;
      expect(p.preHistory).toBe(anchorMs != null && dayEnd <= anchorMs);
    }

    // Anti-vacuity: these suites always seed recent rows, so an anchor must exist and
    // today must be measurable. Without this the loop above passes on an all-null read.
    expect(anchorMs).not.toBeNull();
    expect(trend.points[trend.points.length - 1].preHistory).toBe(false);
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

    // Today is never pre-history (its bucket closes in the future), so these are real
    // numbers — asserted rather than assumed, since a null would make the deltas below
    // meaningless instead of failing loudly.
    expect(last0.preHistory).toBe(false);
    expect(last1.preHistory).toBe(false);

    expect(last1.dau! - last0.dau!).toBe(3);
    expect(last1.wau! - last0.wau!).toBe(3);
    expect(last1.mau! - last0.mau!).toBe(3);
    expect(last1.events! - last0.events!).toBe(3);
  });

  it('rolls a 3-day-old actor into today’s WAU/MAU but not today’s DAU', async () => {
    const before = await getActivityTrend();
    const last0 = before.points[before.points.length - 1];

    await insertEvent(randomUUID(), 72); // 3 days ago

    const after = await getActivityTrend();
    const last1 = after.points[after.points.length - 1];

    expect(last0.preHistory).toBe(false);
    expect(last1.preHistory).toBe(false);

    expect(last1.dau! - last0.dau!).toBe(0); // not active *today*
    expect(last1.wau! - last0.wau!).toBe(1); // within trailing 7d
    expect(last1.mau! - last0.mau!).toBe(1); // within trailing 30d
  });
});
