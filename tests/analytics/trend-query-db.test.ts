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

  it('🔴 the frame cannot degrade to O(n^2) — neither unbounded, nor bounded-but-shrinking', () => {
    // THIS GUARD HAS NOW BEEN WRONG TWICE, BOTH TIMES BY PINNING A SPELLING.
    // v1 pinned `GROUPS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING`. v2 replaced it with
    // `EXCLUDE GROUP` and its own comment said the guard "now pins the property rather than the
    // one spelling that first achieved it" -- then pinned EXCLUDE GROUP, which is also just a
    // spelling. Both versions passed while the query was too slow to serve a page.
    //
    // Tie exclusion is pinned BEHAVIOURALLY below and does not need a regex. What a regex CAN
    // pin is the shape that made both previous forms quadratic, so that is all this asserts:
    //
    //   UNBOUNDED FOLLOWING           -- dc55d1a. Frame shrinks from the left; min() has no
    //                                    inverse, so every row rescans. 32.9s in WindowAgg alone.
    //   RANGE ... CURRENT ROW AND     -- 091d1a8. Bounded, but the bound is only reached if the
    //   <n> FOLLOWING                    session is sparser than the window. Production has 2,758
    //                                    sessions with >100 events inside <30 min, so for those
    //                                    the frame runs to the end of the session anyway: still
    //                                    O(n^2), and it took the page to a hard 60s timeout.
    //
    // The surviving form sorts DESC so the frame only ever GROWS, which is maintainable in one
    // comparison per row and is what makes cost independent of session density.
    expect(code).not.toMatch(/UNBOUNDED FOLLOWING/);
    expect(code).not.toMatch(/RANGE\s+BETWEEN\s+CURRENT ROW\s+AND[\s\S]{0,80}?FOLLOWING/i);
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
    // LIKE, not `=`: the edge case below uses a sibling session id. Cleanup also must not sit
    // after an assertion — a failing expect() aborts the test and the rows survive into the next
    // suite, which is how `tietest` rows were found still in the table after a mutation run.
    await query(`DELETE FROM analytics_event WHERE user_or_session LIKE $1`, [`${S}%`]);
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

  it('🔴 an engagement event at EXACTLY the window edge counts — the bound is inclusive', async () => {
    // Added because a mutation survived: changing `<=` to `<` on the engage bound broke nothing.
    // Every engagement test used +60s, far inside the window, so the two spellings were
    // indistinguishable. The recover path had an edge case and the engage path did not — the same
    // asymmetry that let a near-vacuous recover check pass earlier. Both bounds are now pinned.
    const S2 = `${S}-edge`;
    const before = await engagedToday();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${AT}),
              ('listing_viewed',   $1, ${AT} + interval '30 minutes')`,
      [S2]
    );
    expect(await engagedToday()).toBe(before + 1);
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE RECOVER PATH, WHICH HAD NO BOUNDARY COVERAGE UNTIL NOW.
//
// getEngagementSeries computes TWO look-aheads over the same window: `engaged` and `recovered`.
// Every previous verification exercised only `engaged`. When the frame was rewritten a third
// time, the first identity check ran on a fixture where recovered summed to 3 across 30 periods
// — technically non-zero, so it did not read as vacuous, but nowhere near enough to discriminate
// anything. Both aggregates changed; only one was actually being tested.
//
// These pin the recover boundary per-case, at the exact edges where an off-by-one in the bound
// or a lost tie-exclusion would show up.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasDb)('engagement: the recover window bound is exact and tie-safe', () => {
  const S = `rectest-${Date.now()}`;
  const AT = `date_trunc('day', now()) + interval '6 hours'`;

  afterAll(async () => {
    await query(`DELETE FROM analytics_event WHERE user_or_session LIKE $1`, [`${S}%`]);
  });

  async function recoveredToday(): Promise<number> {
    const { getOperatingPeriodCounts } = await import('../../lib/analytics/operating');
    const rows = await getOperatingPeriodCounts('day', 1);
    return rows[rows.length - 1].recoveredZeroResultSearches;
  }

  async function zeroThen(tag: string, offset: string | null): Promise<void> {
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at, result_summary_json)
       VALUES ('search_performed', $1, ${AT}, '{"total":"0"}'::jsonb)`,
      [`${S}-${tag}`]
    );
    if (offset !== null) {
      await query(
        `INSERT INTO analytics_event (event_type, user_or_session, created_at, result_summary_json)
         VALUES ('search_performed', $1, ${AT} + interval '${offset}', '{"total":"5"}'::jsonb)`,
        [`${S}-${tag}`]
      );
    }
  }

  it('🔴 a re-search at EXACTLY the window edge counts as recovery', async () => {
    // SEARCH_OUTCOME_WINDOW_MINUTES is 30 and the bound is inclusive. `<` instead of `<=` here.
    const before = await recoveredToday();
    await zeroThen('edge', '30 minutes');
    expect(await recoveredToday()).toBe(before + 1);
  });

  it('🔴 a re-search past the window does NOT count', async () => {
    const before = await recoveredToday();
    await zeroThen('outside', '40 minutes');
    expect(await recoveredToday()).toBe(before);
  });

  it('🔴 a successful search at the SAME instant is not "later" and does not count', async () => {
    // Same tie rule as engagement: created_at defaults to now(), so a zero-result search and a
    // successful one written in one transaction share a timestamp. Recovery means strictly later.
    const before = await recoveredToday();
    await zeroThen('tie', '0 minutes');
    expect(await recoveredToday()).toBe(before);
  });

  it('🔴 a zero-result search followed only by another zero-result is not recovered', async () => {
    const before = await recoveredToday();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at, result_summary_json)
       VALUES ('search_performed', $1, ${AT}, '{"total":"0"}'::jsonb),
              ('search_performed', $1, ${AT} + interval '5 minutes', '{"total":"0"}'::jsonb)`,
      [`${S}-none`]
    );
    expect(await recoveredToday()).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// SESSION DENSITY, THE AXIS THAT CAUSED THE OUTAGE.
//
// 091d1a8 was verified as correct and measured as fast, and still took /admin/operating to a hard
// 60s timeout. Both checks were run on fixtures whose sessions were SPARSE relative to the 30-min
// outcome window. Production is not uniformly sparse: ~2,758 sessions carry >100 events inside
// <30 minutes. For those, a frame bounded at 30 minutes never reaches its bound before the
// partition ends, so it stays quadratic while every sparse session gets faster.
//
// A wall-clock threshold would be machine-dependent and flaky. This compares the SAME event count
// arranged two ways, which is self-calibrating: under a growing frame both are linear and the
// ratio is ~1; under any shrinking frame the dense arrangement blows up.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasDb)('engagement: cost does not depend on session density', () => {
  const S = `dens-${Date.now()}`;
  const N = 4000;

  afterAll(async () => {
    await query(`DELETE FROM analytics_event WHERE user_or_session LIKE $1`, [`${S}%`]);
  });

  // The frame is EXTRACTED FROM operating.ts RATHER THAN RESTATED HERE. A copy of the good SQL
  // would pass this test forever regardless of what the shipped query does — it would assert that
  // a growing frame is fast, which is not in doubt, instead of that the query USES one. Reading
  // the real WINDOW clause means a regression in operating.ts changes what this test times.
  const engagementFrame = (() => {
    const src = require('node:fs').readFileSync('lib/analytics/operating.ts', 'utf8') as string;
    const m = src.match(/WINDOW w AS \(([\s\S]*?)\n\s*\)/);
    if (!m) throw new Error('could not find WINDOW w in operating.ts — test needs updating');
    return m[1].replace(/\$4::int/g, '30').replace(/\be\./g, '');
  })();

  async function timeWindowOver(like: string): Promise<number> {
    const t = Date.now();
    await query(
      `SELECT count(*) FROM (
         SELECT count(*) FILTER (WHERE event_type = 'listing_viewed') OVER w AS n
         FROM analytics_event WHERE user_or_session LIKE $1
         WINDOW w AS (${engagementFrame})) x`,
      [like]
    );
    return Date.now() - t;
  }

  it('🔴 N events packed into one 10-minute session cost about the same as N spread over 20 days', async () => {
    // dense: every event inside the outcome window, so a bounded frame gains nothing
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       SELECT CASE WHEN g % 3 = 0 THEN 'listing_viewed' ELSE 'search_performed' END,
              $1, date_trunc('day', now()) + interval '3 hours' + (g * interval '0.15 seconds')
       FROM generate_series(1, $2::int) g`,
      [`${S}-dense`, N]
    );
    // sparse: same session, same event count, spread far wider than the window
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       SELECT CASE WHEN g % 3 = 0 THEN 'listing_viewed' ELSE 'search_performed' END,
              $1, date_trunc('day', now()) - interval '20 days' + (g * interval '7 minutes')
       FROM generate_series(1, $2::int) g`,
      [`${S}-sparse`, N]
    );

    const dense = await timeWindowOver(`${S}-dense`);
    const sparse = await timeWindowOver(`${S}-sparse`);
    // Generous: the point is to catch quadratic blow-up (which is orders of magnitude), not to
    // police small constant factors on a shared machine.
    expect(dense).toBeLessThan(Math.max(sparse, 50) * 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// getLifecycleSeries: the table was read once per period, not once.
//
// prior_actors and retained_actors were correlated scalar subqueries evaluated PER PERIOD, and
// retained_actors carried a nested EXISTS inside that. At 1.17M events the query touched
// 2,292,271 shared buffers and spilled; the same computation off one pre-aggregated (period,
// actor) relation touches ~48k and does not. Same shape as the getOpsSeries and kpi.ts fixes:
// aggregate first, then join 30 small rows.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('🔴 getLifecycleSeries reads the event table once, not once per period', () => {
  const raw = require('node:fs').readFileSync('lib/analytics/operating.ts', 'utf8') as string;
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');
  const fn = code.slice(
    code.indexOf('async function getLifecycleSeries'),
    code.indexOf('async function getEmailOptInSeries')
  );

  it('has no correlated subquery re-reading analytics_event per period', () => {
    // The tell is analytics_event appearing inside a scalar subquery correlated on p.pstart.
    expect(fn).not.toMatch(/SELECT count\(DISTINCT[\s\S]{0,400}?FROM analytics_event[\s\S]{0,400}?p\.pstart/i);
    expect(fn).not.toMatch(/EXISTS\s*\(\s*SELECT[\s\S]{0,300}?FROM analytics_event/i);
  });

  it('joins periods to pre-aggregated relations, never to the event table directly', () => {
    // `JOIN analytics_event ON e.created_at >= p.pstart AND ...` is the range join that made the
    // planner materialise one row per (period, event) before de-duplicating with DISTINCT.
    expect(fn).not.toMatch(/JOIN\s+analytics_event[\s\S]{0,120}?p\.pstart/i);
    expect(fn).not.toMatch(/SELECT DISTINCT p\.pstart/i);
  });
});

describe.skipIf(!hasDb)('lifecycle: new vs returning, prior vs retained', () => {
  const S = `lc-${Date.now()}`;
  const TODAY = `date_trunc('day', now()) + interval '7 hours'`;
  const YDAY = `date_trunc('day', now()) - interval '1 day' + interval '7 hours'`;

  afterAll(async () => {
    await query(`DELETE FROM analytics_event WHERE user_or_session LIKE $1`, [`${S}%`]);
  });

  async function today() {
    const { getOperatingPeriodCounts } = await import('../../lib/analytics/operating');
    const rows = await getOperatingPeriodCounts('day', 2);
    return rows[rows.length - 1];
  }

  it('🔴 an actor whose first-ever event is today is NEW, not returning', async () => {
    const b = await today();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${TODAY})`,
      [`${S}-fresh`]
    );
    const a = await today();
    expect(a.newActors - b.newActors).toBe(1);
    expect(a.returningActors - b.returningActors).toBe(0);
  });

  it('🔴 an actor with history OUTSIDE the window is RETURNING, not new', async () => {
    // Pins that first-seen is computed over all history, not just the 30-day window. If the
    // actor_first scan is ever bounded to the window as an optimisation, this actor would be
    // misread as new — which would silently inflate the new-actor count.
    const b = await today();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, now() - interval '200 days'),
              ('search_performed', $1, ${TODAY})`,
      [`${S}-old`]
    );
    const a = await today();
    expect(a.returningActors - b.returningActors).toBe(1);
    expect(a.newActors - b.newActors).toBe(0);
  });

  it('🔴 active yesterday AND today counts as both prior and retained', async () => {
    const b = await today();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${YDAY}), ('search_performed', $1, ${TODAY})`,
      [`${S}-both`]
    );
    const a = await today();
    expect(a.priorActors - b.priorActors).toBe(1);
    expect(a.retainedActors - b.retainedActors).toBe(1);
  });

  it('🔴 active yesterday but NOT today is prior and NOT retained — the churn case', async () => {
    // The asymmetry that makes retention meaningful. If prior and retained move together for
    // every actor the rate is pinned at 100% and the metric says nothing.
    const b = await today();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${YDAY})`,
      [`${S}-churn`]
    );
    const a = await today();
    expect(a.priorActors - b.priorActors).toBe(1);
    expect(a.retainedActors - b.retainedActors).toBe(0);
  });

  it('🔴 the FIRST period has prior/retained too — its comparison period sits outside the window', async () => {
    // Added because a mutation survived: narrowing the pre-aggregated relation to start at the
    // first period (rather than one period earlier) left every assertion above passing, because
    // they all read the LAST period. The first period's prior and retained would silently read 0
    // and the earliest point on the retention chart would be wrong, not missing — the failure
    // mode that is hardest to notice on a graph.
    const { getOperatingPeriodCounts } = await import('../../lib/analytics/operating');
    const first = async () => (await getOperatingPeriodCounts('day', 3))[0];
    const b = await first();
    // 3 periods => first period is 2 days ago; its comparison period is 3 days ago, which is
    // outside the requested window entirely.
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, date_trunc('day', now()) - interval '3 days' + interval '7 hours'),
              ('search_performed', $1, date_trunc('day', now()) - interval '2 days' + interval '7 hours')`,
      [`${S}-firstp`]
    );
    const a = await first();
    expect(a.priorActors - b.priorActors).toBe(1);
    expect(a.retainedActors - b.retainedActors).toBe(1);
  });

  it('🔴 a new actor counts as activated only with an activation event', async () => {
    const b = await today();
    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${TODAY})`,
      [`${S}-noact`]
    );
    const mid = await today();
    expect(mid.newActors - b.newActors).toBe(1);
    expect(mid.activatedNewActors - b.activatedNewActors).toBe(0);

    await query(
      `INSERT INTO analytics_event (event_type, user_or_session, created_at)
       VALUES ('search_performed', $1, ${TODAY}), ('listing_viewed', $1, ${TODAY})`,
      [`${S}-act`]
    );
    const a = await today();
    expect(a.newActors - mid.newActors).toBe(1);
    expect(a.activatedNewActors - mid.activatedNewActors).toBe(1);
  });
});
