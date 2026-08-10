import type { Pool } from 'pg';
import { enqueueDueJobs } from '../scheduler/tiered';
import { enqueueDueGlobalJobs } from '../scheduler/global-jobs';
import { dequeue, markDone, markFailed, resolveWorkerId, type Job } from '../core/queue';
import { reconcileAbandonedRuns } from '../core/reconcile';
import {
  claimGlobalJobRun,
  finishGlobalJobRun,
  readGlobalJobScheduleHealth,
  type GlobalJobScheduleStatus,
} from '../core/global-job-schedule';
import { makeJobDispatcher } from '../core/job-handlers';
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
//      pending/running job) and it stamps next_check_at forward per source. The same
//      tick then calls enqueueDueGlobalJobs() for the source-LESS schedules
//      (global_job_schedule, migration 0028) — the producer for the job types Unit 1
//      taught the dispatcher to run. The two producers are independent by design: a
//      failure in either must not stop the other, so they have separate try/catch.
//      The tick then READS BACK the durable health of every global schedule
//      (readGlobalJobScheduleHealth) into the metrics /healthz serves, so a tripped
//      breaker or a run of missed slots is reported by ANY process that boots after it
//      happened — not only by the one that happened to witness it.
//   2. poll loop  — every WORKER_POLL_INTERVAL_MS claims one due job
//      (FOR UPDATE SKIP LOCKED) and runs the handler registered for its
//      job_queue.job_type (core/job-handlers.ts): 'ingest' → the terms-gated
//      per-source ingest; 'corrections_retention' → the global retention purge
//      (source_id IS NULL); anything else → a loud UnknownJobTypeError. Retry/
//      backoff + dead-lettering are handled by core/queue.
//
// This replaces the one-shot `ingest:once` entrypoint with a process that runs
// continuously; the same policy remains callable from pg_cron / Vercel Cron.

/**
 * One global schedule's health AS THE DATABASE HOLDS IT, projected for /healthz.
 *
 * Dates are ISO strings because this object is serialised straight into the health payload
 * (worker/src/healthz.ts) and a Date would arrive there as an unlabelled ISO string anyway;
 * making that explicit here keeps the wire shape a property of this type rather than an
 * accident of JSON.stringify.
 */
export interface GlobalScheduleHealthSnapshot {
  jobType: string;
  /** Derived by worker/core/global-job-schedule.ts from stored state alone. */
  status: GlobalJobScheduleStatus;
  enabled: boolean;
  /** Cadence slots that came due and produced NO ledger row. > 0 means work was lost. */
  missedRuns: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  /** Non-null = the breaker is OPEN and only an operator can close it. */
  breakerTrippedAt: string | null;
  breakerReason: string | null;
  nextRunAt: string;
  lastSuccessAt: string | null;
  inFlight: boolean;
}

export interface SchedulerMetrics {
  enabled: boolean;
  environment: Environment;
  schedulerTickMs: number;
  pollIntervalMs: number;
  ticks: number;
  lastTickAt: string | null;
  lastEnqueueCount: number;
  totalEnqueued: number;
  /** Global (source-less) scheduled runs enqueued on the last tick / since boot. */
  lastGlobalEnqueueCount: number;
  totalGlobalEnqueued: number;
  /**
   * Cadence slots the global producer JUMPED PAST without running, since boot. Non-zero
   * after any outage longer than one cadence. Harmless for a level-triggered job and
   * silent data loss for an edge-triggered one — see EnqueuedGlobalJob.skippedSlots.
   */
  totalGlobalSlotsSkipped: number;
  /**
   * Job types whose circuit breaker is OPEN, ACCORDING TO THE DATABASE.
   *
   * IT USED TO MEAN "that this process has seen trip", and that is why /healthz reported a
   * clean bill of health after every restart: the list was populated only by the statement
   * that tripped the breaker, so a process booting AFTER the trip started empty and stayed
   * empty while the compliance purge was stopped. A tripped breaker has no automatic
   * recovery by design, so the state routinely outlives the process that caused it — which
   * makes process memory the one place it must NOT be read from.
   *
   * It is now REPLACED wholesale by `globalSchedules` on every successful durable read (so
   * an operator's reset clears it), and only ADDED to in between by a trip this process
   * witnessed (so the escalation is not delayed until the next tick). A failing read leaves
   * the last known list standing rather than blanking it.
   */
  globalBreakersTripped: string[];
  /**
   * Every global schedule's durable health, refreshed at boot and on every tick.
   *
   * READ `globalScheduleHealthAt` BEFORE BELIEVING AN EMPTY ARRAY. Empty means "no
   * schedules" only if the read has succeeded at least once; before that it means UNKNOWN,
   * and an alert that treats unknown as healthy is the defect this field exists to fix.
   */
  globalSchedules: GlobalScheduleHealthSnapshot[];
  /** When the durable read above last SUCCEEDED. Null = never — see above. */
  globalScheduleHealthAt: string | null;
  /** Why the durable read last failed, or null if the last attempt succeeded. */
  globalScheduleHealthError: string | null;
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
    lastGlobalEnqueueCount: 0,
    totalGlobalEnqueued: 0,
    totalGlobalSlotsSkipped: 0,
    globalBreakersTripped: [],
    globalSchedules: [],
    globalScheduleHealthAt: null,
    globalScheduleHealthError: null,
    jobsProcessed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    lastJobAt: null,
    lastReconcileAt: null,
    totalReconciled: 0,
    lastError: null,
  };

  // Dispatch by job_queue.job_type. Until this existed the loop ran the terms-gated INGEST
  // handler for every claimed job regardless of type, so any global job (source_id=NULL,
  // e.g. job_type='corrections_retention') threw 'ingest job has no source_id', retried to
  // max_attempts and dead-lettered. See worker/core/job-handlers.ts.
  const dispatch = makeJobDispatcher(pool, environment);

  // Identifies this process in job_queue.locked_by and in the global-job run ledger. The
  // ledger's whole purpose includes recording WHICH worker held a run when it died, and
  // the previous hardcoded 'worker' could not answer that with more than one machine.
  const workerId = resolveWorkerId();

  /**
   * The status this process last REPORTED for each job type, so a schedule that is stopped
   * for a week produces one log line rather than one per tick. Purely a log-noise control —
   * /healthz always carries the current durable status regardless of what is in here.
   */
  const lastLoggedStatus = new Map<string, GlobalJobScheduleStatus>();

  /** Statuses worth a log line. 'due'/'running'/'ok'/'disabled' are ordinary operation. */
  const ALARMING: ReadonlySet<GlobalJobScheduleStatus> = new Set(['breaker_tripped', 'missed']);

  /**
   * Fold the DATABASE's view of every global schedule into the metrics /healthz serves.
   *
   * ── WHY THIS EXISTS (the whole of Unit 2b) ──────────────────────────────────────────────
   * readGlobalJobScheduleHealth() is a pure SELECT that can report 'breaker_tripped' and
   * 'missed' from durable state with the entire worker fleet dead. Until this call it had
   * ZERO runtime callers: the health state was produced and never consumed, the exact
   * inverse of Unit 1's consumer with no producer. Everything /healthz said about global
   * jobs came from `noteBreakerTrip`, which only fires on the statement that trips the
   * breaker — so ANY restart erased it and the worker reported a clean bill of health while
   * the correction-report purge was stopped indefinitely.
   *
   * A breaker never resets itself (by design), and three unlucky events trip it — scheduled
   * jobs get max_attempts=1 and Fly's 5s kill_timeout makes an abandoned run routine — so
   * "the state outlives the process that saw it" is the normal case here, not the exotic one.
   *
   * Never throws: a health read that took the tick down would trade the report for the work.
   */
  async function refreshGlobalScheduleHealth(): Promise<void> {
    try {
      const health = await readGlobalJobScheduleHealth(pool);
      metrics.globalSchedules = health.map((h) => ({
        jobType: h.jobType,
        status: h.status,
        enabled: h.enabled,
        missedRuns: h.missedRuns,
        consecutiveFailures: h.consecutiveFailures,
        maxConsecutiveFailures: h.maxConsecutiveFailures,
        breakerTrippedAt: h.breakerTrippedAt?.toISOString() ?? null,
        breakerReason: h.breakerReason,
        nextRunAt: h.nextRunAt.toISOString(),
        lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
        inFlight: h.inFlight,
      }));
      // REPLACED, not merged: the database is the authority, so an operator who ran
      // resetGlobalJobBreaker() sees the alarm clear without restarting the worker.
      metrics.globalBreakersTripped = health
        .filter((h) => h.status === 'breaker_tripped')
        .map((h) => h.jobType);
      metrics.globalScheduleHealthAt = new Date().toISOString();
      metrics.globalScheduleHealthError = null;

      for (const h of health) {
        if (lastLoggedStatus.get(h.jobType) === h.status) continue;
        lastLoggedStatus.set(h.jobType, h.status);
        if (!ALARMING.has(h.status)) continue;
        // The two statuses need DIFFERENT advice, and giving both the same is how an
        // operator ends up resetting a breaker that was never tripped and concluding the
        // tooling is lying to them.
        const remedy =
          h.status === 'breaker_tripped'
            ? `It will NOT be enqueued again until an operator clears it (resetGlobalJobBreaker).`
            : `The breaker is closed and the schedule is still armed — the next tick will ` +
              `enqueue one catch-up run; the other ${Math.max(0, h.missedRuns - 1)} slot(s) ` +
              `will never run. Find out why nothing was producing.`;
        // eslint-disable-next-line no-console
        console.error(
          `[scheduler] global job '${h.jobType}' is ${h.status.toUpperCase()} in the DATABASE: ` +
            `${h.missedRuns} missed slot(s), ${h.consecutiveFailures}/${h.maxConsecutiveFailures} ` +
            `consecutive failures, breaker ` +
            `${h.breakerTrippedAt ? `OPEN since ${h.breakerTrippedAt.toISOString()} (${h.breakerReason ?? 'no reason recorded'})` : 'closed'}. ` +
            `This state is durable and outlived whatever process caused it. ${remedy}`
        );
      }
    } catch (err) {
      // Do NOT blank globalSchedules/globalBreakersTripped here: a stale alarm is useful,
      // an alarm silently replaced by an empty list is the false green all over again.
      metrics.globalScheduleHealthError = errMsg(err);
      metrics.lastError = `global schedule health: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error('[scheduler] global schedule health read failed:', errMsg(err));
      await captureWorkerException(err, {
        tags: { component: 'scheduler', operation: 'global_schedule_health', environment },
      });
    }
  }

  /** Record and shout about a breaker trip exactly once — the escalation, not a stream. */
  function noteBreakerTrip(jobType: string, reason: string): void {
    if (!metrics.globalBreakersTripped.includes(jobType)) {
      metrics.globalBreakersTripped.push(jobType);
    }
    // eslint-disable-next-line no-console
    console.error(
      `[scheduler] CIRCUIT BREAKER OPEN for global job '${jobType}': ${reason}. ` +
        `It will NOT be enqueued again until an operator clears it ` +
        `(resetGlobalJobBreaker / see supabase/migrations/0028_global_job_schedule.sql).`
    );
  }

  /**
   * Close the run-ledger row this job carried, if it carried one.
   *
   * Never throws and never runs inside processOneJob's success/failure try: a ledger write
   * that failed AFTER markDone would otherwise fall into the catch and call markFailed on
   * an already-completed job, putting a finished purge back on the queue. A ledger row
   * left open here is recovered by the reconcile sweep, which is what it is for.
   */
  async function finalizeGlobalRun(
    job: Job,
    outcome: 'success' | 'failure',
    error: string | null
  ): Promise<void> {
    try {
      const applied = await finishGlobalJobRun(pool, job.id, outcome, error);
      if (!applied) return; // not a scheduled global run (e.g. an ordinary ingest job)
      if (applied.breakerTrippedNow) {
        noteBreakerTrip(
          applied.jobType,
          `${applied.consecutiveFailures} consecutive failures ` +
            `(limit ${applied.maxConsecutiveFailures}); last error: ${error ?? 'unknown'}`
        );
      }
    } catch (err) {
      metrics.lastError = `global run ledger: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error('[scheduler] global run ledger update failed:', errMsg(err));
    }
  }

  // H6 shutdown-ordering state.
  //   `inFlight`       — the jobs whose DB rows the shutdown path has to release.
  //   `busyOperations` — whether ANY scheduler operation is still in progress. This is what
  //                      gates pool.end().
  //
  // busyOperations deliberately counts the WHOLE operation, not just the instants a query is
  // on the wire: tracked(processOneJob) spans dequeue + the handler's entire live fetch +
  // markDone/markFailed. That breadth IS the fix. Narrowing it to "a query is executing right
  // now" would let pool.end() fire during the fetch — i.e. in the window between the check
  // run being opened and its result being written — which is precisely the original bug.
  //
  // The two are separate because they answer different questions: a tick mid-enqueueDueJobs
  // is busy but holds no job, so it must delay pool.end() without producing an abandon write.
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
    const job: Job | null = await dequeue(pool, workerId);
    if (!job) return false;
    metrics.jobsProcessed += 1;
    metrics.lastJobAt = new Date().toISOString();
    // Registered BEFORE the handler runs and cleared only after the job is finalised, so
    // the shutdown path's snapshot can never miss a job that is genuinely still held.
    inFlight.set(job.id, { jobId: job.id, sourceId: job.sourceId, claimedAt: new Date() });
    let outcome: 'success' | 'failure' = 'failure';
    let failure: string | null = null;
    try {
      // Stamps started_at/claimed_by on the run ledger IF this job carries one; matches
      // zero rows for an ingest job. Called unconditionally rather than branching on
      // `sourceId === null`, which is a guess about what "global" means.
      await claimGlobalJobRun(pool, job.id, workerId);
      await dispatch(job);
      await markDone(pool, job.id);
      outcome = 'success';
      metrics.jobsSucceeded += 1;
    } catch (err) {
      failure = errMsg(err);
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
      // In the finally so it runs on BOTH paths, and outside the try/catch above so a
      // ledger failure can never be mistaken for a job failure. See finalizeGlobalRun.
      await finalizeGlobalRun(job, outcome, failure);
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
      const g = r.globalJobRuns ?? { abandoned: 0, resolvedSuccessful: 0, breakersTripped: [] };
      const total =
        r.jobsRequeued + r.jobsDeadLettered + r.checkRunsFailed + g.abandoned + g.resolvedSuccessful;
      if (total > 0) {
        metrics.lastReconcileAt = new Date().toISOString();
        metrics.totalReconciled += total;
        // eslint-disable-next-line no-console
        console.warn(
          `[scheduler] reconciled abandoned rows: ${r.jobsRequeued} job(s) requeued, ` +
            `${r.jobsDeadLettered} dead-lettered, ${r.checkRunsFailed} check run(s) failed, ` +
            `${g.abandoned} scheduled run(s) released, ${g.resolvedSuccessful} closed as done`
        );
      }
      for (const jobType of g.breakersTripped) {
        noteBreakerTrip(jobType, 'a scheduled run was abandoned by a dying worker');
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
    await enqueueDueGlobalJobsOnce();
    // LAST, so it observes this tick's own writes rather than the state before them.
    await refreshGlobalScheduleHealth();
  }

  /**
   * The GLOBAL (source-less) producer, in its own try/catch.
   *
   * Separate from the tiered producer above on purpose: they read different tables and
   * fail for different reasons, and a fault in one lane silently stopping the other is
   * exactly the kind of coupled failure this project keeps finding. Runs AFTER
   * reconcileOnce() for the same reason the tiered producer does — the sweep is what
   * releases a run-ledger lock held by a dead worker, so a schedule stranded by a crash
   * becomes enqueueable again on this very tick rather than the next one.
   */
  async function enqueueDueGlobalJobsOnce(): Promise<void> {
    try {
      const { enqueued, skipped } = await enqueueDueGlobalJobs(pool, { workerId });
      metrics.lastGlobalEnqueueCount = enqueued.length;
      metrics.totalGlobalEnqueued += enqueued.length;
      // Both halves count: a slot jumped by a normal catch-up and a slot jumped while
      // un-wedging a rewound schedule are equally slots that came due and will never run.
      metrics.totalGlobalSlotsSkipped +=
        enqueued.reduce((n, g) => n + g.skippedSlots, 0) +
        skipped.reduce((n, s) => n + (s.skippedSlots ?? 0), 0);
      if (enqueued.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[scheduler] tick #${metrics.ticks} enqueued ${enqueued.length} global job(s): ` +
            enqueued
              .map((g) => `${g.jobType}@${g.scheduledFor.toISOString()}→job ${g.jobId}`)
              .join(', ')
        );
      }
      // The slots between the one being run and now. Never inferred from a gap in the
      // ledger by whoever reads it next — said out loud, at the moment they are dropped.
      for (const g of enqueued.filter((e) => e.skippedSlots > 0)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[scheduler] global job '${g.jobType}' SKIPPED ${g.skippedSlots} cadence slot(s) ` +
            `between ${g.scheduledFor.toISOString()} and ${g.nextRunAt.toISOString()} — ` +
            `one catch-up run was enqueued for the oldest, the rest will never run. ` +
            `Correct for a level-triggered job; DATA LOSS for an edge-triggered one.`
        );
      }
      for (const s of skipped) {
        if (s.reason === 'slot_already_served') {
          // eslint-disable-next-line no-console
          console.warn(
            `[scheduler] global job '${s.jobType}' was due at ` +
              `${s.scheduledFor.toISOString()}, which the ledger has ALREADY served — ` +
              `a rewound next_run_at (operator edit, restore or clock skew). Advanced to ` +
              `${s.nextRunAt?.toISOString() ?? 'UNCHANGED — investigate'} instead of ` +
              `retrying it forever.`
          );
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[scheduler] global job '${s.jobType}' is due at ` +
              `${s.scheduledFor.toISOString()} but a previous run is still in flight — ` +
              `left due, will be retried next tick.`
          );
        }
      }
    } catch (err) {
      metrics.lastError = `global tick: ${errMsg(err)}`;
      // eslint-disable-next-line no-console
      console.error('[scheduler] global job tick error:', errMsg(err));
      await captureWorkerException(err, {
        tags: { component: 'scheduler', operation: 'enqueue_global_tick', environment },
      });
    }
  }

  async function tickLoop(): Promise<void> {
    // THE DURABLE HEALTH READ IS NOT GATED ON `immediate`. `immediate` governs whether this
    // process ENQUEUES on boot — a write, and a policy decision. Reporting what the database
    // already says is a pure SELECT, and a restarted worker must not spend up to a full tick
    // interval (60s by default, and unbounded for a test/embedded scheduler that sets a long
    // one) claiming everything is fine before it has looked.
    if (immediate) await tracked(tickOnce);
    else await tracked(refreshGlobalScheduleHealth);
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
