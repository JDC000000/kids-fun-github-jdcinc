// worker/scheduler/global-jobs.ts — THE PRODUCER for global (source-less) scheduled jobs.
//
// Unit 1 shipped a CONSUMER WITH NO PRODUCER: worker/core/job-handlers.ts can dispatch a
// claimed job_type='corrections_retention' job, and worker/core/corrections-retention.ts
// runs the real purge, but nothing outside tests/ ever enqueued one. This is the missing
// half. It is the exact sibling of worker/scheduler/tiered.ts (the per-SOURCE producer):
// read what is due from durable config, enqueue into the SAME job_queue, stamp the next
// due instant forward.
//
// IT DOES NOT BUILD A SECOND QUEUE. The row it writes is an ordinary job_queue row with
// source_id NULL, claimed by the same dequeue() the ingest lane uses and dispatched by the
// same registry. Everything new lives in the SCHEDULE and the LEDGER (migration 0028).
//
// ── WHY THE LEDGER ROW IS WRITTEN BEFORE THE QUEUE ROW ───────────────────────────────
// Global jobs have no deduplication at all today. tiered.ts is idempotent because
// idx_job_queue_source_active is a PARTIAL index ON (source_id) and its `NOT EXISTS` check
// rides on it; source_id IS NULL for a global job, so that index does nothing for it and
// two ticks would each happily enqueue a purge. Checking job_queue first and inserting
// second would not fix it either — that is check-then-act, and the two ticks interleave
// between the check and the act.
//
// So the ledger insert IS the claim. `ON CONFLICT DO NOTHING` against two unique indexes —
// one unfinished run per schedule, one run per due slot — makes the DATABASE the arbiter:
// exactly one transaction gets a row back, and only that one goes on to enqueue. Losing is
// a normal, silent, correct outcome. Deleting either index (or the ON CONFLICT) is what
// tests/scheduler/global-jobs-db.test.ts's concurrency case is aimed at.
import type { Pool, PoolClient } from 'pg';
import { enqueue, resolveWorkerId } from '../core/queue';

/** One enqueued run, for the tick's log line and its metrics. */
export interface EnqueuedGlobalJob {
  jobType: string;
  scheduleId: string;
  /** The global_job_run row that holds the lock for this run. */
  runId: string;
  /** The job_queue row a worker will claim. */
  jobId: string;
  /** The due instant this run satisfies (the schedule's next_run_at when it was claimed). */
  scheduledFor: Date;
  /** Where next_run_at was advanced to. */
  nextRunAt: Date;
}

export interface EnqueueDueGlobalJobsOptions {
  /** Recorded as the ledger's enqueued_by. Defaults to this process's worker id. */
  workerId?: string;
}

/**
 * max_attempts on the job_queue rows this producer writes.
 *
 * ONE, deliberately, unlike the ingest lane's 5. A scheduled job already has a retry
 * policy — its cadence — and a failure policy — the circuit breaker. Letting the queue
 * ALSO retry it would (a) double-count nothing usefully, since the breaker counts RUNS,
 * and (b) resurrect a job after worker/core/reconcile.ts has already closed its ledger
 * run as abandoned, leaving an execution with no open ledger row to record its outcome.
 * One queue attempt per run keeps "one run = one ledger row = one breaker event" true.
 */
export const GLOBAL_JOB_MAX_ATTEMPTS = 1;

interface DueScheduleRow {
  id: string;
  job_type: string;
  next_run_at: Date;
}

/**
 * Enqueue every global schedule that is due, at most once each.
 *
 * THE STOP CONDITIONS ARE IN THE SQL PREDICATE, not in a JS filter afterwards, so there is
 * no window in which a disabled or broken schedule is a candidate:
 *   • `enabled`                                   — a disabled row enqueues NOTHING, ever.
 *     That flag is the only thing standing between a bug here and permanent deletion of
 *     user correction reports, which is why migration 0028 ships the retention schedule
 *     with it FALSE.
 *   • `breaker_tripped_at IS NULL`                — the breaker (P2).
 *   • `consecutive_failures < max_consecutive_failures` — the same stop condition read from
 *     its other half. Both are required, so clearing one by hand cannot silently re-arm a
 *     schedule; worker/core/global-job-schedule.ts's reader applies the identical pair.
 *
 * FOR UPDATE SKIP LOCKED keeps two ticks in the same instant from even considering the
 * same row. It is an optimisation, not the guarantee: the guarantee is the unique index
 * behind the ledger insert below, which still holds if this clause is deleted.
 */
export async function enqueueDueGlobalJobs(
  pool: Pool,
  opts: EnqueueDueGlobalJobsOptions = {}
): Promise<EnqueuedGlobalJob[]> {
  const workerId = opts.workerId ?? resolveWorkerId();
  const client: PoolClient = await pool.connect();
  const enqueued: EnqueuedGlobalJob[] = [];
  try {
    await client.query('BEGIN');

    const { rows: due } = await client.query<DueScheduleRow>(
      `SELECT id, job_type, next_run_at
         FROM global_job_schedule
        WHERE enabled
          AND breaker_tripped_at IS NULL
          AND consecutive_failures < max_consecutive_failures
          AND next_run_at <= now()
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED`
    );

    for (const schedule of due) {
      // THE CLAIM. One row back = this transaction owns the run; zero rows = another tick
      // owns it, or a previous run of this schedule is still unfinished and its lock has
      // not been released (by completion, or by reconcile if its worker died). Either way
      // we enqueue nothing and leave next_run_at alone, so the schedule stays due and the
      // next tick tries again — level-triggered, never a backlog.
      const { rows: claimed } = await client.query<{ id: string }>(
        `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by)
              VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
           RETURNING id`,
        [schedule.id, schedule.next_run_at, workerId]
      );
      if (claimed.length === 0) continue;
      const runId = claimed[0].id;

      const jobId = await enqueue(
        client,
        null,
        schedule.job_type,
        new Date(),
        GLOBAL_JOB_MAX_ATTEMPTS
      );
      await client.query(`UPDATE global_job_run SET job_id = $2 WHERE id = $1`, [runId, jobId]);

      // Advance by WHOLE cadence periods until strictly in the future. This preserves the
      // schedule's phase (a daily job stays on its hour) while SKIPPING the slots an
      // outage missed rather than replaying them: the purge is level-triggered — it
      // removes everything already past retained_until — so running it 30 times to "catch
      // up" 30 missed days would do 29 no-ops. The miss is not swept under the carpet by
      // skipping it; it stays visible in the ledger, derived at read time by
      // readGlobalJobScheduleHealth().
      const { rows: advanced } = await client.query<{ next_run_at: Date }>(
        `UPDATE global_job_schedule
            SET last_run_at = now(),
                next_run_at = next_run_at
                              + cadence * (
                                  floor(
                                    EXTRACT(EPOCH FROM (now() - next_run_at))
                                    / EXTRACT(EPOCH FROM cadence)
                                  ) + 1
                                )
          WHERE id = $1
        RETURNING next_run_at`,
        [schedule.id]
      );

      enqueued.push({
        jobType: schedule.job_type,
        scheduleId: schedule.id,
        runId,
        jobId,
        scheduledFor: schedule.next_run_at,
        nextRunAt: advanced[0].next_run_at,
      });
    }

    await client.query('COMMIT');
    return enqueued;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
