// tests/ingestion/reconcile.test.ts — H4: recovery of rows abandoned by a dead process.
//
// Reproduces the exact residue the 2026-07-30 Vancouver ActiveNet hang left behind: a
// `source_check_run` and a `job_queue` row both frozen at status='running' because the
// process that would have finalised them was killed. Nothing in the system could ever
// resolve those rows, and the stuck job additionally made the tiered scheduler treat the
// source as permanently in-flight, so it would never be enqueued again.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { reconcileAbandonedRuns, ABANDONED_RUN_THRESHOLD_MS } from '../../worker/core/reconcile';

const hasDb = Boolean(process.env.DATABASE_URL);

/** Minutes-ago timestamp helper — abandonment is defined purely by age. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

describe.skipIf(!hasDb)('reconcileAbandonedRuns (H4)', () => {
  let sourceId: string;
  const createdJobIds: string[] = [];
  const createdRunIds: string[] = [];

  beforeEach(async () => {
    const [src] = await query<{ id: string }>(`SELECT id FROM source LIMIT 1`);
    sourceId = src.id;
  });

  afterEach(async () => {
    if (createdJobIds.length > 0) {
      await query(`DELETE FROM job_queue WHERE id = ANY($1::uuid[])`, [createdJobIds]);
      createdJobIds.length = 0;
    }
    if (createdRunIds.length > 0) {
      await query(`DELETE FROM source_check_run WHERE id = ANY($1::uuid[])`, [createdRunIds]);
      createdRunIds.length = 0;
    }
  });

  async function seedRunningJob(opts: {
    lockedAt: string;
    attempts: number;
    maxAttempts: number;
  }): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO job_queue (source_id, job_type, status, locked_at, locked_by, attempts, max_attempts)
       VALUES ($1, 'ingest', 'running', $2, 'dead-worker', $3, $4) RETURNING id`,
      [sourceId, opts.lockedAt, opts.attempts, opts.maxAttempts]
    );
    createdJobIds.push(row.id);
    return row.id;
  }

  async function seedRunningCheckRun(startedAt: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, started_at, status)
       VALUES ($1, $2, 'running') RETURNING id`,
      [sourceId, startedAt]
    );
    createdRunIds.push(row.id);
    return row.id;
  }

  it('requeues an abandoned running job and fails its orphaned check run', async () => {
    const jobId = await seedRunningJob({ lockedAt: minutesAgo(45), attempts: 1, maxAttempts: 5 });
    const runId = await seedRunningCheckRun(minutesAgo(45));

    const result = await reconcileAbandonedRuns(getPool());
    expect(result.jobsRequeued).toBeGreaterThanOrEqual(1);
    expect(result.checkRunsFailed).toBeGreaterThanOrEqual(1);

    const [job] = await query<{
      status: string;
      locked_at: string | null;
      locked_by: string | null;
      last_error: string | null;
    }>(`SELECT status, locked_at, locked_by, last_error FROM job_queue WHERE id = $1`, [jobId]);
    expect(job.status).toBe('pending'); // claimable again — the source is no longer stranded
    expect(job.locked_at).toBeNull();
    expect(job.locked_by).toBeNull();
    expect(job.last_error).toMatch(/abandoned/i);

    const [run] = await query<{ status: string; errors: unknown; duration_ms: number | null }>(
      `SELECT status, errors, duration_ms FROM source_check_run WHERE id = $1`,
      [runId]
    );
    // 'failed', never 'success'/'partial': we do not know what the dead process wrote, and
    // an unknown outcome must not read as green on the T15 health board.
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run.errors)).toMatch(/abandoned_run/);
    expect(run.duration_ms).toBeGreaterThan(0);
  });

  it('dead-letters an abandoned job that had already exhausted its attempts', async () => {
    // Mirrors markFailed()'s policy so a source that hangs on every attempt still walks
    // its normal path to dead_letter instead of being requeued forever.
    const jobId = await seedRunningJob({ lockedAt: minutesAgo(45), attempts: 5, maxAttempts: 5 });

    const result = await reconcileAbandonedRuns(getPool());
    expect(result.jobsDeadLettered).toBeGreaterThanOrEqual(1);

    const [job] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [jobId]);
    expect(job.status).toBe('dead_letter');
  });

  it('leaves a job/check run that is still legitimately running alone', async () => {
    // The safety property: reclaiming a live job would let a second worker double-run the
    // source. Anything younger than the threshold must be untouched.
    const jobId = await seedRunningJob({ lockedAt: minutesAgo(1), attempts: 1, maxAttempts: 5 });
    const runId = await seedRunningCheckRun(minutesAgo(1));

    await reconcileAbandonedRuns(getPool());

    const [job] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [jobId]);
    const [run] = await query<{ status: string }>(
      `SELECT status FROM source_check_run WHERE id = $1`,
      [runId]
    );
    expect(job.status).toBe('running');
    expect(run.status).toBe('running');
  });

  it('is idempotent — a second sweep finds nothing left to do', async () => {
    await seedRunningJob({ lockedAt: minutesAgo(45), attempts: 1, maxAttempts: 5 });
    await seedRunningCheckRun(minutesAgo(45));

    const first = await reconcileAbandonedRuns(getPool());
    expect(first.jobsRequeued + first.checkRunsFailed).toBeGreaterThan(0);

    const second = await reconcileAbandonedRuns(getPool());
    expect(second).toEqual({ jobsRequeued: 0, jobsDeadLettered: 0, checkRunsFailed: 0 });
  });

  it('honours a custom threshold', async () => {
    const jobId = await seedRunningJob({ lockedAt: minutesAgo(5), attempts: 1, maxAttempts: 5 });

    // Default 30min threshold: untouched.
    await reconcileAbandonedRuns(getPool());
    let [job] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [jobId]);
    expect(job.status).toBe('running');

    // 1min threshold: reclaimed.
    await reconcileAbandonedRuns(getPool(), { thresholdMs: 60_000 });
    [job] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [jobId]);
    expect(job.status).toBe('pending');
  });

  it('uses a threshold far above any legitimate run', () => {
    // A hang is bounded at ~38s per request by the H4 fetch deadline; 30 minutes leaves a
    // very wide margin before anything is presumed dead.
    expect(ABANDONED_RUN_THRESHOLD_MS).toBe(30 * 60_000);
  });

  afterAll(async () => {
    await closePool();
  });
});
