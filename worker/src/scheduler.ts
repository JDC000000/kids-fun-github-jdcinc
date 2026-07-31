import type { Pool } from 'pg';
import { enqueueDueJobs } from '../scheduler/tiered';
import { dequeue, markDone, markFailed, type Job } from '../core/queue';
import { reconcileAbandonedRuns } from '../core/reconcile';
import { makeTermsGatedIngestJobHandler } from '../core/source-runner';
import type { Environment } from '../core/terms-gate';
import { captureWorkerException } from './sentry';

// worker/src/scheduler.ts — G-T5-3 runtime: the continuous, cadence-driven loop
// that turns the trigger-agnostic tiered policy into a long-running worker.
//
// Two cooperating loops share the durable Postgres job queue:
//   1. tick loop  — every WORKER_SCHEDULER_TICK_MS calls enqueueDueJobs(), which
//      asks the tiered policy (source.baseline_cadence / near_date_cadence — the
//      hot/warm/cold tiers live in DB config, not code) which sources are due and
//      enqueues an ingest job for each. Idempotent per tick (skips sources with a
//      pending/running job) and it stamps next_check_at forward per source.
//   2. poll loop  — every WORKER_POLL_INTERVAL_MS claims one due job
//      (FOR UPDATE SKIP LOCKED) and runs the terms-gated ingest for its source,
//      with retry/backoff + dead-lettering handled by core/queue.
//
// This replaces the one-shot `ingest:once` entrypoint with a process that runs
// continuously; the same policy remains callable from pg_cron / Vercel Cron.

export interface SchedulerMetrics {
  enabled: boolean;
  environment: Environment;
  schedulerTickMs: number;
  pollIntervalMs: number;
  ticks: number;
  lastTickAt: string | null;
  lastEnqueueCount: number;
  totalEnqueued: number;
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  lastJobAt: string | null;
  /** H4: last tick that actually reclaimed abandoned 'running' rows (null = never). */
  lastReconcileAt: string | null;
  /** H4: cumulative abandoned rows recovered (jobs + check runs) since boot. */
  totalReconciled: number;
  lastError: string | null;
}

export interface SchedulerOptions {
  environment?: Environment;
  schedulerTickMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Run one enqueue tick immediately on start (default true) so a fresh worker
   *  picks up already-due sources without waiting a full tick interval. */
  immediate?: boolean;
}

/**
 * A job this process has CLAIMED (job_queue.status='running') and not yet finalised.
 *
 * H6: exists so the shutdown path can tell the database the truth about what this process
 * was holding at the moment it was told to stop, WITHOUT waiting for the job itself — a
 * live ActiveNet fetch can legitimately run for minutes and the runtime's stop grace
 * period is 5 seconds, so "wait for the job" was never an option.
 */
export interface InFlightJob {
  jobId: string;
  sourceId: string | null;
  /** When this process claimed the job — the lower bound on the check-run row it owns. */
  claimedAt: Date;
}

/** How often quiesce() re-checks. Small enough to be invisible in a 3.5s shutdown budget. */
const QUIESCE_POLL_MS = 25;

export interface SchedulerHandle {
  metrics: SchedulerMetrics;
  /** Resolves once both loops have exited (after the abort signal fires). */
  done: Promise<void>;
  /** Jobs claimed and not yet finalised. Empty when the worker is idle (H6). */
  inFlightJobs: () => InFlightJob[];
  /**
   * Resolves true once NO scheduler operation is touching the pool (no tick mid-query, no
   * job mid-flight), or false if `timeoutMs` elapses first.
   *
   * This is the precondition for pool.end(): "nothing this process issued is still in
   * flight and expected to complete". Before H6 the pool was closed from inside
   * server.close()'s callback, which fires when the HTTP server has no open connections —
   * a condition with nothing whatsoever to do with whether a job was mid-fetch.
   */
  quiesce: (timeoutMs: number) => Promise<boolean>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveEnvironment(): Environment {
  const v = process.env.KIDS_FUN_INGEST_ENV ?? process.env.APP_ENV;
  return v === 'production' ? 'production' : 'staging';
}

/** Abort-aware sleep so a SIGTERM stops the loops promptly instead of after a
 *  full interval. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Start the cadence-driven worker. Returns immediately with a live metrics
 * object (surfaced on /healthz) and a `done` promise that resolves after the
 * abort signal stops both loops.
 */
export function startScheduler(pool: Pool, opts: SchedulerOptions = {}): SchedulerHandle {
  const environment = opts.environment ?? resolveEnvironment();
  const schedulerTickMs =
    opts.schedulerTickMs ?? Number(process.env.WORKER_SCHEDULER_TICK_MS ?? 60_000);
  const pollIntervalMs =
    opts.pollIntervalMs ?? Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5_000);
  const immediate = opts.immediate ?? true;
  const signal = opts.signal;

  const metrics: SchedulerMetrics = {
    enabled: true,
    environment,
    schedulerTickMs,
    pollIntervalMs,
    ticks: 0,
    lastTickAt: null,
    lastEnqueueCount: 0,
    totalEnqueued: 0,
    jobsProcessed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    lastJobAt: null,
    lastReconcileAt: null,
    totalReconciled: 0,
    lastError: null,
  };

  const baseHandler = makeTermsGatedIngestJobHandler(pool, environment);

  // H6 shutdown-ordering state. `inFlight` is what the shutdown path releases in the DB;
  // `busyOperations` is the broader "this process has a query outstanding" count, which is
  // what gates pool.end(). They are separate because they answer different questions: a
  // tick mid-enqueueDueJobs is busy but holds no job, and a job that is mid-`politeFetch`
  // holds a job but is not, at that instant, in a query.
  const inFlight = new Map<string, InFlightJob>();
  let busyOperations = 0;

  async function tracked<T>(op: () => Promise<T>): Promise<T> {
    busyOperations += 1;
    try {
      return await op();
    } finally {
      busyOperations -= 1;
    }
  }

  function quiesce(timeoutMs: number): Promise<boolean> {
    if (busyOperations === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const poll = setInterval(() => {
        if (busyOperations === 0) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() >= deadline) {
          clearInterval(poll);
          resolve(false);
        }
      }, QUIESCE_POLL_MS);
      poll.unref?.();
    });
  }

  // Claim + run one due job using the existing queue primitives (dequeue /
  // markDone / markFailed). Returns true when a job was processed so the loop can
  // immediately drain the next one. A *job* failure is marked/retried by the
  // queue and never escapes; only a *connectivity* failure (dequeue/markX itself
  // throwing) propagates to the loop, which records it and keeps the worker — and
  // therefore /healthz — alive instead of crashing the machine.
  async function processOneJob(): Promise<boolean> {
    const job: Job | null = await dequeue(pool);
    if (!job) return false;
    metrics.jobsProcessed += 1;
    metrics.lastJobAt = new Date().toISOString();
    // Registered BEFORE the handler runs and cleared only after the job is finalised, so
    // the shutdown path's snapshot can never miss a job that is genuinely still held.
    inFlight.set(job.id, { jobId: job.id, sourceId: job.sourceId, claimedAt: new Date() });
    try {
      await baseHandler(job);
      await markDone(pool, job.id);
      metrics.jobsSucceeded += 1;
    } catch (err) {
      metrics.jobsFailed += 1;
      metrics.lastError = `job ${job.id}: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error(`[scheduler] job ${job.id} failed:`, errMsg(err));
      await captureWorkerException(err, {
        tags: {
          component: 'scheduler',
          operation: 'process_job',
          job_type: job.jobType,
          environment,
        },
        extra: {
          jobId: job.id,
          sourceId: job.sourceId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        },
      });
      await markFailed(pool, job.id, errMsg(err));
    } finally {
      inFlight.delete(job.id);
    }
    return true;
  }

  async function queueLoop(): Promise<void> {
    while (!signal?.aborted) {
      let processed = false;
      try {
        processed = await tracked(processOneJob);
      } catch (err) {
        // dequeue / markDone / markFailed failed (e.g. DB unreachable). Record and
        // back off — never crash the process, so the health server survives.
        metrics.lastError = `poll: ${errMsg(err)}`;
        // eslint-disable-next-line no-console
        console.error('[scheduler] poll error:', errMsg(err));
        await captureWorkerException(err, {
          tags: { component: 'scheduler', operation: 'poll', environment },
        });
      }
      if (!processed) await sleep(pollIntervalMs, signal);
    }
  }

  // H4: recover rows a dead process left stuck in 'running' before deciding what is due.
  // Ordering matters — an abandoned job holds idx_job_queue_source_active, which makes
  // enqueueDueJobs() skip that source as "already in flight", so sweeping first is what
  // lets a source stranded by a crash become enqueueable again on this very tick.
  // Runs on the immediate boot tick as well, so a restart reconciles straight away.
  async function reconcileOnce(): Promise<void> {
    try {
      const r = await reconcileAbandonedRuns(pool);
      const total = r.jobsRequeued + r.jobsDeadLettered + r.checkRunsFailed;
      if (total > 0) {
        metrics.lastReconcileAt = new Date().toISOString();
        metrics.totalReconciled += total;
        // eslint-disable-next-line no-console
        console.warn(
          `[scheduler] reconciled abandoned rows: ${r.jobsRequeued} job(s) requeued, ` +
            `${r.jobsDeadLettered} dead-lettered, ${r.checkRunsFailed} check run(s) failed`
        );
      }
    } catch (err) {
      // Never let the sweep take the tick down — enqueueing is the more important job.
      metrics.lastError = `reconcile: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error('[scheduler] reconcile error:', errMsg(err));
      await captureWorkerException(err, {
        tags: { component: 'scheduler', operation: 'reconcile', environment },
      });
    }
  }

  async function tickOnce(): Promise<void> {
    await reconcileOnce();
    try {
      const due = await enqueueDueJobs(pool);
      metrics.ticks += 1;
      metrics.lastTickAt = new Date().toISOString();
      metrics.lastEnqueueCount = due.length;
      metrics.totalEnqueued += due.length;
      if (due.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[scheduler] tick #${metrics.ticks} enqueued ${due.length} due source(s): ` +
            due.map((d) => `${d.family}/${d.id}`).join(', ')
        );
      }
    } catch (err) {
      // A transient DB error must not kill the worker — log, record, keep ticking.
      metrics.lastError = `tick: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error('[scheduler] tick error:', errMsg(err));
      await captureWorkerException(err, {
        tags: { component: 'scheduler', operation: 'enqueue_tick', environment },
      });
    }
  }

  async function tickLoop(): Promise<void> {
    if (immediate) await tracked(tickOnce);
    while (!signal?.aborted) {
      await sleep(schedulerTickMs, signal);
      if (signal?.aborted) break;
      await tracked(tickOnce);
    }
  }

  const done = Promise.all([tickLoop(), queueLoop()]).then(() => undefined);

  // eslint-disable-next-line no-console
  console.log(
    `[scheduler] started env=${environment} tick=${schedulerTickMs}ms poll=${pollIntervalMs}ms immediate=${immediate}`
  );
  return { metrics, done, inFlightJobs: () => [...inFlight.values()], quiesce };
}
