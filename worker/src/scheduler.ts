import type { Pool } from 'pg';
import { enqueueDueJobs } from '../scheduler/tiered';
import { dequeue, markDone, markFailed, type Job } from '../core/queue';
import { makeTermsGatedIngestJobHandler } from '../core/source-runner';
import type { Environment } from '../core/terms-gate';

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

export interface SchedulerHandle {
  metrics: SchedulerMetrics;
  /** Resolves once both loops have exited (after the abort signal fires). */
  done: Promise<void>;
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
    lastError: null,
  };

  const baseHandler = makeTermsGatedIngestJobHandler(pool, environment);

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
    try {
      await baseHandler(job);
      await markDone(pool, job.id);
      metrics.jobsSucceeded += 1;
    } catch (err) {
      metrics.jobsFailed += 1;
      metrics.lastError = `job ${job.id}: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error(`[scheduler] job ${job.id} failed:`, errMsg(err));
      await markFailed(pool, job.id, errMsg(err));
    }
    return true;
  }

  async function queueLoop(): Promise<void> {
    while (!signal?.aborted) {
      let processed = false;
      try {
        processed = await processOneJob();
      } catch (err) {
        // dequeue / markDone / markFailed failed (e.g. DB unreachable). Record and
        // back off — never crash the process, so the health server survives.
        metrics.lastError = `poll: ${errMsg(err)}`;
        // eslint-disable-next-line no-console
        console.error('[scheduler] poll error:', errMsg(err));
      }
      if (!processed) await sleep(pollIntervalMs, signal);
    }
  }

  async function tickOnce(): Promise<void> {
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
    }
  }

  async function tickLoop(): Promise<void> {
    if (immediate) await tickOnce();
    while (!signal?.aborted) {
      await sleep(schedulerTickMs, signal);
      if (signal?.aborted) break;
      await tickOnce();
    }
  }

  const done = Promise.all([tickLoop(), queueLoop()]).then(() => undefined);

  // eslint-disable-next-line no-console
  console.log(
    `[scheduler] started env=${environment} tick=${schedulerTickMs}ms poll=${pollIntervalMs}ms immediate=${immediate}`
  );
  return { metrics, done };
}
