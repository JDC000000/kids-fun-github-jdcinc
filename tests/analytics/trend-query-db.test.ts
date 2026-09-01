// tests/analytics/trend-query-db.test.ts — the rewritten activity-trend query, and the per-query
// timeout it runs under. Both landed together to fix a production hang: /admin/operating and
// /admin/product-health returned nothing for >55s because this query ran ~120 sequential scans of
// analytics_event per page load.
//
// ASSERTIONS ARE RELATIVE, NOT ABSOLUTE. analytics_event is shared and may hold anything; a test
// that asserted "dau = 5" would pass or fail on whatever else is in the table. So the aggregation
// is tested by DELTA — insert n known sessions, assert the counts move by exactly n — which holds
// whatever else exists.
import { afterAll, describe, expect, it } from 'vitest';
import { getActivityTrend } from '../../lib/analytics/trends';
import { QueryTimeoutError, closePool, query, queryWithTimeout } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `trendtest-${Date.now()}`;

describe.skipIf(!hasDb)('the rewritten trend query', () => {
  afterAll(async () => {
    await query(`DELETE FROM analytics_event WHERE user_or_session LIKE $1`, [`${MARKER}%`]);
    await closePool();
  });

  it('returns one ordered point per day of the window', async () => {
    const t = await getActivityTrend();
    expect(t.points).toHaveLength(30);
    const dates = t.points.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('🔴 the rolling windows nest: dau <= wau <= mau, every day', async () => {
    // The invariant the correlated-subquery version guaranteed structurally and the rewrite has to
    // reproduce by construction. A rollup that double-counts or mis-bounds a window breaks it.
    const t = await getActivityTrend();
    for (const p of t.points) {
      if (p.dau === null || p.wau === null || p.mau === null) continue;
      expect(p.dau, p.date).toBeLessThanOrEqual(p.wau);
      expect(p.wau, p.date).toBeLessThanOrEqual(p.mau);
      expect(p.events ?? 0, p.date).toBeGreaterThanOrEqual(p.dau);
    }
  });

  it('🔴 counts DISTINCT sessions, not events — five sessions with three events each move dau by 5', async () => {
    const before = (await getActivityTrend()).points.at(-1)!;
    for (let s = 0; s < 5; s += 1) {
      await query(
        `INSERT INTO analytics_event (event_type, user_or_session, created_at)
         SELECT 'search', $1, date_trunc('day', now()) + interval '1 hour' FROM generate_series(1,3)`,
        [`${MARKER}-s${s}`]
      );
    }
    const after = (await getActivityTrend()).points.at(-1)!;
    expect(after.dau! - before.dau!).toBe(5);      // sessions, not the 15 events
    expect(after.events! - before.events!).toBe(15); // events counts all of them
    // Today's sessions are inside both trailing windows, so those move by the same 5.
    expect(after.wau! - before.wau!).toBe(5);
    expect(after.mau! - before.mau!).toBe(5);
  });

  it('ignores blank session ids without dropping their events', async () => {
    // NULLIF(user_or_session,'') replaced an explicit IS NOT NULL AND <> '' pair; a blank must not
    // count as an actor, but its event still happened.
    const before = (await getActivityTrend()).points.at(-1)!;
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search', '', date_trunc('day', now()) + interval '1 hour')`
    );
    const after = (await getActivityTrend()).points.at(-1)!;
    expect(after.dau! - before.dau!).toBe(0);
    expect(after.events! - before.events!).toBe(1);
    await query(`DELETE FROM analytics_event WHERE user_or_session = '' AND event_type = 'search'`);
  });
});

describe.skipIf(!hasDb)('queryWithTimeout', () => {
  it('returns rows normally when it finishes in time', async () => {
    const rows = await queryWithTimeout<{ n: number }>(`SELECT 1::int AS n`, undefined, 5_000);
    expect(rows[0].n).toBe(1);
  });

  it('🔴 actually cancels a slow query instead of waiting for it', async () => {
    // The gap this closes: an abandoned HTTP request used to leave the scan running to completion
    // on production Postgres — two orphaned backends had to be killed by hand during this incident.
    await expect(queryWithTimeout(`SELECT pg_sleep(5)`, undefined, 150)).rejects.toThrow();
  });

  it('🔴 the cancellation SAYS it was a timeout, and names the limit', async () => {
    // A timeout changes the symptom of the thing it guards. When the trend query's ceiling shipped,
    // /admin/product-health stopped hanging and started returning a 500 at ~8.4s — the guard
    // working, but the new symptom read as a NEW bug, and the only clue it was ours was that 8.4s
    // happened to match an 8000ms constant someone had to remember. A bare Postgres 57014 does not
    // say who set the limit or what it was. This does.
    let caught: unknown;
    try {
      await queryWithTimeout(`SELECT pg_sleep(5)`, undefined, 150);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueryTimeoutError);
    expect((caught as QueryTimeoutError).timeoutMs).toBe(150);
    expect(String((caught as Error).message)).toContain('150ms');
    expect(String((caught as Error).message)).toContain('statement_timeout');
    // The original pg error survives for anything that wants its fields.
    expect((caught as Error).cause).toBeDefined();
  });

  it('does NOT relabel an ordinary query failure as a timeout', async () => {
    // 57014 is the only code attributed. A syntax error must stay a syntax error.
    await expect(queryWithTimeout(`SELECT * FROM no_such_table_xyz`, undefined, 5_000))
      .rejects.not.toBeInstanceOf(QueryTimeoutError);
  });

  it('🔴 does NOT leak statement_timeout onto the pooled connection', async () => {
    // The reason it is SET LOCAL inside a transaction. A bare SET would persist on that connection
    // and silently start cancelling whatever unrelated caller picked it up next — including the
    // retention purge's long batches, which share this pool.
    await expect(queryWithTimeout(`SELECT pg_sleep(5)`, undefined, 150)).rejects.toThrow();
    // A plain pooled query that sleeps LONGER than the timeout just used must still complete. If
    // the setting had leaked, this would be cancelled at 150ms instead of sleeping its full 400ms.
    const t0 = Date.now();
    await query(`SELECT pg_sleep(0.4)`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it('🔴 does NOT leak after a SUCCESSFUL call — the COMMIT path, where SET and SET LOCAL diverge', async () => {
    // ═══ WHY THIS TEST EXISTS SEPARATELY FROM THE ONE ABOVE ═══
    // The test above cannot tell `SET LOCAL` from a plain `SET`, and I claimed it could. Its first
    // call TIMES OUT, so it exits through ROLLBACK — and Postgres undoes a plain `SET` on ROLLBACK
    // exactly as it undoes `SET LOCAL`. Verified directly:
    //
    //     BEGIN; SET statement_timeout=150; ROLLBACK;        SHOW -> 0        (indistinguishable)
    //     BEGIN; SET statement_timeout=150; COMMIT;          SHOW -> 150ms    (LEAKS)
    //     BEGIN; SET LOCAL statement_timeout=150; COMMIT;    SHOW -> 0        (safe)
    //
    // So the two spellings only diverge on COMMIT — the path a query takes when it SUCCEEDS, which
    // is every ordinary call. This test drives that path: a fast query under a timeout it never
    // hits, reaching COMMIT, after which a plain `SET` would persist on the pooled connection and
    // start cancelling whatever unrelated caller picks it up next — including the worker's
    // retention batches, which share this pool.
    await queryWithTimeout(`SELECT 1`, undefined, 150);

    // Sampled across several checkouts because the pool hands out whichever connection is free;
    // a leak on any one of them is a leak. `SHOW` reports the session value directly, so this does
    // not depend on timing.
    for (let i = 0; i < 12; i += 1) {
      const [row] = await query<{ statement_timeout: string }>(`SHOW statement_timeout`);
      expect(row.statement_timeout, `checkout ${i}`).toBe('0');
    }
  });
});
