// tests/scheduler/job-dispatch-db.test.ts — a GLOBAL job really executes on the worker
// queue, against real Postgres, driven by the REAL scheduler.
//
// WHAT THIS PROVES THAT NOTHING ELSE DOES. tests/scheduler/job-type-dispatch.test.ts covers
// the registry against a stub pool; that is unit evidence about a function. This file runs
// startScheduler() (worker/src/scheduler.ts) against a real database and asserts on the
// job_queue ROW it leaves behind — status, last_error — plus the correction_report rows the
// purge actually deleted. Before the dispatch registry existed, the first test here ended
// with status='dead_letter' and last_error='ingest job has no source_id', because the poll
// loop ran the terms-gated INGEST handler for every claimed job whatever its job_type
// (worker/src/scheduler.ts, and worker/core/source-runner.ts:127 for the throw).
//
// THE SCHEDULER IS REAL, NOT RE-IMPLEMENTED. `immediate: false` + a 10-minute tick keeps
// the enqueue tick from firing, so nothing but the poll loop runs and the only job in the
// queue is the one the test inserted. Re-implementing dequeue/markDone here would have
// proved the queue primitives work — which was never in doubt — and left the actual wiring
// (the line that chooses a handler) untested, which is precisely the defect.
//
// Registered in DB_INTEGRATION_SUITES (vitest.workspace.ts): it executes real SQL and, like
// tests/ingestion/framework.test.ts, it resets the GLOBAL job_queue table so that dequeue()
// — which claims the oldest due pending job table-wide — can only claim its own row.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool, query } from '../../lib/db/client';
import { startScheduler } from '../../worker/src/scheduler';
import { enqueue } from '../../worker/core/queue';

const hasDb = Boolean(process.env.DATABASE_URL);

interface JobRow {
  status: string;
  last_error: string | null;
  attempts: number;
  source_id: string | null;
  job_type: string;
}

async function jobRow(jobId: string): Promise<JobRow> {
  const [row] = await query<JobRow & Record<string, unknown>>(
    `SELECT status, last_error, attempts, source_id, job_type FROM job_queue WHERE id = $1`,
    [jobId]
  );
  return row;
}

/**
 * Run the real scheduler until `jobId` reaches a terminal-for-this-test state, then stop it.
 *
 * Terminal = anything other than 'pending'/'running'. max_attempts is 1 on every job here,
 * so a failing job dead-letters on its first pass and nothing waits out a backoff.
 */
async function runSchedulerUntilSettled(jobId: string, timeoutMs = 20_000): Promise<JobRow> {
  const controller = new AbortController();
  const handle = startScheduler(getPool(), {
    signal: controller.signal,
    environment: 'staging',
    immediate: false, // no enqueue tick: this test owns the whole queue
    schedulerTickMs: 600_000,
    pollIntervalMs: 50,
  });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await jobRow(jobId);
      if (row && row.status !== 'pending' && row.status !== 'running') return row;
      if (Date.now() > deadline) {
        throw new Error(
          `job ${jobId} never settled (last status=${row?.status ?? 'MISSING'}, ` +
            `last_error=${row?.last_error ?? 'null'})`
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    controller.abort();
    await handle.done;
  }
}

describe.skipIf(!hasDb)('worker queue: job_type dispatch against real Postgres', () => {
  /** correction_report.occurrence_id is a NOT NULL FK, so the purge assertions need a real
   *  source → series → occurrence chain to hang test rows off. */
  let occurrenceId = '';
  let seriesId = '';
  let sourceId = '';
  let blockedSourceId = '';
  let tag = '';

  beforeAll(async () => {
    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status, robots_status, authority_tier, ingestion_method)
         VALUES ('test_job_dispatch', $1, 'allowed', 'allowed', 'official', 'manual') RETURNING id`,
      [`Job Dispatch Test Source ${randomUUID().slice(0, 8)}`]
    );
    sourceId = src.id;
    const [blocked] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status, robots_status, authority_tier, ingestion_method)
         VALUES ('test_job_dispatch', $1, 'blocked', 'allowed', 'official', 'manual') RETURNING id`,
      [`Job Dispatch Blocked Source ${randomUUID().slice(0, 8)}`]
    );
    blockedSourceId = blocked.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('Job Dispatch Series', $1) RETURNING id`,
      [sourceId]
    );
    seriesId = ser.id;
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
         VALUES ($1, 'Job Dispatch Listing', '2026-12-01T18:00:00Z', 'needs_review', 'unscored') RETURNING id`,
      [seriesId]
    );
    occurrenceId = occ.id;
  });

  beforeEach(async () => {
    // dequeue() claims the oldest due PENDING row table-wide, so a residual row from an
    // aborted run would make these tests claim the wrong job. Same precondition, and the
    // same reset, as tests/ingestion/framework.test.ts. The db lane is serial, so this
    // races nothing.
    await query('DELETE FROM job_queue');
    tag = `job-dispatch-${randomUUID().slice(0, 8)}`;
  });

  afterEach(async () => {
    await query(`DELETE FROM correction_report WHERE reporter LIKE 'job-dispatch-%'`);
  });

  afterAll(async () => {
    try {
      await query('DELETE FROM job_queue');
      await query(`DELETE FROM correction_report WHERE reporter LIKE 'job-dispatch-%'`);
      if (occurrenceId) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [occurrenceId]);
      if (occurrenceId) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [occurrenceId]);
      if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
      if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
      if (blockedSourceId) await query(`DELETE FROM source WHERE id = $1`, [blockedSourceId]);
    } finally {
      await closePool();
    }
  });

  /** Insert a correction_report whose retained_until is `days` from now (negative = expired). */
  async function insertReport(days: number): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO correction_report (occurrence_id, reporter, issue_type, retained_until)
         VALUES ($1, $2, 'wrong_info', now() + ($3 || ' days')::interval) RETURNING id`,
      [occurrenceId, tag, String(days)]
    );
    return row.id;
  }

  async function reportIds(): Promise<string[]> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM correction_report WHERE reporter = $1 ORDER BY id`,
      [tag]
    );
    return rows.map((r) => r.id);
  }

  /** Enqueue with max_attempts=1 so a failing job dead-letters on its first pass. */
  async function enqueueOneShot(jobType: string, srcId: string | null): Promise<string> {
    const jobId = await enqueue(getPool(), srcId, jobType);
    await query(`UPDATE job_queue SET max_attempts = 1 WHERE id = $1`, [jobId]);
    return jobId;
  }

  // ── ACCEPTANCE A ────────────────────────────────────────────────────────────────────
  it("a job_type='corrections_retention' job with source_id=NULL is claimed and COMPLETES", async () => {
    const jobId = await enqueueOneShot('corrections_retention', null);
    const before = await jobRow(jobId);
    expect(before.source_id).toBeNull(); // the shape that used to be undeliverable
    expect(before.job_type).toBe('corrections_retention');

    const row = await runSchedulerUntilSettled(jobId);

    // Before the dispatch registry this was status='dead_letter' with
    // last_error='ingest job has no source_id'.
    expect(row.last_error).toBeNull();
    expect(row.status).toBe('done');
  });

  it('and the purge REALLY RAN — expired corrections are gone, fresh ones survive', async () => {
    // A job that reaches 'done' without doing the work is the silent-success failure mode.
    // This asserts on the side effect, not on the status.
    await insertReport(-30);
    await insertReport(-1);
    const fresh = await insertReport(200);
    expect(await reportIds()).toHaveLength(3);

    const jobId = await enqueueOneShot('corrections_retention', null);
    const row = await runSchedulerUntilSettled(jobId);
    expect(row.status).toBe('done');

    expect(await reportIds()).toEqual([fresh]);
  });

  // ── ACCEPTANCE B ────────────────────────────────────────────────────────────────────
  it("job_type='ingest' with a NULL source_id still fails, exactly as before", async () => {
    // Not a regression to fix: an ingest job with no source IS malformed. The dispatch
    // change must not have widened the ingest handler to tolerate it.
    const jobId = await enqueueOneShot('ingest', null);
    const row = await runSchedulerUntilSettled(jobId);
    expect(row.status).toBe('dead_letter');
    expect(row.last_error).toBe('ingest job has no source_id');
  });

  it("job_type='ingest' still applies the terms gate to its source", async () => {
    const jobId = await enqueueOneShot('ingest', blockedSourceId);
    const row = await runSchedulerUntilSettled(jobId);
    expect(row.status).toBe('dead_letter');
    expect(row.last_error).toMatch(/terms_status=blocked/);
  });

  // ── ACCEPTANCE C ────────────────────────────────────────────────────────────────────
  it('an UNKNOWN job_type DEAD-LETTERS with a distinctive error — it is never marked done', async () => {
    const jobId = await enqueueOneShot('definitely_not_a_registered_job_type', null);
    const row = await runSchedulerUntilSettled(jobId);

    // ── TEETH ─────────────────────────────────────────────────────────────────────────
    // Make the unknown branch a no-op (`return;` instead of throwing UnknownJobTypeError in
    // worker/core/job-handlers.ts) and this row is 'done' with last_error NULL: both the
    // status assertion and the message assertion below go red.
    expect(row.status).toBe('dead_letter');
    expect(row.status).not.toBe('done');
    expect(row.last_error).toContain('unsupported job_type');
    expect(row.last_error).toContain('definitely_not_a_registered_job_type');
    // It must not have been silently handed to the ingest handler either.
    expect(row.last_error).not.toContain('ingest job has no source_id');
  });

  it('an unknown job_type does not run the retention purge as a side effect', async () => {
    const expired = await insertReport(-30);
    const jobId = await enqueueOneShot('corrections_retention_typo', null);
    const row = await runSchedulerUntilSettled(jobId);
    expect(row.status).toBe('dead_letter');
    expect(await reportIds()).toEqual([expired]); // still there — nothing ran
  });
});
