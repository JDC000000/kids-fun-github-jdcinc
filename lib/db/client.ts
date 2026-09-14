// lib/db/client.ts — shared Postgres pool wrapper (server-side only).
// Reads DATABASE_URL (TSD §3A.1). Used by lib/*, tests, and app/api routes.
// NOT for client/browser code — this touches `pg` directly.
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { CONNECTION_ACQUIRE_TIMEOUT_MS, POOL_MAX, poolConfigFor } from './pool-config';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool(poolConfigFor(connectionString));
    // ═══ WITHOUT THIS LISTENER, A DEAD IDLE CONNECTION TAKES THE PROCESS WITH IT ═══
    // node-postgres attaches its own `error` handler to every client it parks in the pool,
    // and that handler re-emits on the POOL: `this.emit('error', err, client)`. A Pool is
    // an EventEmitter, and an EventEmitter that emits 'error' with no listener does not
    // log — Node throws it as an uncaught exception and the process dies.
    //
    // That is not a theoretical path here. The server ends idle backends on its own
    // schedule (`57P01 terminating connection due to administrator command`), and when it
    // ends one that is sitting in our pool rather than one mid-query, this listener is the
    // only thing between that and a killed server instance. `Connection terminated
    // unexpectedly` was already being reported from `pg.lib:client` with no route of its
    // own, which is what that looks like from the outside.
    //
    // pg-pool has ALREADY removed and destroyed the client by the time this runs, so there
    // is nothing to clean up and nothing to retry — the next `connect()` opens a fresh one.
    // The only job here is to keep the throw from happening and leave a trace behind.
    pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] idle pooled connection died; it has been discarded:', err);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await getPool().query<T>(text, params);
  return rows;
}

/**
 * Run one query under a PER-QUERY `statement_timeout`, so an abandoned HTTP request cannot leave
 * an uncancellable scan burning production I/O.
 *
 * ═══ WHY PER-QUERY AND NOT A POOL-LEVEL DEFAULT ═══
 * This pool is shared by everything: the Fly worker's retention purge (lib/retention/sms.ts) runs
 * deliberately long bounded batches through it, and so do the analytics/corrections purges. A
 * connection-level timeout tuned for a sub-second admin read would start killing legitimate
 * maintenance work that deletes people's data on a schedule. So the default stays unbounded and a
 * caller opts in — reads opt in, purges do not.
 *
 * ═══ WHY A TRANSACTION ═══
 * `SET LOCAL` is scoped to the transaction and is reverted by COMMIT/ROLLBACK, which is the whole
 * point on a POOLED connection: a bare `SET statement_timeout` would persist on that connection
 * and silently apply to whatever unrelated caller picked it up next. The transaction is not for
 * atomicity; it is the mechanism that guarantees the setting cannot leak.
 *
 * `SET` cannot take a bind parameter, so the value is interpolated — hence the truncation and
 * clamp, which make it structurally impossible for this to be an injection point.
 *
 * On expiry Postgres raises 57014 (`query_canceled`) and THIS THROWS. That is deliberate: the
 * caller gets a real error to handle rather than a silently empty result.
 */
/**
 * Thrown when a query opted into a timeout and exceeded it.
 *
 * ═══ WHY THIS EXISTS RATHER THAN LETTING 57014 THROUGH ═══
 * A timeout CHANGES THE SYMPTOM of the thing it is guarding, and that turned out to matter. When
 * the trend query's ceiling shipped, /admin/product-health stopped hanging and started returning a
 * 500 in ~8.4s. That is the guard working — an unbounded hang became a handleable error — but the
 * new symptom read like a NEW bug rather than the old one still unfixed, and the number that
 * identified it (8.4s ≈ the 8000ms ceiling) was only recognisable to someone who happened to
 * remember the constant.
 *
 * Postgres raises a bare `57014 query_canceled` with no hint that WE set the limit or what it was.
 * So the error now says so. `cause` keeps the original for anything that wants the pg fields.
 *
 * ═══ WHAT ACTUALLY CAUSED THOSE 500s — CORRECTING THIS COMMIT'S OWN ORIGINAL CLAIM ═══
 * The commit that introduced this class asserted the 500s were "almost certainly the trend query
 * still exceeding 8s because migration 0040's index has not been applied in production." THAT WAS
 * WRONG, and it is recorded here because a commit message cannot be edited once pushed.
 *
 * Settled by three timestamped checks: the index IS applied, IS present, and IS chosen — an
 * EXPLAIN plan shows `Index Scan using idx_analytics_event_created_at`, and the trend query runs
 * 4.36s in ISOLATION, comfortably inside its own 8s budget.
 *
 * The real mechanism is CONTENTION, not a missing index. /admin/product-health fires five queries
 * concurrently against a pool whose max is five (lib/db/pool-config.ts), and two of them were
 * spilling sorts to disk — getActiveUsers at 6.66s / 68MB and getAccountValue at 10.27s / 237MB.
 * The trend query was being pushed past its own ceiling by its siblings, then cancelled, then
 * reported as a 500 that looked like it was about the trend query.
 *
 * Both siblings were de-spilled in a later commit (getActiveUsers 6.66s -> ~0.2s, getAccountValue
 * 10.27s -> ~0.1s), which should remove ~17 seconds of connection-holding from that five-way race.
 * Whether that alone restores the page is a PREDICTION, not a settled fact — if it still times out,
 * the pool size and per-query work_mem are the open design space.
 *
 * The lesson worth keeping is narrower than "diagnose better": A TIMEOUT NAMES THE QUERY IT
 * CANCELLED, NOT THE QUERY THAT CAUSED THE DELAY. This error says which limit fired; it cannot say
 * whose fault it was, and reading the cancelled query as the culprit is exactly the mistake the
 * original commit message made.
 */
export class QueryTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, cause: unknown) {
    super(
      `query exceeded its ${timeoutMs}ms statement_timeout and was cancelled by Postgres (57014). ` +
        `This limit is set per-query by queryWithTimeout() — see the caller's timeout constant. ` +
        `The query did not fail; it was stopped for running too long.`,
      { cause }
    );
    this.name = 'QueryTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a query could not get a connection out of the pool at all.
 *
 * ═══ WHY THIS IS A SEPARATE FAILURE FROM QueryTimeoutError, AND WHY IT NEEDED A TYPE ═══
 * A read behind /admin can fail in two quite different ways, and only one of them had a name.
 * QueryTimeoutError means "I ran and took too long". THIS means "I never started" — the pool
 * was saturated and the 10s acquire window expired while waiting in the queue.
 *
 * That second case is not the rare one. /admin/operating asks for TWELVE connections
 * concurrently (getOperatingPeriodCounts fans 3, getProductHealthKpis fans 3, plus 6 singleton
 * reads) against a pool of POOL_MAX, so some queue by construction. When the slowest holders
 * are the multi-second analytics scans this page is made of, waiting out the full acquire
 * window is an ordinary outcome rather than a pathological one — and it stays reachable at
 * any pool size a single instance can sensibly hold, which is why this has a type.
 *
 * ═══ WHY IT IS NORMALISED HERE RATHER THAN MATCHED AT THE CALL SITE ═══
 * pg-pool signals this with `new Error('timeout exceeded when trying to connect')` — a BARE
 * Error: no `code`, no subclass, nothing to match on but the message string (pg-pool/index.js,
 * the setTimeout in its connect() queue path). A page-level `catch` that sniffed that string
 * would be one upstream copy-edit away from silently reverting to an anonymous 500.
 *
 * So every failure to acquire is re-thrown as this type, whatever pg-pool called it, with the
 * original kept as `cause`. Callers get something they can branch on that cannot rot.
 * `timedOut` says whether it was specifically the acquire window, because "the pool is busy"
 * and "the database is unreachable" deserve different words even though both land here.
 */
export class ConnectionAcquireError extends Error {
  /** True when this was the acquire window expiring, rather than a connection fault. */
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  constructor(cause: unknown) {
    const timedOut =
      cause instanceof Error && /timeout exceeded when trying to connect/i.test(cause.message);
    super(
      timedOut
        ? `could not get a database connection within ${CONNECTION_ACQUIRE_TIMEOUT_MS}ms — the ` +
          `pool (max ${POOL_MAX}) was fully occupied for that whole window. The query never ran.`
        : `could not get a database connection: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'ConnectionAcquireError';
    this.timedOut = timedOut;
    this.timeoutMs = CONNECTION_ACQUIRE_TIMEOUT_MS;
  }
}

/**
 * How long a transaction opened by queryWithTimeout may sit IDLE before Postgres ends it.
 *
 * ═══ THIS EXISTS BECAUSE THE TRANSACTION ITSELF CAUSED A PRODUCTION OUTAGE ═══
 * queryWithTimeout wraps every read in BEGIN…COMMIT purely so `SET LOCAL` cannot leak the
 * timeout onto a pooled connection. That is still the right mechanism — but it quietly turned
 * a survivable failure into a permanent one, and this is the correction.
 *
 * WHAT HAPPENED (production, 2026-09-14, caught in pg_stat_activity):
 *   1. /admin/dashboard and /admin/operating fan more concurrent reads (8 and 12) than the
 *      pool has connections (5), so some queue.
 *   2. One queued read exceeds the acquire window and throws. Promise.all rejects, the page
 *      returns 500 — while its SIBLING reads are still mid-transaction.
 *   3. The serverless function is torn down on that response. Nobody ever sends COMMIT.
 *   4. Postgres keeps each of those backends alive in `idle in transaction`. FOREVER: the
 *      server's own `idle_in_transaction_session_timeout` is 0, and `statement_timeout` does
 *      not apply to a session that is not running a statement.
 *   5. All five pool slots end up wedged, so EVERY later request fails at exactly the 10s
 *      acquire timeout — which is why two admin pages 500'd at ~10.3s with total consistency,
 *      even one request at a time with a pause between them.
 * Observed directly: 5 of 5 connections idle-in-transaction, the oldest 3m35s and still
 * climbing, each one parked immediately AFTER its analytics query had already succeeded.
 *
 * The failure is self-amplifying, which is what made it look like a fresh bug rather than a
 * consequence: every 500 wedges more connections, guaranteeing the next 500.
 *
 * WHY 15s. A legitimate idle gap here is ONE network round trip — the pause between the query
 * returning and COMMIT being sent, ~20ms cross-region. 15s is ~750x that, so it cannot fire on
 * a live transaction that is merely slow; it only fires when nobody is coming back. Low enough
 * that a wedged slot self-clears inside one page load rather than never.
 *
 * DEFENCE IN DEPTH, not a substitute for it: setting `idle_in_transaction_session_timeout` at
 * the database or role level would have prevented this class outright, for every client, and
 * is worth doing separately. This covers our own transactions without needing that change.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

export async function queryWithTimeout<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] | undefined,
  timeoutMs: number
): Promise<T[]> {
  const ms = Math.min(Math.max(Math.trunc(timeoutMs), 1), 600_000);
  // Acquisition is its own failure mode with its own type — see ConnectionAcquireError. It is
  // OUTSIDE the try/finally below on purpose: there is no client to release if this throws.
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    throw new ConnectionAcquireError(err);
  }
  // ═══ A CHECKED-OUT CLIENT HAS NO ERROR LISTENER, AND THAT IS A CRASH ═══
  // pg-pool attaches an 'error' handler to every client it PARKS, and strips it again on
  // checkout (`client.removeListener('error', idleListener)` in its _acquireClient). So for
  // the whole time we hold this client, nothing is listening — and a Client is an
  // EventEmitter, so an async server-side FATAL arriving with no listener is not logged, it
  // is thrown as an uncaught exception and the process dies.
  //
  // Arming idle_in_transaction_session_timeout below is exactly what makes such a FATAL
  // reachable (25P03, delivered out-of-band rather than as a query rejection), so the guard
  // and this listener have to ship together — the guard alone would trade a wedged connection
  // for a killed server instance. Verified against a real Postgres, not reasoned about: the
  // termination fires this event, and without a listener it takes the process down.
  //
  // `fatal` is also what tells release() to DESTROY the connection rather than return it to
  // the pool: pg-pool's release(err) discards on a truthy argument, and handing a terminated
  // backend to the next caller would just move the failure one request downstream.
  let fatal: Error | undefined;
  const onClientError = (err: Error): void => {
    fatal = err;
    // eslint-disable-next-line no-console
    console.error('[db] pooled connection died while held by a query:', err.message);
  };
  client.on('error', onClientError);

  try {
    // ONE round trip, and the idle bound is armed in the SAME statement that opens the
    // transaction — see IDLE_IN_TRANSACTION_TIMEOUT_MS for why that ordering is the fix and
    // not a micro-optimisation. Multi-statement simple query: safe here because there are no
    // bind parameters, and both values are clamped integers interpolated by us.
    await client.query(
      `BEGIN; SET LOCAL statement_timeout = ${ms}; ` +
        `SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS};`
    );
    const { rows } = await client.query<T>(text, params);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be unusable; the original error is the one worth raising.
    }
    // 57014 = query_canceled. Only OUR timeout can cancel inside this function, so attributing it
    // is safe here — and naming the limit is what stops a cancellation reading as an unrelated
    // database failure to whoever sees the 500.
    if ((err as { code?: unknown } | null)?.code === '57014') {
      throw new QueryTimeoutError(ms, err);
    }
    throw err;
  } finally {
    client.removeListener('error', onClientError);
    // Truthy argument => pg-pool destroys instead of re-pooling. See `fatal` above.
    client.release(fatal);
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
