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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The KPI sort-spill fix. Both queries counted distinct actors with count(DISTINCT …) over a
// window that, in production, contains essentially the whole table — a sort that does not fit
// work_mem (3.5MB) and spills to disk. getActiveUsers cost 6.66s / 68MB; getAccountValue cost
// 10.27s / 237MB, which is LARGER despite its FILTER, because FILTER does not narrow what a
// DISTINCT aggregate sorts.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasDb)('KPI actor counts, after the de-spill rewrite', () => {
  const M = `kpitest-${Date.now()}`;
  const seen: string[] = [];

  afterAll(async () => {
    await query(`DELETE FROM analytics_event WHERE user_or_session = ANY($1::text[])`, [seen]);
  });

  it('🔴 counts distinct ACTORS, not events, across all three windows', async () => {
    const { getProductHealthKpis } = await import('../../lib/analytics/kpi');
    const before = (await getProductHealthKpis()).activeUsers;

    // Three actors, several events each, all inside the DAU window — so every window moves by 3.
    for (let a = 0; a < 3; a += 1) {
      const id = `${M}-a${a}`;
      seen.push(id);
      await query(
        `INSERT INTO analytics_event (event_type, user_or_session, created_at)
         SELECT 'search_performed', $1, now() - interval '1 hour' FROM generate_series(1, 4)`,
        [id]
      );
    }

    const after = (await getProductHealthKpis()).activeUsers;
    expect(after.dau - before.dau).toBe(3); // actors, not the 12 events
    expect(after.wau - before.wau).toBe(3);
    expect(after.mau - before.mau).toBe(3);
  });

  it('🔴 an actor active twice in one window is still counted once', async () => {
    // The property the DISTINCT existed for, and the one the max(created_at) rewrite has to keep.
    const { getProductHealthKpis } = await import('../../lib/analytics/kpi');
    const before = (await getProductHealthKpis()).activeUsers;
    const id = `${M}-repeat`;
    seen.push(id);
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, now() - interval '2 hours'),
              ('listing_viewed',   $1, now() - interval '1 hour')`,
      [id]
    );
    const after = (await getProductHealthKpis()).activeUsers;
    expect(after.dau - before.dau).toBe(1);
  });
});

describe('🔴 the anti-pattern does not come back', () => {
  // Structural, comments stripped: the exact spelling that spilled. A future edit reintroducing
  // count(DISTINCT user_or_session) FILTER(...) over the full window rebuilds the sort this
  // removed, and would look perfectly reasonable in review.
  const raw = require('node:fs').readFileSync('lib/analytics/kpi.ts', 'utf8') as string;
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

  it('no count(DISTINCT user_or_session) FILTER remains in kpi.ts', () => {
    expect(code).not.toMatch(/count\(DISTINCT\s+user_or_session\)\s*FILTER/i);
  });
});

describe('🔴 the engagement series does not go back to correlated subqueries', () => {
  // getEngagementSeries ran two EXISTS subqueries PER ROW against analytics_event, matched on
  // user_or_session. At production's shape that did not finish in ten minutes. The window-function
  // form is byte-identical (verified across all 16 columns x 30 periods, on a fixture containing
  // 110,653 timestamp ties) and runs in ~7s with idx_analytics_event_actor_created.
  const raw = require('node:fs').readFileSync('lib/analytics/operating.ts', 'utf8') as string;
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

  it('no EXISTS correlated on user_or_session remains', () => {
    expect(code).not.toMatch(/EXISTS\s*\(\s*SELECT[\s\S]{0,200}?user_or_session\s*=\s*e\.user_or_session/i);
  });

  it('🔴 keeps the GROUPS frame, which is what makes the rewrite exact', () => {
    // ROWS would order ties arbitrarily; RANGE would include peers. Only GROUPS reproduces the
    // original's strict `f.created_at > e.created_at` when two events share a timestamp — and
    // created_at defaults to now(), which is identical for every row in one transaction.
    expect(code).toMatch(/GROUPS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// TIE SEMANTICS, AS A PERMANENT TEST RATHER THAN AN EXPLORATORY CHECK.
//
// dc55d1a claimed byte-identical output against a fixture containing 110,653 timestamp ties. That
// check was real but EXPLORATORY — it was never committed, so nothing stopped a later edit from
// quietly breaking the behaviour it verified. The structural guard above only pins the SPELLING
// (`GROUPS BETWEEN 1 FOLLOWING`); it cannot tell you the spelling still does the right thing.
//
// These two cases pin the BEHAVIOUR directly, and they are the whole reason GROUPS was chosen:
// the original predicate was `f.created_at > e.created_at` — STRICTLY later. A tie must NOT count.
// Ties are not hypothetical: created_at defaults to now(), identical for every row written inside
// one transaction.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasDb)('engagement: a tie is not "later"', () => {
  const S = `tietest-${Date.now()}`;
  const AT = `date_trunc('day', now()) + interval '6 hours'`;

  afterAll(async () => {
    await query(`DELETE FROM analytics_event WHERE user_or_session = $1`, [S]);
  });

  async function engagedToday(): Promise<number> {
    const { getOperatingPeriodCounts } = await import('../../lib/analytics/operating');
    const rows = await getOperatingPeriodCounts('day', 1);
    return rows[rows.length - 1].engagedSearches;
  }

  it('🔴 an engagement event at the SAME timestamp does not count as engagement', async () => {
    const before = await engagedToday();
    // search and listing_viewed at the EXACT same instant — the original's `>` excludes this.
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${AT}), ('listing_viewed', $1, ${AT})`,
      [S]
    );
    expect(await engagedToday()).toBe(before);
  });

  it('🔴 a genuinely later engagement event, inside the window, DOES count', async () => {
    const before = await engagedToday();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('listing_viewed', $1, ${AT} + interval '60 seconds')`,
      [S]
    );
    // The same search now has a strictly-later engagement within SEARCH_OUTCOME_WINDOW_MINUTES.
    expect(await engagedToday()).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// getOpsSeries: the Cartesian-product fix. The old form LEFT JOINed `periods` to three tables at
// once (correction_report twice, source_check_run once), so each period emitted
// opened x resolved x runs rows and count(DISTINCT ...) removed the duplication afterwards.
// Measured on 600 + 50,000 source rows: 9,898,120 rows emitted, 708MB spilled, 28.7s.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('🔴 getOpsSeries does not rebuild the Cartesian join', () => {
  const raw = require('node:fs').readFileSync('lib/admin/operating.ts', 'utf8') as string;
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');
  const fn = code.slice(code.indexOf('async function getOpsSeries'), code.indexOf('export async function getOperatingOpsPeriods'));

  it('counts without DISTINCT — the tell that nothing is being de-duplicated', () => {
    // count(DISTINCT ...) here was never a business rule. It compensated for row multiplication
    // the joins created. If it comes back, the join almost certainly came back with it.
    expect(fn).not.toMatch(/count\(DISTINCT/i);
  });

  it('joins periods only to pre-aggregated relations, never to a base table', () => {
    expect(fn).not.toMatch(/LEFT JOIN\s+correction_report/i);
    expect(fn).not.toMatch(/LEFT JOIN\s+source_check_run/i);
  });
});

describe.skipIf(!hasDb)('getOpsSeries counts each row once', () => {
  const OCC = 'ops-fixture';
  afterAll(async () => {
    await query(`DELETE FROM correction_report WHERE issue_type = $1`, [OCC]);
  });

  it('🔴 opened and resolved are counted independently, not multiplied', async () => {
    // The bug this replaced would have reported opened x resolved x runs before DISTINCT; the
    // DISTINCT hid it. These deltas would be identical either way, which is the point: the guard
    // above catches the STRUCTURE, this catches the ARITHMETIC.
    const { getOperatingOpsPeriods } = await import('../../lib/admin/operating');
    const before = (await getOperatingOpsPeriods('day', 1)).at(-1)!;
    const [occ] = await query<{ id: string }>(`SELECT id FROM activity_occurrence LIMIT 1`);
    if (!occ) return; // nothing to attach to on an empty catalogue
    await query(
      `INSERT INTO correction_report (occurrence_id, issue_type, created_at, resolved_at)
       SELECT $1::uuid, $2, now() - interval '1 hour', now() - interval '30 minutes'
         FROM generate_series(1, 3)`,
      [occ.id, OCC]
    );
    const after = (await getOperatingOpsPeriods('day', 1)).at(-1)!;
    expect(after.correctionsOpened - before.correctionsOpened).toBe(3);
    expect(after.correctionsResolved - before.correctionsResolved).toBe(3);
  });
});
