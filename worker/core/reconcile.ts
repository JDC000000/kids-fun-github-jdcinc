// worker/core/reconcile.ts — H4: recover rows abandoned mid-flight by a dead process.
//
// WHY THIS EXISTS. Both of the tables below are written in two steps — claim, then
// finalise — and nothing owned the case where the process died in between:
//
//   • job_queue        dequeue() sets status='running' + locked_at; markDone/markFailed
//                      finalise it. Neither runs if the worker is killed.
//   • source_check_run startCheckRun() inserts status='running'; finishCheckRun()
//                      resolves it. ingestSource() always reaches finishCheckRun on any
//                      code path — but not if the process is gone.
//
// This is the same missing-deadline failure the H4 fetch timeout fixes, one level up.
// The Vancouver ActiveNet hang of 2026-07-30 left exactly this residue: a `running`
// check-run and a `running` job, both frozen at the moment the machine was killed. A
// stuck 'running' job is worse than a failed one — idx_job_queue_source_active makes
// the tiered scheduler treat the source as already-in-flight, so it is never enqueued
// again and the source silently stops updating forever. It cannot self-heal, because
// the only code that would have finalised it no longer exists.
//
// Deliberately a SWEEP, not a heartbeat/lease system: a lease requires every long
// operation to remember to renew it, which is the same "an author has to remember"
// weakness that produced the original bug. A time threshold needs nothing remembered.
import type { Pool } from 'pg';

/**
 * How long a row may sit in 'running' before it is considered abandoned.
 *
 * 30 minutes is far above any legitimate run. With the H4 fetch deadline in place a
 * single request is bounded at ~38s worst case, and an adapter run makes a bounded
 * number of requests (the ActiveNet client carries a hard per-run request cap; every
 * other adapter issues one or two). It is also comfortably above the worker's 60s
 * scheduler tick, so a job claimed moments before a sweep is never at risk.
 *
 * The safety property that matters: reclaiming a job that is genuinely still running
 * would let a second worker double-run the source. The margin here — ~50x the expected
 * run time — is what buys that safety, which is why this is minutes and not seconds.
 */
export const ABANDONED_RUN_THRESHOLD_MS = 30 * 60_000;

export interface ReconcileResult {
  /** Abandoned jobs put back on the queue for another attempt. */
  jobsRequeued: number;
  /** Abandoned jobs that had already exhausted max_attempts — dead-lettered, not lost. */
  jobsDeadLettered: number;
  /** Abandoned check runs closed out as failed so the health board stops showing green. */
  checkRunsFailed: number;
}

export interface ReconcileOptions {
  /** Override the abandonment threshold (tests). */
  thresholdMs?: number;
}

const ABANDONED_JOB_ERROR =
  'abandoned: worker process died while this job was running (reclaimed by reconcileAbandonedRuns)';

const ABANDONED_CHECK_RUN_ERROR = {
  code: 'abandoned_run',
  detail:
    'worker process died while this check run was in progress; closed out by reconcileAbandonedRuns',
};

/**
 * Close out everything left 'running' by a process that is no longer alive.
 *
 * Idempotent and safe to call on every scheduler tick: with nothing abandoned both
 * statements match zero rows (each is an indexed lookup on a status the tables carry
 * very few of). Returns counts so the caller can log only when it actually did work.
 */
export async function reconcileAbandonedRuns(
  pool: Pool,
  opts: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const thresholdSeconds = (opts.thresholdMs ?? ABANDONED_RUN_THRESHOLD_MS) / 1000;

  // Jobs: mirror markFailed()'s retry/dead-letter policy exactly rather than inventing a
  // second one — an abandoned job is a failed attempt, and attempts was already
  // incremented by dequeue(), so a source that hangs every time still walks its normal
  // path to dead_letter instead of being retried forever.
  const jobs = await pool.query<{ status: string }>(
    `UPDATE job_queue
        SET status        = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
            last_error    = $2,
            locked_at     = NULL,
            locked_by     = NULL,
            scheduled_for = CASE WHEN attempts >= max_attempts THEN scheduled_for ELSE now() END
      WHERE status = 'running'
        AND locked_at IS NOT NULL
        AND locked_at < now() - make_interval(secs => $1)
      RETURNING status`,
    [thresholdSeconds, ABANDONED_JOB_ERROR]
  );

  // Check runs: 'failed' (never 'partial') — we genuinely do not know what, if anything,
  // the dead process wrote, and a run whose outcome is unknown must not read as success
  // on the T15 health board. duration_ms is clamped to int4 for a very old row.
  const checkRuns = await pool.query<{ id: string }>(
    `UPDATE source_check_run
        SET status      = 'failed',
            errors      = $2::jsonb,
            duration_ms = LEAST(2147483647, GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint))
      WHERE status = 'running'
        AND started_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [thresholdSeconds, JSON.stringify(ABANDONED_CHECK_RUN_ERROR)]
  );

  const rows = jobs.rows ?? [];
  return {
    jobsRequeued: rows.filter((r) => r.status === 'pending').length,
    jobsDeadLettered: rows.filter((r) => r.status === 'dead_letter').length,
    checkRunsFailed: (checkRuns.rows ?? []).length,
  };
}
