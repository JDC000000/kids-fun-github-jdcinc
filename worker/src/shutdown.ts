// worker/src/shutdown.ts — H6: ordered, budgeted graceful shutdown for the worker.
//
// ── THE BUG THIS FIXES, observed 2026-07-31 ─────────────────────────────────────────
// The first live ActiveNet run was aborted by unsetting its feature-flag env var, which
// restarts the Fly machine. The old shutdown path was:
//
//     abort.abort();
//     server.close(() => { pool.end().then(closeSentry).finally(exit) });
//     setTimeout(exit, 8000).unref();
//
// Three independent things were wrong with it:
//
//  1. `pool.end()` was gated on `server.close()`'s callback, which fires when the HTTP
//     server has no open connections. That has NOTHING to do with whether a job is
//     mid-flight. The in-flight Vancouver fetch was still running when the pool closed,
//     so when it finally tried to write its result it died on "Cannot use a pool after
//     calling end on the pool" — a confusing secondary error that buried the real one.
//
//  2. `abort.abort()` does not stop a job that has already started. The signal is only
//     consulted by queueLoop()'s `while (!signal?.aborted)` and by its abort-aware
//     sleep(); it is never forwarded into `processOneJob()`/`adapter.fetch()`. So a live
//     fetch keeps running regardless, and nothing ever waits for it or reacts to it.
//
//  3. Nothing told the database what had happened. The job's `source_check_run` row stayed
//     at status='running' until the unrelated 30-minute reconciliation sweep
//     (worker/core/reconcile.ts) eventually closed it out.
//
// ── THE CONSTRAINT THIS IS DESIGNED WITHIN ──────────────────────────────────────────
// You cannot wait for the in-flight job. A live ActiveNet run is legitimately minutes
// long (see worker/adapters/activenet/client.ts's H6 note), and Fly's stop grace period is
// FIVE SECONDS: neither worker/fly.toml nor worker/fly.production.toml sets `kill_timeout`,
// and Fly's documented default is 5s (default kill_signal SIGINT) before SIGKILL. The old
// 8-second hard-exit net was therefore unreachable on Fly — the machine was always killed
// first. Everything here is budgeted to finish inside that window with margin.
//
// ── WHAT IT DOES INSTEAD ────────────────────────────────────────────────────────────
//   1. abort — stop claiming new work, wake any pending sleep.
//   2. close the health server (bounded, and no longer what gates anything below).
//   3. tell the DATABASE the truth about the jobs this process is still holding, without
//      waiting on the jobs themselves. Bounded, and it happens BEFORE anything closes the
//      pool, so the rows are released within the grace window rather than in 30 minutes.
//   4. close the pool ONLY once the scheduler reports it has no query outstanding. If a
//      job is still mid-flight we deliberately SKIP pool.end(): the sockets are released
//      by process exit a moment later anyway, and closing the pool underneath a live query
//      is precisely the bug above. Skipping is strictly safer than closing.
//   5. flush Sentry, then let the caller exit.
//
// Every dependency is injected so the whole sequence is unit-testable without binding a
// port, registering process signal handlers, or calling process.exit — which is why this
// lives here rather than inline in src/index.ts (that module runs side effects on import).
import type { Pool } from 'pg';
import type { InFlightJob } from './scheduler';

export type { InFlightJob };

/**
 * Total wall-clock budget for the whole sequence. MUST stay under the runtime's stop grace
 * period (Fly default `kill_timeout` = 5s, unset in both fly.toml files), with enough
 * margin for the caller's own exit. 3.5s is ~2x the worst realistic cost of the two
 * indexed UPDATEs below plus a Sentry flush.
 */
export const SHUTDOWN_BUDGET_MS = 3_500;

/** Draining the health server. It is closed WITH its connections, so this bounds
 *  pathology (a wedged socket), not normal operation. */
export const SERVER_CLOSE_BUDGET_MS = 750;

/** The abandon writes: two UPDATEs, one by primary key, one by (source_id, started_at). */
export const DB_WRITE_BUDGET_MS = 1_500;

/** Sentry's final flush. Reserved out of the budget so it is never starved by the above. */
export const SENTRY_CLOSE_BUDGET_MS = 500;

const LOG = '[worker] shutdown:';

const ABANDONED_JOB_ERROR =
  'abandoned: worker shut down while this job was running (released by the shutdown handler)';

const ABANDONED_CHECK_RUN_ERROR = {
  code: 'shutdown_abandoned_run',
  detail: 'worker shut down while this check run was in progress; closed out by the shutdown handler',
};

export interface ShutdownDeps {
  /** Null in health-only mode (no DATABASE_URL). */
  pool: Pool | null;
  /** Trip the scheduler's AbortController. */
  abort: () => void;
  /** Close the HTTP listener AND its open connections. */
  closeServer: () => Promise<void>;
  /** Flush + close Sentry. */
  closeSentry: () => Promise<unknown>;
  /** Jobs the scheduler has claimed and not yet finalised. */
  inFlightJobs: () => InFlightJob[];
  /** Resolves true once the scheduler has no query outstanding. */
  quiesce: (timeoutMs: number) => Promise<boolean>;
  budgetMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface ShutdownOutcome {
  /** job_queue rows this process released (requeued or dead-lettered). */
  abandonedJobs: number;
  /** source_check_run rows closed out as failed instead of being left 'running'. */
  abandonedCheckRuns: number;
  /** Jobs still mid-flight when the budget ran out — the reason pool.end() was skipped. */
  jobsStillInFlight: number;
  poolClosed: boolean;
  elapsedMs: number;
  errors: string[];
}

type Settled<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: unknown }
  | { status: 'timeout' };

/** Await `work`, but never longer than `ms`, and never reject. A shutdown step that hangs
 *  must cost its own slice of the budget and nothing more. */
function settleWithin<T>(work: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, ms));
    timer.unref?.();
  });
  const settled = work.then(
    (value): Settled<T> => ({ status: 'ok', value }),
    (error): Settled<T> => ({ status: 'error', error })
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Release the DB rows this process is holding, WITHOUT waiting for the jobs themselves.
 *
 * Scoping is deliberately narrow on both statements, so this can only ever touch rows this
 * process actually owns:
 *   • jobs — by primary key, and only while still 'running'.
 *   • check runs — by the in-flight jobs' source ids AND `started_at >= claimedAt`. A run
 *     is created after its job is claimed, so that lower bound admits this process's own
 *     row and excludes any older row stranded by a previous crash (those belong to
 *     reconcileAbandonedRuns' 30-minute sweep, which is a different question).
 *
 * The job policy mirrors markFailed()/reconcileAbandonedRuns() exactly — attempts was
 * already incremented by dequeue(), so a source killed every time still walks its normal
 * path to dead_letter rather than being retried forever. Status 'failed' (not a new value)
 * because source_check_run's CHECK constraint allows only running/success/partial/failed.
 */
export async function abandonInFlightRuns(
  pool: Pool,
  jobs: InFlightJob[]
): Promise<{ jobs: number; checkRuns: number }> {
  if (jobs.length === 0) return { jobs: 0, checkRuns: 0 };

  const released = await pool.query<{ id: string }>(
    `UPDATE job_queue
        SET status        = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
            last_error    = $2,
            locked_at     = NULL,
            locked_by     = NULL,
            scheduled_for = CASE WHEN attempts >= max_attempts THEN scheduled_for ELSE now() END
      WHERE id = ANY($1::uuid[])
        AND status = 'running'
      RETURNING id`,
    [jobs.map((j) => j.jobId), ABANDONED_JOB_ERROR]
  );

  const withSource = jobs.filter((j) => j.sourceId != null);
  let checkRuns = 0;
  if (withSource.length > 0) {
    const sourceIds = [...new Set(withSource.map((j) => j.sourceId as string))];
    const earliestClaim = new Date(Math.min(...withSource.map((j) => j.claimedAt.getTime())));
    const closed = await pool.query<{ id: string }>(
      `UPDATE source_check_run
          SET status      = 'failed',
              errors      = $3::jsonb,
              duration_ms = LEAST(2147483647, GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint))
        WHERE status = 'running'
          AND source_id = ANY($1::uuid[])
          AND started_at >= $2
        RETURNING id`,
      [sourceIds, earliestClaim, JSON.stringify(ABANDONED_CHECK_RUN_ERROR)]
    );
    checkRuns = (closed.rows ?? []).length;
  }

  return { jobs: (released.rows ?? []).length, checkRuns };
}

/**
 * Run the ordered shutdown sequence. Never rejects and never exits the process — the
 * caller owns process.exit so this stays testable.
 */
export async function runShutdown(deps: ShutdownDeps): Promise<ShutdownOutcome> {
  const log = deps.logger ?? console;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? SHUTDOWN_BUDGET_MS;
  const startedAt = now();
  const remaining = (): number => Math.max(0, budgetMs - (now() - startedAt));
  const errors: string[] = [];

  // 1. Stop claiming new work. Any pending poll/tick sleep wakes immediately.
  deps.abort();

  // 2. Drain the health server. Bounded, and — unlike before — NOT what gates the pool.
  const server = await settleWithin(deps.closeServer(), Math.min(SERVER_CLOSE_BUDGET_MS, remaining()));
  if (server.status === 'timeout') {
    log.warn(`${LOG} health server did not close within ${SERVER_CLOSE_BUDGET_MS}ms — continuing`);
  } else if (server.status === 'error') {
    errors.push(`closeServer: ${errMsg(server.error)}`);
    log.warn(`${LOG} health server close failed: ${errMsg(server.error)}`);
  }

  // 3. Tell the database what this process is holding, BEFORE anything closes the pool.
  //    A job that outlives the grace window (the normal case for a live fetch) therefore
  //    leaves a `failed` check run behind instead of a row stuck at 'running' for 30
  //    minutes. If the job does manage to finish inside the window, its own
  //    finishCheckRun()/markDone() writes the truthful outcome over this one — later write
  //    wins, and the later write is the better-informed one.
  const inFlight = deps.inFlightJobs();
  let abandonedJobs = 0;
  let abandonedCheckRuns = 0;
  if (deps.pool && inFlight.length > 0) {
    log.warn(
      `${LOG} ${inFlight.length} job(s) still in flight (${inFlight
        .map((j) => j.jobId)
        .join(', ')}) — releasing their queue/check-run rows`
    );
    const released = await settleWithin(
      abandonInFlightRuns(deps.pool, inFlight),
      Math.min(DB_WRITE_BUDGET_MS, remaining())
    );
    if (released.status === 'ok') {
      abandonedJobs = released.value.jobs;
      abandonedCheckRuns = released.value.checkRuns;
    } else if (released.status === 'timeout') {
      errors.push('abandonInFlightRuns: timed out');
      log.warn(`${LOG} releasing in-flight rows timed out — the 30-minute sweep will finish the job`);
    } else {
      errors.push(`abandonInFlightRuns: ${errMsg(released.error)}`);
      log.error(`${LOG} releasing in-flight rows failed: ${errMsg(released.error)}`);
    }
  }

  // 4. THE ORDERING GUARANTEE: never call pool.end() while a query this process issued is
  //    still in flight and expected to complete. quiesce() is that question, asked of the
  //    component that actually knows the answer.
  const idle = await deps.quiesce(Math.max(0, remaining() - SENTRY_CLOSE_BUDGET_MS));
  const stillInFlight = deps.inFlightJobs().length;
  let poolClosed = false;
  if (deps.pool && idle) {
    const ended = await settleWithin(
      Promise.resolve(deps.pool.end()),
      Math.max(0, remaining() - SENTRY_CLOSE_BUDGET_MS)
    );
    poolClosed = ended.status === 'ok';
    if (ended.status === 'error') {
      errors.push(`pool.end: ${errMsg(ended.error)}`);
      log.warn(`${LOG} pool.end() failed: ${errMsg(ended.error)}`);
    } else if (ended.status === 'timeout') {
      errors.push('pool.end: timed out');
      log.warn(`${LOG} pool.end() did not settle in time — exiting anyway`);
    }
  } else if (deps.pool) {
    // Not a failure — the designed outcome for a slow live fetch. Closing here is what
    // produced the original "Cannot use a pool after calling end on the pool"; the sockets
    // are torn down by process exit a moment from now regardless.
    log.warn(
      `${LOG} scheduler still busy (${stillInFlight} job(s) in flight) — SKIPPING pool.end() so the ` +
        'in-flight job cannot fail on a closed pool; process exit releases the sockets'
    );
  }

  // 5. Last: flush Sentry, so anything logged above still ships.
  const sentry = await settleWithin(
    Promise.resolve(deps.closeSentry()),
    Math.max(100, Math.min(SENTRY_CLOSE_BUDGET_MS, remaining()))
  );
  if (sentry.status === 'error') errors.push(`closeSentry: ${errMsg(sentry.error)}`);

  const elapsedMs = now() - startedAt;
  log.log(
    `${LOG} done in ${elapsedMs}ms — ${abandonedJobs} job(s) released, ` +
      `${abandonedCheckRuns} check run(s) closed, pool ${poolClosed ? 'closed' : 'left open'}, ` +
      `${errors.length} error(s)`
  );

  return {
    abandonedJobs,
    abandonedCheckRuns,
    jobsStillInFlight: stillInFlight,
    poolClosed,
    elapsedMs,
    errors,
  };
}
