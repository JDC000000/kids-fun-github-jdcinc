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

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The currently-in-force query budget, if some caller has explicitly widened it.
 * Empty on every ordinary request path — see {@link withQueryBudget}.
 */
const queryBudgetScope = new AsyncLocalStorage<number>();

/**
 * The per-query ceiling every read behind /admin/* opts into.
 *
 * ═══ THIS NUMBER PROTECTS THE DATABASE. IT IS NOT A PERFORMANCE TARGET. ═══
 * Read what it is defending against, because the value only makes sense against that.
 * Measured in production on 2026-09-14, one load of /admin/operating:
 *
 *   • the page fans TWELVE reads out of one Promise.all against a pool that then held 5;
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

// ─────────────────────────────────────────────────────────────────────────────
// A SECOND BUDGET, FOR WORK NOBODY IS WAITING ON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ceiling for the SCHEDULED snapshot refresh (lib/admin/snapshot-refresh.ts).
 *
 * ═══ WHY A PAGE BUDGET IS THE WRONG BUDGET FOR A CRON JOB ═══
 * The 45s above is derived from a HUMAN WAITING ON A REQUEST — that is the whole reason it
 * sits under the server's 120s statement_timeout. The refresh job has no such reader: it
 * runs on a schedule, writes a row, and exits. Holding it to the page's ceiling would make
 * the page's slowest read unfixable-by-scheduling, which is precisely backwards — moving
 * work off the request path is the fix, so the off-request path must be allowed to be slower
 * than the request path ever was.
 *
 * Measured standalone against production 2026-09-18 (analytics_event = 2,965,374 rows), the
 * reads this job makes:
 *
 *   getEngagementSeries(day,30)   70,462 ms   ← over the 45s page budget ON ITS OWN
 *   getLifecycleSeries(day,30)    15,369 ms
 *   getActiveUsers                 9,444 ms
 *   getAccountCounts               8,207 ms
 *   getDataCoverage                1,157 ms
 *
 * That top line is why /admin/operating does not merely load slowly — it CANNOT load. The
 * page fans these out concurrently against a pool of 10, every one of them scanning
 * substantially the whole 1,298 MB heap (99.98% of rows fall inside the 30-day review
 * window), so they evict each other's buffers and the same read that costs 1.2s alone costs
 * 38s in company. Both of the two slowest then hit the 45s ceiling and the page 500s.
 *
 * 180s is set from the measured worst case with real headroom, and it is deliberately ABOVE
 * the server's own 120s statement_timeout ceiling for a REQUEST — this job does not run in a
 * request, it runs with `SET LOCAL statement_timeout` inside its own transaction, so its
 * limit is this one.
 *
 * ⚠ Same warning as above: a CEILING, not a target. Every second the rollup work saves
 * should come off this number, not be spent against it.
 */
export const ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS = 180_000;

/**
 * The budget the admin analytics reads ACTUALLY run under, which is the page ceiling unless
 * something up-stack has explicitly widened it.
 *
 * Call this instead of reading {@link ADMIN_ANALYTICS_QUERY_TIMEOUT_MS} directly at a query
 * call site. The constant remains the right thing to import where a budget must be STATIC —
 * lib/db/pool-config.ts derives the pool's acquire timeout from it at construction, long
 * before any request exists to have a scope.
 */
export function adminAnalyticsQueryTimeoutMs(): number {
  return queryBudgetScope.getStore() ?? ADMIN_ANALYTICS_QUERY_TIMEOUT_MS;
}

/**
 * Run `fn` with every admin analytics read inside it held to `ms` instead of the page budget.
 *
 * ═══ WHY AsyncLocalStorage AND NOT A PARAMETER ═══
 * The budget is consumed ~20 call sites deep (getEngagementSeries' `queryWithTimeout`), while
 * the decision to widen it is made at the top (the refresh job). Threading a `timeoutMs`
 * through every intervening signature would put a cron-job concern into the signature of
 * every KPI function, including the ones the PAGES call — and the first person to forget to
 * pass it through would silently hand a page the cron budget. A scope cannot be half-applied.
 *
 * ═══ WHY THIS IS SAFE UNDER CONCURRENCY ═══
 * AsyncLocalStorage is per-async-context, not global: a refresh running inside this scope
 * cannot widen the budget of a page request being served concurrently in the same process.
 * A plain module-level mutable `let` WOULD do exactly that, which is why it is not one.
 */
export function withQueryBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return queryBudgetScope.run(ms, fn);
}
