// tests/scheduler/shutdown.test.ts — H6 FIX B: the worker's shutdown ordering.
//
// THE INCIDENT THIS PINS (2026-07-31). Killing the first live ActiveNet run (by unsetting
// its feature flag, which restarts the Fly machine) produced a SECOND, more confusing
// failure than the one being investigated: the old shutdown path closed the pg pool from
// inside `server.close()`'s callback — i.e. gated on "the HTTP server has no open
// connections", which has nothing to do with whether a job is mid-flight — while the
// Vancouver fetch was still running. The job then died on "Cannot use a pool after calling
// end on the pool", and its `source_check_run` row sat at status='running' until the
// unrelated 30-minute reconciliation sweep.
//
// WHY THESE TESTS HAVE TEETH. Every assertion here fails if the fix is reverted:
//   • the FakePool below throws the REAL pg error text on any query issued after end(),
//     so "the pool was closed out from under the job" is observable, not inferred;
//   • the incident-replay test drives the ACTUAL scheduler (startScheduler) with a handler
//     that is still mid-"fetch" at shutdown time, which is precisely the state the old
//     code mishandled;
//   • the ordering assertions compare positions in one call log, so moving the DB work
//     back inside the server-close callback, or closing the pool before releasing the
//     rows, fails here and nowhere else.
//
// No database: the pool is a stub, so this file belongs in the fast `unit` lane and is
// deliberately NOT registered in DB_INTEGRATION_SUITES.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  /** Jobs dequeue() will hand out, in order. */
  queue: [] as Array<{ id: string; sourceId: string | null }>,
  /** What the terms-gated ingest handler does for a claimed job. */
  handler: null as null | ((job: { id: string; sourceId: string | null }) => Promise<void>),
}));

vi.mock('../../worker/core/queue', () => ({
  dequeue: vi.fn(async () => {
    const next = shared.queue.shift();
    if (!next) return null;
    return { id: next.id, sourceId: next.sourceId, jobType: 'ingest', attempts: 1, maxAttempts: 5 };
  }),
  markDone: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
}));

vi.mock('../../worker/core/source-runner', () => ({
  makeTermsGatedIngestJobHandler: vi.fn(() => async (job: { id: string; sourceId: string | null }) => {
    if (shared.handler) await shared.handler(job);
  }),
}));

vi.mock('../../worker/scheduler/tiered', () => ({ enqueueDueJobs: vi.fn(async () => []) }));

vi.mock('../../worker/core/reconcile', () => ({
  ABANDONED_RUN_THRESHOLD_MS: 30 * 60_000,
  reconcileAbandonedRuns: vi.fn(async () => ({ jobsRequeued: 0, jobsDeadLettered: 0, checkRunsFailed: 0 })),
}));

vi.mock('../../worker/src/sentry', () => ({ captureWorkerException: vi.fn(async () => true) }));

import { startScheduler, type InFlightJob } from '../../worker/src/scheduler';
import {
  abandonInFlightRuns,
  runShutdown,
  SHUTDOWN_BUDGET_MS,
  type ShutdownDeps,
} from '../../worker/src/shutdown';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

/** Short, stable name for each statement so ordering assertions stay readable. */
function tag(sql: string): string {
  const s = sql.replace(/\s+/g, ' ');
  if (/UPDATE job_queue.* locked_by = NULL/i.test(s)) return 'release-job';
  if (/UPDATE source_check_run.* source_id = ANY/i.test(s)) return 'close-check-run';
  if (/INSERT INTO source_check_run/i.test(s)) return 'start-check-run';
  if (/UPDATE source_check_run/i.test(s)) return 'finish-check-run';
  return 'other';
}

/**
 * A pg Pool stand-in that reproduces the ONE behaviour the incident turned on: once end()
 * has been called, any further query throws node-postgres' actual error text. That is what
 * makes "the pool was closed out from under an in-flight job" a hard failure here instead
 * of something a reader has to reason about.
 */
class FakePool {
  readonly calls: string[] = [];
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  ended = false;

  query = async (sql: string, params: unknown[] = []): Promise<{ rows: Array<{ id: string }> }> => {
    if (this.ended) {
      this.calls.push('query-after-end');
      throw new Error('Cannot use a pool after calling end on the pool');
    }
    this.calls.push(tag(sql));
    this.queries.push({ sql, params });
    return { rows: [{ id: 'row-1' }] };
  };

  end = async (): Promise<void> => {
    this.calls.push('end');
    this.ended = true;
  };

  find(name: string): { sql: string; params: unknown[] } | undefined {
    return this.queries.find((q) => tag(q.sql) === name);
  }
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function deps(pool: FakePool | null, over: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    pool: pool as never,
    abort: () => {},
    closeServer: async () => {},
    closeSentry: async () => true,
    inFlightJobs: () => [],
    quiesce: async () => true,
    budgetMs: 400,
    logger: silentLogger,
    ...over,
  };
}

function inFlight(over: Partial<InFlightJob> = {}): InFlightJob {
  return { jobId: JOB_ID, sourceId: SOURCE_ID, claimedAt: new Date('2026-07-31T10:00:00Z'), ...over };
}

beforeEach(() => {
  shared.queue.length = 0;
  shared.handler = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the ordering guarantee ───────────────────────────────────────────────────────────

describe('H6 FIX B — pool.end() never races a query this process issued', () => {
  it('SKIPS pool.end() while a job is still in flight (the incident, prevented)', async () => {
    const pool = new FakePool();
    const outcome = await runShutdown(
      deps(pool, { inFlightJobs: () => [inFlight()], quiesce: async () => false })
    );

    // Reverting to the old `server.close(() => pool.end())` shape fails HERE: that path
    // closed the pool regardless of what the scheduler was doing.
    expect(pool.ended, 'pool must stay open while a job can still write').toBe(false);
    expect(pool.calls).not.toContain('end');
    expect(outcome.poolClosed).toBe(false);
    expect(outcome.jobsStillInFlight).toBe(1);
  });

  it('DOES close the pool when the worker is idle — the fix is not "never close it"', async () => {
    const pool = new FakePool();
    const outcome = await runShutdown(deps(pool));
    expect(pool.ended).toBe(true);
    expect(outcome.poolClosed).toBe(true);
  });

  it('releases the in-flight rows BEFORE the pool is closed', async () => {
    const pool = new FakePool();
    // The job finishes during the grace window, so the pool legitimately closes: the point
    // is the ORDER of the two, not whether the close happens.
    await runShutdown(deps(pool, { inFlightJobs: () => [inFlight()], quiesce: async () => true }));

    const released = pool.calls.indexOf('release-job');
    const closedRun = pool.calls.indexOf('close-check-run');
    const ended = pool.calls.indexOf('end');
    expect(released).toBeGreaterThanOrEqual(0);
    expect(closedRun).toBeGreaterThanOrEqual(0);
    expect(ended).toBeGreaterThan(closedRun);
    expect(ended).toBeGreaterThan(released);
    expect(pool.calls).not.toContain('query-after-end');
  });

  it('does not gate the database work on the HTTP server closing', async () => {
    // THE STRUCTURAL BUG: pool.end() used to live inside server.close()'s callback, which
    // fires on "no open connections" — the runtime's own /healthz keep-alive can hold that
    // open indefinitely. A closeServer that never resolves must not stop the rows being
    // released.
    const pool = new FakePool();
    const outcome = await runShutdown(
      deps(pool, {
        closeServer: () => new Promise<void>(() => {}), // never resolves
        inFlightJobs: () => [inFlight()],
        quiesce: async () => false,
        budgetMs: 600,
      })
    );
    expect(outcome.abandonedJobs).toBe(1);
    expect(outcome.abandonedCheckRuns).toBe(1);
  });

  it('aborts the scheduler FIRST, so nothing new is claimed while it shuts down', async () => {
    const order: string[] = [];
    const pool = new FakePool();
    await runShutdown(
      deps(pool, {
        abort: () => order.push('abort'),
        closeServer: async () => {
          order.push('closeServer');
        },
        inFlightJobs: () => {
          order.push('snapshot');
          return [];
        },
      })
    );
    // (inFlightJobs is consulted again after quiesce, to report what was left behind.)
    expect(order.slice(0, 3)).toEqual(['abort', 'closeServer', 'snapshot']);
  });
});

// ── what lands in the database ───────────────────────────────────────────────────────

describe('H6 FIX B — the check-run row is closed out promptly, not in 30 minutes', () => {
  it('marks the in-flight check run failed instead of leaving it at running', async () => {
    const pool = new FakePool();
    const result = await abandonInFlightRuns(pool as never, [inFlight()]);

    const closed = pool.find('close-check-run');
    expect(closed, 'the check-run row must be closed out').toBeDefined();
    // 'failed' is the only terminal value source_check_run's CHECK constraint allows for
    // an unknown outcome (running/success/partial/failed) — an "aborted" status would be
    // rejected by the database.
    expect(closed!.sql).toMatch(/status\s*=\s*'failed'/);
    expect(closed!.sql).toMatch(/WHERE status = 'running'/);
    expect(result.checkRuns).toBe(1);
  });

  it('scopes the check-run write to THIS process: its own sources, at or after its claim', async () => {
    // Without the started_at lower bound this would also swallow rows stranded by an
    // EARLIER crash and mislabel them as "shut down cleanly" — those belong to the
    // 30-minute reconciliation sweep, which is a different question with a different answer.
    const pool = new FakePool();
    const claimedAt = new Date('2026-07-31T10:00:00Z');
    await abandonInFlightRuns(pool as never, [inFlight({ claimedAt })]);

    const closed = pool.find('close-check-run')!;
    expect(closed.params[0]).toEqual([SOURCE_ID]);
    expect(closed.params[1]).toEqual(claimedAt);
    expect(closed.sql).toMatch(/started_at >= \$2/);
  });

  it('releases the job row with the same retry/dead-letter policy as markFailed', async () => {
    const pool = new FakePool();
    const result = await abandonInFlightRuns(pool as never, [inFlight()]);

    const released = pool.find('release-job')!;
    expect(released.params[0]).toEqual([JOB_ID]);
    // Requeue while attempts remain, dead-letter once exhausted — a source that is killed
    // every time must not be retried forever.
    expect(released.sql).toMatch(/attempts >= max_attempts THEN 'dead_letter' ELSE 'pending'/);
    expect(released.sql).toMatch(/status = 'running'/);
    expect(result.jobs).toBe(1);
  });

  it('touches nothing when the worker holds no jobs', async () => {
    const pool = new FakePool();
    const result = await abandonInFlightRuns(pool as never, []);
    expect(pool.queries).toHaveLength(0);
    expect(result).toEqual({ jobs: 0, checkRuns: 0 });
  });

  it('skips the check-run write for a job with no source (nothing to scope it to)', async () => {
    const pool = new FakePool();
    const result = await abandonInFlightRuns(pool as never, [inFlight({ sourceId: null })]);
    expect(pool.find('close-check-run')).toBeUndefined();
    expect(result).toEqual({ jobs: 1, checkRuns: 0 });
  });
});

// ── the budget ───────────────────────────────────────────────────────────────────────

describe('H6 FIX B — the sequence is budgeted, because the grace period is 5 seconds', () => {
  it('the default budget stays inside Fly’s stop grace period', () => {
    // Neither worker/fly.toml nor fly.production.toml sets kill_timeout, and Fly's default
    // is 5s before SIGKILL. A budget at or above that is a budget that never applies.
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(5_000);
  });

  it('returns within its budget even when nothing it waits on ever settles', async () => {
    const pool = new FakePool();
    const startedAt = Date.now();
    const outcome = await runShutdown(
      deps(pool, {
        closeServer: () => new Promise<void>(() => {}),
        closeSentry: () => new Promise<never>(() => {}),
        inFlightJobs: () => [inFlight()],
        quiesce: async () => false,
        budgetMs: 500,
      })
    );
    // A live ActiveNet fetch can run for minutes; waiting for it was never an option.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(outcome.abandonedJobs).toBe(1);
  });

  it('a failing release still lets the shutdown finish (and reports the failure)', async () => {
    const pool = new FakePool();
    pool.query = async () => {
      throw new Error('db unreachable');
    };
    const outcome = await runShutdown(deps(pool, { inFlightJobs: () => [inFlight()] }));
    expect(outcome.errors.join(' ')).toMatch(/db unreachable/);
    expect(outcome.abandonedJobs).toBe(0);
  });

  it('is a no-op on the database in health-only mode (no pool)', async () => {
    const outcome = await runShutdown(deps(null, { inFlightJobs: () => [inFlight()] }));
    expect(outcome).toMatchObject({ abandonedJobs: 0, abandonedCheckRuns: 0, poolClosed: false });
  });
});

// ── end to end against the real scheduler ────────────────────────────────────────────

describe('H6 FIX B — incident replay against the real scheduler', () => {
  it('a shutdown mid-fetch: no pool-after-end error, no orphaned running row', async () => {
    const pool = new FakePool();
    let releaseFetch: () => void = () => {};
    const fetchFinished = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    // Stands in for ingestSource(): open the check run, do a long live fetch, then write
    // the result. The write is the exact call that hit the closed pool in production.
    shared.handler = async () => {
      await pool.query(`INSERT INTO source_check_run (source_id, started_at, status) VALUES ($1,$2,'running')`, []);
      await fetchFinished;
      await pool.query(`UPDATE source_check_run SET status = $2 WHERE id = $1`, []);
    };
    shared.queue.push({ id: JOB_ID, sourceId: SOURCE_ID });

    const controller = new AbortController();
    const handle = startScheduler(pool as never, {
      signal: controller.signal,
      immediate: false,
      schedulerTickMs: 600_000,
      pollIntervalMs: 5,
      environment: 'staging',
    });

    try {
      await vi.waitFor(() => expect(handle.inFlightJobs()).toHaveLength(1), { timeout: 5_000 });
      expect(handle.inFlightJobs()[0]).toMatchObject({ jobId: JOB_ID, sourceId: SOURCE_ID });

      const outcome = await runShutdown(
        deps(pool, {
          abort: () => controller.abort(),
          inFlightJobs: handle.inFlightJobs,
          quiesce: handle.quiesce,
          budgetMs: 300,
        })
      );

      // The rows reflect reality inside the grace window, not 30 minutes later.
      expect(outcome.abandonedJobs).toBe(1);
      expect(outcome.abandonedCheckRuns).toBe(1);
      // And the pool the job is still using was NOT taken away from it.
      expect(pool.ended).toBe(false);

      // Now let the "fetch" finish, as it would have in production a few minutes later.
      releaseFetch();
      await handle.done;
      // THE SECONDARY ERROR THAT BURIED THE REAL ONE. Present before the fix.
      expect(pool.calls, 'no query may hit a closed pool').not.toContain('query-after-end');
      expect(pool.calls).toContain('finish-check-run');
    } finally {
      releaseFetch();
      controller.abort();
      await handle.done;
    }
  });

  it('quiesce() reports busy while a job runs and idle once it is finalised', async () => {
    const pool = new FakePool();
    let releaseFetch: () => void = () => {};
    const fetchFinished = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    shared.handler = async () => {
      await fetchFinished;
    };
    shared.queue.push({ id: JOB_ID, sourceId: SOURCE_ID });

    const controller = new AbortController();
    const handle = startScheduler(pool as never, {
      signal: controller.signal,
      immediate: false,
      schedulerTickMs: 600_000,
      pollIntervalMs: 5,
      environment: 'staging',
    });

    try {
      await vi.waitFor(() => expect(handle.inFlightJobs()).toHaveLength(1), { timeout: 5_000 });
      // Busy: this is what makes the shutdown path skip pool.end().
      expect(await handle.quiesce(100)).toBe(false);

      controller.abort();
      releaseFetch();
      await handle.done;

      expect(handle.inFlightJobs()).toEqual([]);
      expect(await handle.quiesce(500)).toBe(true);
    } finally {
      releaseFetch();
      controller.abort();
      await handle.done;
    }
  });
});
