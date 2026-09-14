// lib/db/budgets.ts — how long a database read is ALLOWED to take.
//
// A separate module from client.ts on purpose, and the reason is mechanical rather than
// tidiness: client.ts constructs a pg Pool, so tests/vitest-lane-split.test.ts treats any
// file importing it as one that can execute real SQL and requires it in the serial db lane.
// A budget is a number. Pure config tests, and lib/db/pool-config.ts itself, need to read it
// without being routed into a lane they have no business in.
//
// It is also the honest home for it: this value constrains the POOL (pool-config.ts derives
// its acquire timeout from it) and the CALL SITES (queryWithTimeout's third argument) alike,
// so it belongs to neither one of them.

/**
 * The per-query ceiling every read behind /admin/* opts into.
 *
 * ═══ THIS NUMBER PROTECTS THE DATABASE. IT IS NOT A PERFORMANCE TARGET. ═══
 * Read what it is defending against, because the value only makes sense against that.
 * Measured in production on 2026-09-14, one load of /admin/operating:
 *
 *   • the page fans NINE reads out of one Promise.all against a pool whose max is 5;
 *   • `getLifecycleSeries` took 35–50s, `getEngagementSeries` ~17s, and one unrelated
 *     admin aggregate 68s — none of them bounded by anything of ours;
 *   • the request 500'd at 17.5s (the ONE query that did have a budget, the 8s trend
 *     query, spent ~9s waiting for a pool slot and then exceeded it) — and the other
 *     statements CARRIED ON. Two were observed in `pg_stat_activity` still executing at
 *     1m59s and 1m16s, long after the function that started them was gone;
 *   • repeated loads stacked those orphans to 23 of the instance's 60 connections.
 *
 * That is the whole mechanism behind both reported symptoms. A statement nobody is waiting
 * for still holds a backend, and a backend held that long gets ENDED FOR US — by the
 * server's own 120s `statement_timeout` (`57014 canceling statement due to statement
 * timeout`) or by the platform reclaiming it (`57P01 terminating connection due to
 * administrator command`). Neither error names the page, the query or the cause, which is
 * why the Sentry issue read as a database fault rather than as this page's appetite.
 *
 * 45s is therefore derived from two constraints, and NEITHER of them is "how long a
 * dashboard may take":
 *
 *   UPPER — comfortably under the server's own 120s `statement_timeout`, so when something
 *   does run away it is OUR limit that fires. That is the whole difference between a
 *   `QueryTimeoutError` naming the budget and the caller, and an anonymous 57014/57P01 that
 *   sends the reader to Sentry to work out which page even produced it.
 *
 *   LOWER — above the slowest read the page legitimately makes, or the guard stops being a
 *   guard and becomes an outage. Measured standalone against production on 2026-09-14:
 *   getLifecycleSeries 14.6–18.6s, getEngagementSeries ~17s. They run CONCURRENTLY against
 *   five connections, so the ceiling needs roughly double the standalone figure before a
 *   healthy load starts tripping it.
 *
 * The important property is not the number, it is that the statement CANCELS ITSELF. It is
 * set with `SET LOCAL` inside the transaction, so it holds even when the serverless function
 * that issued it has already been torn down — which is the exact case that produced the bug:
 * statements observed still executing at 1m59s with nothing left alive to receive the result.
 *
 * ⚠ THIS IS A CEILING, NOT A TARGET. A page that needs 45s is a page with a read problem;
 * the fix for that lives in the queries (and, ultimately, in pre-aggregating analytics_event
 * rather than re-scanning 2.65M rows per load). Lower this number as those land — do not
 * raise it to accommodate a read that got slower.
 */
export const ADMIN_ANALYTICS_QUERY_TIMEOUT_MS = 45_000;
