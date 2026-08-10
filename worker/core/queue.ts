// worker/core/queue.ts — G-T5-2: Postgres job-queue + worker poll loop.
// Durable enqueue/dequeue with retry/backoff (SELECT ... FOR UPDATE SKIP
// LOCKED keeps multiple worker processes from double-claiming a job).
import type { Pool, PoolClient } from 'pg';

/** Pool, or a client inside a transaction. The global-job producer claims its ledger row
 *  and enqueues the job it carries in ONE transaction, so its enqueue arrives on a client. */
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface Job {
  id: string;
  sourceId: string | null;
  jobType: string;
  attempts: number;
  maxAttempts: number;
}

/**
 * Identify THIS worker process in job_queue.locked_by and in the global-job run ledger's
 * enqueued_by/claimed_by.
 *
 * "worker" — the previous hardcoded value — is useless the moment there is more than one
 * machine, and the run ledger's whole job is to record WHICH worker held a run when it
 * died. Fly exposes FLY_MACHINE_ID; WORKER_ID is the manual override; HOSTNAME is the
 * container id under plain Docker. The old literal remains the last resort so nothing
 * depends on any of them being set.
 */
export function resolveWorkerId(): string {
  const candidates = [
    process.env.WORKER_ID,
    process.env.FLY_MACHINE_ID,
    process.env.HOSTNAME,
  ];
  for (const c of candidates) {
    if (c && c.trim() !== '') return c.trim();
  }
  return 'worker';
}

/**
 * Insert a job.
 *
 * `maxAttempts` is normally left unset so the column DEFAULT (0011: 5) applies. The global
 * SCHEDULE producer passes 1 deliberately — retry policy for a scheduled job belongs to its
 * cadence + circuit breaker, not to the queue's blind backoff, and a queue-level retry
 * would resurrect a job whose ledger run the reconcile sweep has already closed. See
 * worker/scheduler/global-jobs.ts.
 */
export async function enqueue(
  db: Queryable,
  sourceId: string | null,
  jobType = 'ingest',
  scheduledFor: Date = new Date(),
  maxAttempts?: number
): Promise<string> {
  // Two spellings rather than `COALESCE($4, 5)`: hardcoding the default here would let it
  // drift from the column's, silently, the day the column changes.
  const { rows } =
    maxAttempts === undefined
      ? await db.query<{ id: string }>(
          `INSERT INTO job_queue (source_id, job_type, scheduled_for) VALUES ($1, $2, $3) RETURNING id`,
          [sourceId, jobType, scheduledFor]
        )
      : await db.query<{ id: string }>(
          `INSERT INTO job_queue (source_id, job_type, scheduled_for, max_attempts)
             VALUES ($1, $2, $3, $4) RETURNING id`,
          [sourceId, jobType, scheduledFor, maxAttempts]
        );
  return rows[0].id;
}

/** Atomically claim one due, pending job. Returns null if nothing is due. */
export async function dequeue(pool: Pool, workerId = 'worker'): Promise<Job | null> {
  const { rows } = await pool.query(
    `UPDATE job_queue SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM job_queue
       WHERE status = 'pending' AND scheduled_for <= now()
       ORDER BY scheduled_for
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, source_id, job_type, attempts, max_attempts`,
    [workerId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    sourceId: r.source_id,
    jobType: r.job_type,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
  };
}

export async function markDone(pool: Pool, jobId: string): Promise<void> {
  await pool.query(`UPDATE job_queue SET status = 'done' WHERE id = $1`, [jobId]);
}

/** Retries with linear backoff (30s * attempts) until max_attempts, then
 *  dead-letters — never disappears silently. */
export async function markFailed(pool: Pool, jobId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE job_queue
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
         last_error = $2,
         scheduled_for = CASE
           WHEN attempts >= max_attempts THEN scheduled_for
           ELSE now() + (interval '30 seconds' * attempts)
         END
     WHERE id = $1`,
    [jobId, error]
  );
}

export interface PollLoopOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

/** Long-running poll loop for the worker runtime (not Vercel serverless). */
export async function pollLoop(
  pool: Pool,
  handler: (job: Job) => Promise<void>,
  opts: PollLoopOptions = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 5000;
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!opts.signal?.aborted) {
    const job = await dequeue(pool);
    if (!job) {
      await sleep(intervalMs);
      continue;
    }
    try {
      await handler(job);
      await markDone(pool, job.id);
    } catch (err) {
      await markFailed(pool, job.id, String(err));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
