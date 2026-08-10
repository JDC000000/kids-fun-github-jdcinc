// tests/scheduler/global-jobs-db.test.ts — the durable global-job schedule, its run ledger,
// the DB-level lock, the circuit breaker and the abandoned-run sweep, against REAL Postgres.
//
// WHY REAL POSTGRES AND REAL CONCURRENCY. Every guarantee under test here is the database's:
// a partial unique index (one unfinished run per schedule), a unique index (one run per due
// slot), and a failure counter that trips a breaker inside the same statement that closes a
// run. A mocked pool would let all four "pass" while the application-level check-then-act
// they replace still raced. The concurrency case below therefore runs two independent Pools
// — two workers — and asserts on the rows, not on the code.
//
// WHAT IT ARMS. Every global job configured here ships DISABLED, and each one arms something
// irreversible: 'corrections_retention' PERMANENTLY DELETES user-submitted correction
// reports, and 'stale_occurrence_flip' (migration 0029) demotes activity_occurrence rows to
// status_state='stale' with nothing recording what they held before. That is why the
// disabled-row cases (F) and the lock cases (B) get as much attention as the happy path: the
// schedule's `enabled` flag and the unique index are the two things standing between a bug
// here and a real, unrecoverable write.
//
// Registered in DB_INTEGRATION_SUITES (vitest.workspace.ts). Like
// tests/scheduler/job-dispatch-db.test.ts it resets the GLOBAL job_queue table, because
// dequeue() claims the oldest due pending job table-wide.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { closePool, getPool, query } from '../../lib/db/client';
import { startScheduler, type SchedulerMetrics } from '../../worker/src/scheduler';
import { healthz } from '../../worker/src/healthz';
import { enqueueDueGlobalJobs } from '../../worker/scheduler/global-jobs';
import { reconcileAbandonedRuns } from '../../worker/core/reconcile';
import {
  readGlobalJobScheduleHealth,
  resetGlobalJobBreaker,
} from '../../worker/core/global-job-schedule';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const hasDb = Boolean(process.env.DATABASE_URL);

const RETENTION_JOB_TYPE = 'corrections_retention';
const STALE_FLIP_JOB_TYPE = 'stale_occurrence_flip';

interface JobRow {
  id: string;
  status: string;
  last_error: string | null;
  job_type: string;
  source_id: string | null;
  max_attempts: number;
}

interface RunRow {
  id: string;
  job_id: string | null;
  scheduled_for: Date;
  enqueued_by: string;
  started_at: Date | null;
  claimed_by: string | null;
  finished_at: Date | null;
  outcome: string | null;
  error: string | null;
}

async function jobsOfType(jobType: string): Promise<JobRow[]> {
  return query<JobRow & Record<string, unknown>>(
    `SELECT id, status, last_error, job_type, source_id, max_attempts
       FROM job_queue WHERE job_type = $1 ORDER BY created_at, id`,
    [jobType]
  );
}

async function runsOf(scheduleId: string): Promise<RunRow[]> {
  return query<RunRow & Record<string, unknown>>(
    `SELECT id, job_id, scheduled_for, enqueued_by, started_at, claimed_by,
            finished_at, outcome, error
       FROM global_job_run WHERE schedule_id = $1 ORDER BY scheduled_for, id`,
    [scheduleId]
  );
}

/** Make a schedule due at a FRESH instant. A rewind to an already-used instant is blocked
 *  by idx_global_job_run_slot — which is itself tested, separately, below. */
async function makeDue(scheduleId: string): Promise<void> {
  await query(`UPDATE global_job_schedule SET next_run_at = clock_timestamp() WHERE id = $1`, [
    scheduleId,
  ]);
}

/**
 * Run the real scheduler's POLL loop until `jobId` leaves pending/running, then stop it.
 * `immediate: false` + a 10-minute tick means no enqueue tick fires, so this drains only
 * what the test already put on the queue. Same helper shape as job-dispatch-db.test.ts.
 */
async function runSchedulerUntilSettled(jobId: string, timeoutMs = 20_000): Promise<JobRow> {
  const controller = new AbortController();
  const handle = startScheduler(getPool(), {
    signal: controller.signal,
    environment: 'staging',
    immediate: false,
    schedulerTickMs: 600_000,
    pollIntervalMs: 25,
  });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await query<JobRow & Record<string, unknown>>(
        `SELECT id, status, last_error, job_type, source_id, max_attempts
           FROM job_queue WHERE id = $1`,
        [jobId]
      );
      if (row && row.status !== 'pending' && row.status !== 'running') {
        // The ledger is closed by the scheduler AFTER markDone/markFailed, so give that
        // last statement a moment rather than racing it.
        const deadline2 = Date.now() + 5_000;
        for (;;) {
          const [r] = await query<{ finished_at: Date | null }>(
            `SELECT finished_at FROM global_job_run WHERE job_id = $1`,
            [jobId]
          );
          if (!r || r.finished_at !== null || Date.now() > deadline2) break;
          await new Promise((res) => setTimeout(res, 20));
        }
        return row;
      }
      if (Date.now() > deadline) {
        throw new Error(`job ${jobId} never settled (status=${row?.status ?? 'MISSING'})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    controller.abort();
    await handle.done;
  }
}

describe.skipIf(!hasDb)('global job schedule + run ledger (real Postgres)', () => {
  /** The state migration 0028 SHIPPED the retention schedule in, captured before any test
   *  touches it. Acceptance F asserts against this, not against a re-read. */
  let shippedRetention: { id: string; enabled: boolean; cadenceSeconds: number } | null = null;

  /** The same, for the schedule migration 0029 ships for `stale_occurrence_flip`. */
  let shippedStaleFlip: {
    id: string;
    enabled: boolean;
    cadenceSeconds: number;
    maxConsecutiveFailures: number;
    nextRunAt: Date;
  } | null = null;

  /** correction_report.occurrence_id is a NOT NULL FK, so the purge assertions need a real
   *  source → series → occurrence chain to hang test rows off. */
  let occurrenceId = '';
  let seriesId = '';
  let sourceId = '';
  let tag = '';

  /** Synthetic schedules this file created, cleaned up in afterAll (CASCADE takes the runs). */
  const syntheticScheduleIds: string[] = [];

  async function makeSchedule(opts: {
    jobType?: string;
    cadenceSeconds?: number;
    enabled?: boolean;
    maxConsecutiveFailures?: number;
    dueAt?: 'now' | 'future';
  }): Promise<{ id: string; jobType: string }> {
    const jobType = opts.jobType ?? `test_global_job_${randomUUID().slice(0, 8)}`;
    const [row] = await query<{ id: string }>(
      `INSERT INTO global_job_schedule
         (job_type, cadence, enabled, next_run_at, max_consecutive_failures)
       VALUES ($1, make_interval(secs => $2::double precision), $3,
               CASE WHEN $4::text = 'now' THEN clock_timestamp() ELSE now() + interval '1 day' END,
               $5)
       RETURNING id`,
      [
        jobType,
        opts.cadenceSeconds ?? 60,
        opts.enabled ?? true,
        opts.dueAt ?? 'now',
        opts.maxConsecutiveFailures ?? 3,
      ]
    );
    syntheticScheduleIds.push(row.id);
    return { id: row.id, jobType };
  }

  beforeAll(async () => {
    const [shipped] = await query<{ id: string; enabled: boolean; cadence_seconds: number }>(
      `SELECT id, enabled, EXTRACT(EPOCH FROM cadence)::float8 AS cadence_seconds
         FROM global_job_schedule WHERE job_type = $1`,
      [RETENTION_JOB_TYPE]
    );
    shippedRetention = shipped
      ? { id: shipped.id, enabled: shipped.enabled, cadenceSeconds: Number(shipped.cadence_seconds) }
      : null;

    const [flip] = await query<{
      id: string;
      enabled: boolean;
      cadence_seconds: number;
      max_consecutive_failures: number;
      next_run_at: Date;
    }>(
      `SELECT id, enabled, EXTRACT(EPOCH FROM cadence)::float8 AS cadence_seconds,
              max_consecutive_failures, next_run_at
         FROM global_job_schedule WHERE job_type = $1`,
      [STALE_FLIP_JOB_TYPE]
    );
    shippedStaleFlip = flip
      ? {
          id: flip.id,
          enabled: flip.enabled,
          cadenceSeconds: Number(flip.cadence_seconds),
          maxConsecutiveFailures: flip.max_consecutive_failures,
          nextRunAt: flip.next_run_at,
        }
      : null;

    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status, robots_status, authority_tier, ingestion_method)
         VALUES ('test_global_sched', $1, 'allowed', 'allowed', 'official', 'manual') RETURNING id`,
      [`Global Schedule Test Source ${randomUUID().slice(0, 8)}`]
    );
    sourceId = src.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('Global Schedule Series', $1) RETURNING id`,
      [sourceId]
    );
    seriesId = ser.id;
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
         VALUES ($1, 'Global Schedule Listing', '2026-12-01T18:00:00Z', 'needs_review', 'unscored') RETURNING id`,
      [seriesId]
    );
    occurrenceId = occ.id;
  });

  /**
   * Run the producer and keep ONLY the entries for `scheduleId`.
   *
   * enqueueDueGlobalJobs() is table-wide, exactly as it is in production. Asserting on
   * `enqueued[0]` therefore assumes no other schedule is due — an assumption that was
   * FALSE here and made this file order-dependent: a leftover fixture from an earlier test
   * sorted first by next_run_at and the D block spent a whole run failing the wrong job.
   * beforeEach parks every synthetic schedule for that reason; this filter is the second
   * barrier, so a future test that forgets cannot silently assert about someone else's row.
   */
  async function tickFor(
    scheduleId: string,
    pool = getPool(),
    workerId?: string
  ): Promise<Awaited<ReturnType<typeof enqueueDueGlobalJobs>>['enqueued']> {
    const { enqueued } = await enqueueDueGlobalJobs(pool, workerId ? { workerId } : {});
    return enqueued.filter((e) => e.scheduleId === scheduleId);
  }

  /** The same filter applied to the tick's SKIPPED half — the due schedules it could not
   *  claim, and which conflict it decided each one was. */
  async function skipsFor(
    scheduleId: string,
    pool = getPool()
  ): Promise<Awaited<ReturnType<typeof enqueueDueGlobalJobs>>['skipped']> {
    const { skipped } = await enqueueDueGlobalJobs(pool);
    return skipped.filter((s) => s.scheduleId === scheduleId);
  }

  async function nextRunAtOf(scheduleId: string): Promise<Date> {
    const [row] = await query<{ next_run_at: Date }>(
      `SELECT next_run_at FROM global_job_schedule WHERE id = $1`,
      [scheduleId]
    );
    return row.next_run_at;
  }

  beforeEach(async () => {
    await query('DELETE FROM job_queue');
    tag = `global-sched-${randomUUID().slice(0, 8)}`;
    // PARK every schedule a previous test in this file created. They are enabled and due
    // by construction, they are never cleaned up until afterAll (the ledger rows are
    // evidence), and the producer is table-wide — so without this each test inherits its
    // predecessors' due work.
    await query(
      `UPDATE global_job_schedule
          SET enabled = false, next_run_at = now() + interval '365 days'
        WHERE job_type LIKE 'test\\_%'`
    );
    // Every test starts from the SHIPPED state of the retention schedule: disabled, no
    // runs, no failures. Tests that need it armed arm it themselves and say so.
    if (shippedRetention) {
      await query(`DELETE FROM global_job_run WHERE schedule_id = $1`, [shippedRetention.id]);
      await query(
        `UPDATE global_job_schedule
            SET enabled = false, next_run_at = now(), last_run_at = NULL, last_success_at = NULL,
                consecutive_failures = 0, breaker_tripped_at = NULL, breaker_reason = NULL
          WHERE id = $1`,
        [shippedRetention.id]
      );
    }
  });

  afterEach(async () => {
    await query(`DELETE FROM correction_report WHERE reporter LIKE 'global-sched-%'`);
  });

  afterAll(async () => {
    try {
      await query('DELETE FROM job_queue');
      for (const id of syntheticScheduleIds) {
        await query(`DELETE FROM global_job_schedule WHERE id = $1`, [id]);
      }
      if (shippedRetention) {
        await query(`DELETE FROM global_job_run WHERE schedule_id = $1`, [shippedRetention.id]);
        await query(
          `UPDATE global_job_schedule
              SET enabled = $2, next_run_at = now(), last_run_at = NULL, last_success_at = NULL,
                  consecutive_failures = 0, breaker_tripped_at = NULL, breaker_reason = NULL
            WHERE id = $1`,
          [shippedRetention.id, shippedRetention.enabled]
        );
      }
      if (shippedStaleFlip) {
        // Section F rewinds this row's due instant to prove a disabled schedule cannot fire.
        // Put it back where the migration left it so a later file reads the shipped state.
        await query(`DELETE FROM global_job_run WHERE schedule_id = $1`, [shippedStaleFlip.id]);
        await query(
          `UPDATE global_job_schedule SET enabled = $2, next_run_at = $3 WHERE id = $1`,
          [shippedStaleFlip.id, shippedStaleFlip.enabled, shippedStaleFlip.nextRunAt]
        );
      }
      await query(`DELETE FROM correction_report WHERE reporter LIKE 'global-sched-%'`);
      if (occurrenceId) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [occurrenceId]);
      if (occurrenceId) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [occurrenceId]);
      if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
      if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
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

  // ── ACCEPTANCE A ──────────────────────────────────────────────────────────────────────
  describe('A — an enabled, due schedule produces exactly one job that really does the work', () => {
    it('enqueues ONE job, runs it to done, and the expired corrections are actually GONE', async () => {
      const schedule = shippedRetention!;
      // Arming it is an explicit act HERE, in a test, exactly as it must be in production.
      await query(`UPDATE global_job_schedule SET enabled = true WHERE id = $1`, [schedule.id]);
      await makeDue(schedule.id);

      await insertReport(-30);
      await insertReport(-1);
      const fresh = await insertReport(200);
      expect(await reportIds()).toHaveLength(3);

      const enqueued = await tickFor(schedule.id, getPool(), 'test-tick');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].jobType).toBe(RETENTION_JOB_TYPE);

      const jobs = await jobsOfType(RETENTION_JOB_TYPE);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].source_id).toBeNull(); // a GLOBAL job — the shape Unit 1 taught the worker
      expect(jobs[0].max_attempts).toBe(1); // the schedule owns retry, not the queue

      const settled = await runSchedulerUntilSettled(jobs[0].id);
      expect(settled.last_error).toBeNull();
      expect(settled.status).toBe('done');

      // ASSERT THE DATA, NOT THE STATUS. 'done' is also what a silent no-op produces —
      // the failure mode this project has already shipped once.
      expect(await reportIds()).toEqual([fresh]);
    });

    it('the ledger records the run: one row, finished successfully, with the worker that claimed it', async () => {
      const schedule = shippedRetention!;
      await query(`UPDATE global_job_schedule SET enabled = true WHERE id = $1`, [schedule.id]);
      await makeDue(schedule.id);

      const [enqueued] = await tickFor(schedule.id, getPool(), 'test-tick');
      const [job] = await jobsOfType(RETENTION_JOB_TYPE);
      await runSchedulerUntilSettled(job.id);

      const runs = await runsOf(schedule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(enqueued.runId);
      expect(runs[0].job_id).toBe(job.id);
      expect(runs[0].enqueued_by).toBe('test-tick');
      expect(runs[0].started_at).not.toBeNull();
      expect(runs[0].claimed_by).not.toBeNull();
      expect(runs[0].finished_at).not.toBeNull();
      expect(runs[0].outcome).toBe('success');
      expect(runs[0].error).toBeNull();

      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: RETENTION_JOB_TYPE });
      expect(health.lastSuccessAt).not.toBeNull();
      expect(health.consecutiveFailures).toBe(0);
      expect(health.inFlight).toBe(false);
      // next_run_at advanced a whole cadence forward, so it is not due again.
      expect(health.nextRunAt.getTime()).toBeGreaterThan(health.observedAt.getTime());
    });
  });

  // ── ACCEPTANCE B ──────────────────────────────────────────────────────────────────────
  describe('B — idempotence under genuine concurrency', () => {
    it('EIGHT ticks racing across TWO independent pools produce ONE run, not eight', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      // Two Pools = two connection sets = two "workers", not two calls sharing one client.
      const poolB = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const ticks = Array.from({ length: 8 }, (_, i) =>
          tickFor(schedule.id, i % 2 === 0 ? getPool() : poolB, `racer-${i}`)
        );
        const results = await Promise.all(ticks);

        // Exactly one tick claimed it; the other seven correctly enqueued nothing.
        const winners = results.filter((r) => r.length > 0);
        expect(winners).toHaveLength(1);

        // And the DATABASE agrees — which is the assertion that matters, because the
        // return values above are the code's own account of itself.
        expect(await runsOf(schedule.id)).toHaveLength(1);
        expect(await jobsOfType(schedule.jobType)).toHaveLength(1);
      } finally {
        await poolB.end();
      }
    });

    it('the guarantee is a UNIQUE INDEX: a second ledger insert for the same slot is REJECTED by Postgres', async () => {
      // Direct evidence, independent of any application code path. If the lock were an
      // application-level check-then-act this insert would succeed.
      const schedule = await makeSchedule({ dueAt: 'future' });
      const slot = new Date();
      await query(
        `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by) VALUES ($1, $2, 'a')`,
        [schedule.id, slot]
      );
      await expect(
        query(
          `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by) VALUES ($1, $2, 'b')`,
          [schedule.id, slot]
        )
      ).rejects.toThrow(/duplicate key|unique/i);

      // Even at a DIFFERENT slot: the first run is still unfinished, and only one may be.
      await expect(
        query(
          `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by) VALUES ($1, $2, 'c')`,
          [schedule.id, new Date(slot.getTime() + 60_000)]
        )
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('an UNFINISHED run blocks the next tick even after the schedule is due again', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      expect(await tickFor(schedule.id)).toHaveLength(1);

      // A fresh due instant, so the SLOT index is not what is doing the blocking here —
      // this isolates the in-flight lock. Nothing has finished the first run.
      await makeDue(schedule.id);
      expect(await tickFor(schedule.id)).toHaveLength(0);
      expect(await runsOf(schedule.id)).toHaveLength(1);
      expect(await jobsOfType(schedule.jobType)).toHaveLength(1);
    });

    it('a FINISHED run still cannot be replayed at the same slot — and the rewind does not WEDGE the schedule', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      const [{ scheduledFor }] = await tickFor(schedule.id);
      await query(
        `UPDATE global_job_run SET finished_at = now(), outcome = 'success' WHERE schedule_id = $1`,
        [schedule.id]
      );
      // Rewind to the slot that already ran — a clock skew, a replayed tick, or an operator
      // rewinding next_run_at by hand.
      //
      // ── WHY THE MICROSECONDS ARE HERE, AND WHY THEY ARE THE POINT ──────────────────────
      // timestamptz stores MICROseconds; a JS Date holds MILLIseconds, and node-postgres
      // TRUNCATES on the way out (verified: '…:55.169524+00' parses to …:55.169Z, and
      // feeding that Date back does NOT equal the column). So the tick reads next_run_at,
      // loses the tail, and writes global_job_run.scheduled_for from the truncated Date.
      // resolveClaimConflict() must then ask its "has this slot already been served?"
      // question with THAT truncated Date — the one the rejected INSERT used — and NOT with
      // global_job_schedule.next_run_at, which is a few microseconds away and matches
      // nothing. Its comment says so; nothing pinned it, because every rewind in this file
      // wrote next_run_at from a JS Date, making ms and us identical in the fixture and the
      // WRONG comparison pass anyway.
      //
      // Migration 0028 ships corrections_retention with a microsecond-bearing next_run_at
      // (`now()`), so this is the REAL shape, not a contrived one. With the wrong comparison
      // the rewind is misread as `run_in_flight`, next_run_at is left where it is, and the
      // schedule is wedged for ever while health still reports the benign 'due' — the exact
      // defect the assertions below exist to catch. Keep the offset well under half a
      // millisecond so the truncated value still lands on the served slot.
      await query(
        `UPDATE global_job_schedule SET next_run_at = $2::timestamptz + interval '369 microseconds'
          WHERE id = $1`,
        [schedule.id, scheduledFor]
      );
      const [{ sub_ms: subMs }] = await query<{ sub_ms: string }>(
        `SELECT (EXTRACT(MICROSECONDS FROM next_run_at)::bigint % 1000)::text AS sub_ms
           FROM global_job_schedule WHERE id = $1`,
        [schedule.id]
      );
      // The fixture really does carry a sub-millisecond tail. Without this, a future edit
      // that rounds the value off would silently return this test to the toothless shape it
      // had before, and nothing would say so.
      expect(Number(subMs)).toBe(369);

      expect(await tickFor(schedule.id)).toHaveLength(0);
      expect(await runsOf(schedule.id)).toHaveLength(1);

      // ── THE ASSERTION THIS TEST WAS MISSING ────────────────────────────────────────────
      // "0 enqueued and still 1 run" is ALSO what a permanently wedged schedule looks like,
      // which is why the anti-replay guarantee shipped sitting on top of a silent stop: the
      // tick `continue`d past the next_run_at advance, so the row stayed at the served slot,
      // every later tick re-conflicted, and the schedule never ran again while health
      // reported the benign 'due'. A test that never looks at next_run_at cannot tell the
      // guarantee from the bug.
      const advanced = await nextRunAtOf(schedule.id);
      expect(advanced.getTime()).toBeGreaterThan(scheduledFor.getTime());
      expect(advanced.getTime()).toBeGreaterThan(Date.now());
    });

    it('the rewind is REPORTED as slot_already_served, not passed off as an ordinary lost race', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      const [{ scheduledFor }] = await tickFor(schedule.id);
      await query(
        `UPDATE global_job_run SET finished_at = now(), outcome = 'success' WHERE schedule_id = $1`,
        [schedule.id]
      );
      await query(`UPDATE global_job_schedule SET next_run_at = $2 WHERE id = $1`, [
        schedule.id,
        scheduledFor,
      ]);

      const [skip] = await skipsFor(schedule.id);
      expect(skip).toBeDefined();
      expect(skip.reason).toBe('slot_already_served');
      expect(skip.scheduledFor.getTime()).toBe(scheduledFor.getTime());
      expect(skip.nextRunAt).not.toBeNull();
      expect(skip.nextRunAt!.getTime()).toBeGreaterThan(scheduledFor.getTime());
    });

    it('an in-flight conflict is reported as run_in_flight and LEAVES next_run_at alone — the level-triggered case still works', async () => {
      // The other half of the discrimination. Advancing here would be wrong: nothing has run
      // for this instant, the schedule must stay due until the open run closes.
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      expect(await tickFor(schedule.id)).toHaveLength(1);
      await makeDue(schedule.id); // a FRESH instant, so only the in-flight lock can block
      const due = await nextRunAtOf(schedule.id);

      const [skip] = await skipsFor(schedule.id);
      expect(skip.reason).toBe('run_in_flight');
      expect(skip.nextRunAt).toBeNull();
      expect((await nextRunAtOf(schedule.id)).getTime()).toBe(due.getTime());
    });

    it('four consecutive ticks after a rewind leave the schedule RUNNING, not stopped', async () => {
      // The reproduction, end to end: before the fix this loop enqueued 0 four times and
      // next_run_at never moved. Now the first tick un-wedges it and a later one runs it.
      const schedule = await makeSchedule({ cadenceSeconds: 1, dueAt: 'now' });
      const [{ scheduledFor }] = await tickFor(schedule.id);
      await query(
        `UPDATE global_job_run SET finished_at = now(), outcome = 'success' WHERE schedule_id = $1`,
        [schedule.id]
      );
      await query(`UPDATE global_job_schedule SET next_run_at = $2 WHERE id = $1`, [
        schedule.id,
        scheduledFor,
      ]);

      let enqueuedTotal = 0;
      for (let i = 0; i < 4; i += 1) {
        enqueuedTotal += (await tickFor(schedule.id)).length;
        await new Promise((r) => setTimeout(r, 1100)); // let the 1s cadence come due again
      }
      expect(enqueuedTotal).toBeGreaterThan(0);
      expect((await runsOf(schedule.id)).length).toBeGreaterThan(1);
      expect((await nextRunAtOf(schedule.id)).getTime()).toBeGreaterThan(scheduledFor.getTime());
    });
  });

  // ── ACCEPTANCE C ──────────────────────────────────────────────────────────────────────
  describe('C — a missed run is detected from stored state alone, with nothing running', () => {
    // NOTHING IN THIS BLOCK STARTS A SCHEDULER, A POLL LOOP OR A TICK. Every assertion is
    // the result of one SELECT. That is the point: a worker killed by Fly's 5-second
    // kill_timeout writes nothing at all, so a design that only notices a miss when a
    // worker is alive to report it cannot see the case that matters.
    it('nine missed one-minute slots are derived from cadence + the ABSENCE of ledger rows', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 60, dueAt: 'now' });
      // A run that completed ten minutes ago, and then silence — exactly what a fleet that
      // died ten minutes ago leaves behind.
      await query(
        `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by, started_at, finished_at, outcome)
           VALUES ($1, now() - interval '10 minutes', 'dead-worker',
                   now() - interval '10 minutes', now() - interval '10 minutes', 'success')`,
        [schedule.id]
      );
      await query(`UPDATE global_job_schedule SET next_run_at = now() - interval '9 minutes' WHERE id = $1`, [
        schedule.id,
      ]);

      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      // 10 slots have come due since the anchor; the currently-due one is 'due', not yet
      // 'missed' (MISSED_RUN_GRACE_PERIODS = 1). The other nine had a whole cadence to
      // produce a ledger row and produced none.
      expect(health.missedRuns).toBe(9);
      expect(health.status).toBe('missed');
      expect(health.inFlight).toBe(false);
    });

    it('a schedule that has NEVER run anchors on its creation, so a silent birth is a miss too', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 60, dueAt: 'now' });
      await query(
        `UPDATE global_job_schedule SET created_at = now() - interval '10 minutes' WHERE id = $1`,
        [schedule.id]
      );
      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      expect(health.lastRunSlot).toBeNull();
      expect(health.missedRuns).toBe(9);
      expect(health.status).toBe('missed');
    });

    it('a schedule running on cadence derives ZERO missed runs — the detector is not just "always yes"', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'future' });
      await query(
        `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by, started_at, finished_at, outcome)
           VALUES ($1, now() - interval '30 seconds', 'live-worker',
                   now() - interval '30 seconds', now() - interval '29 seconds', 'success')`,
        [schedule.id]
      );
      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      expect(health.missedRuns).toBe(0);
      expect(health.status).toBe('ok');
    });

    it('a DISABLED schedule cannot miss — it was never supposed to run', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 60, enabled: false, dueAt: 'now' });
      await query(
        `UPDATE global_job_schedule SET created_at = now() - interval '10 minutes' WHERE id = $1`,
        [schedule.id]
      );
      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      expect(health.missedRuns).toBe(0);
      expect(health.status).toBe('disabled');
    });
  });

  // ── ACCEPTANCE D ──────────────────────────────────────────────────────────────────────
  describe('D — the circuit breaker stops the schedule and stays stopped', () => {
    /** An unregistered job_type: worker/core/job-handlers.ts throws UnknownJobTypeError, so
     *  every run of this schedule genuinely fails through the real code path. */
    async function failingSchedule(max: number) {
      return makeSchedule({
        jobType: `test_unregistered_job_${randomUUID().slice(0, 8)}`,
        cadenceSeconds: 3600,
        maxConsecutiveFailures: max,
        dueAt: 'now',
      });
    }

    async function runOnce(schedule: { id: string; jobType: string }): Promise<number> {
      await makeDue(schedule.id);
      const enqueued = await tickFor(schedule.id);
      if (enqueued.length === 0) return 0;
      await runSchedulerUntilSettled(enqueued[0].jobId);
      return 1;
    }

    it('trips after exactly max_consecutive_failures and then enqueues NOTHING', async () => {
      const schedule = await failingSchedule(3);

      expect(await runOnce(schedule)).toBe(1);
      expect((await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType }))[0])
        .toMatchObject({ consecutiveFailures: 1, breakerTrippedAt: null });

      expect(await runOnce(schedule)).toBe(1);
      expect((await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType }))[0])
        .toMatchObject({ consecutiveFailures: 2, breakerTrippedAt: null });

      expect(await runOnce(schedule)).toBe(1);
      const [tripped] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      expect(tripped.consecutiveFailures).toBe(3);
      expect(tripped.breakerTrippedAt).not.toBeNull();
      expect(tripped.breakerReason).toMatch(/unsupported job_type/);
      expect(tripped.status).toBe('breaker_tripped');

      // The fourth attempt enqueues nothing at all — not a retry, not a backoff, nothing.
      expect(await runOnce(schedule)).toBe(0);
      expect(await runsOf(schedule.id)).toHaveLength(3);
      expect(await jobsOfType(schedule.jobType)).toHaveLength(3);
    });

    it('STAYS stopped across many further ticks — it is a breaker, not a backoff', async () => {
      const schedule = await failingSchedule(1);
      expect(await runOnce(schedule)).toBe(1);
      expect((await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType }))[0].breakerTrippedAt)
        .not.toBeNull();

      for (let i = 0; i < 5; i += 1) {
        await makeDue(schedule.id);
        expect(await tickFor(schedule.id)).toHaveLength(0);
      }
      expect(await runsOf(schedule.id)).toHaveLength(1);
    });

    it('recovery requires the EXPLICIT reset — clearing only one half does not re-arm it', async () => {
      const schedule = await failingSchedule(1);
      await runOnce(schedule);

      // Half a recovery: the timestamp is cleared but the failure count still stands. A
      // schedule that looked recovered and quietly stayed dead would be the worst outcome,
      // so the producer requires BOTH and this must still enqueue nothing.
      await query(`UPDATE global_job_schedule SET breaker_tripped_at = NULL WHERE id = $1`, [schedule.id]);
      await makeDue(schedule.id);
      expect(await tickFor(schedule.id)).toHaveLength(0);
      expect((await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType }))[0].status)
        .toBe('breaker_tripped');

      // The explicit act.
      const reset = await resetGlobalJobBreaker(getPool(), schedule.jobType);
      expect(reset).not.toBeNull();
      expect(reset!.clearedFailures).toBe(1);

      await makeDue(schedule.id);
      expect(await tickFor(schedule.id)).toHaveLength(1);
    });

    it('a SUCCESS resets the consecutive-failure count, so isolated failures never accumulate', async () => {
      const schedule = shippedRetention!;
      await query(
        `UPDATE global_job_schedule SET enabled = true, consecutive_failures = 2 WHERE id = $1`,
        [schedule.id]
      );
      await makeDue(schedule.id);
      const [enqueued] = await tickFor(schedule.id);
      await runSchedulerUntilSettled(enqueued.jobId);

      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: RETENTION_JOB_TYPE });
      expect(health.consecutiveFailures).toBe(0);
      expect(health.breakerTrippedAt).toBeNull();
    });
  });

  // ── ACCEPTANCE E ──────────────────────────────────────────────────────────────────────
  describe('E — a run abandoned mid-flight is reclaimed; the lock does not survive its holder', () => {
    it('reconcile closes the orphaned ledger row and the schedule becomes runnable again', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      const [enqueued] = await tickFor(schedule.id);

      // Simulate the 5-second kill: the worker claimed the job and the ledger run, then the
      // machine vanished. Nothing will ever finish either row.
      await query(
        `UPDATE job_queue SET status = 'running', attempts = 1, locked_at = now() - interval '2 hours',
                              locked_by = 'machine-that-died' WHERE id = $1`,
        [enqueued.jobId]
      );
      await query(
        `UPDATE global_job_run SET started_at = now() - interval '2 hours', claimed_by = 'machine-that-died'
          WHERE id = $1`,
        [enqueued.runId]
      );

      // The lock is held, so the schedule is stuck — this is the state that kills the
      // feature quietly if nothing sweeps it.
      await makeDue(schedule.id);
      expect(await tickFor(schedule.id)).toHaveLength(0);

      const swept = await reconcileAbandonedRuns(getPool());
      expect(swept.globalJobRuns.abandoned).toBe(1);

      const [orphan] = await runsOf(schedule.id);
      expect(orphan.finished_at).not.toBeNull();
      expect(orphan.outcome).toBe('abandoned');
      expect(orphan.error).toMatch(/abandoned/);
      expect(orphan.claimed_by).toBe('machine-that-died');

      // THE LOCK IS GONE. A new run can be enqueued.
      await makeDue(schedule.id);
      const again = await tickFor(schedule.id);
      expect(again).toHaveLength(1);
      expect(await runsOf(schedule.id)).toHaveLength(2);
    });

    it('an abandoned run counts against the breaker — a job that keeps killing its worker stops', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, maxConsecutiveFailures: 1, dueAt: 'now' });
      const [enqueued] = await tickFor(schedule.id);
      await query(
        `UPDATE global_job_run SET started_at = now() - interval '2 hours' WHERE id = $1`,
        [enqueued.runId]
      );
      await reconcileAbandonedRuns(getPool());

      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      expect(health.consecutiveFailures).toBe(1);
      expect(health.breakerTrippedAt).not.toBeNull();
    });

    it('a run whose job had already reached done closes as SUCCESS, not as a failure', async () => {
      // The crash window between markDone and the ledger write. Recording that as a failure
      // would walk the breaker toward tripping on work that actually completed.
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      const [enqueued] = await tickFor(schedule.id);
      await query(`UPDATE job_queue SET status = 'done' WHERE id = $1`, [enqueued.jobId]);
      await query(
        `UPDATE global_job_run SET started_at = now() - interval '2 hours' WHERE id = $1`,
        [enqueued.runId]
      );

      const swept = await reconcileAbandonedRuns(getPool());
      expect(swept.globalJobRuns.resolvedSuccessful).toBe(1);
      expect(swept.globalJobRuns.abandoned).toBe(0);

      const [run] = await runsOf(schedule.id);
      expect(run.outcome).toBe('success');
      const [health] = await readGlobalJobScheduleHealth(getPool(), { jobType: schedule.jobType });
      expect(health.consecutiveFailures).toBe(0);
    });

    it('a run that is merely YOUNG is left alone — the sweep is a threshold, not a truncation', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      await tickFor(schedule.id);
      const swept = await reconcileAbandonedRuns(getPool());
      expect(swept.globalJobRuns.abandoned).toBe(0);
      expect((await runsOf(schedule.id))[0].finished_at).toBeNull();
    });
  });

  // ── SKIPPED SLOTS ARE COUNTED, NOT SWEPT UNDER THE CARPET ─────────────────────────────
  describe('after an outage the producer says HOW MANY slots it jumped past', () => {
    it('a ten-minute gap on a one-minute cadence enqueues ONE run and reports 10 skipped slots', async () => {
      // The producer jumps next_run_at to the first future slot, so ten one-minute slots get
      // no run at all. That is right for the level-triggered purge and it is SILENT DATA
      // LOSS for any edge-triggered job put on this shared path later. Before this the
      // count existed nowhere: not in the return value, not in a log, not on /healthz — the
      // next author would have had to derive it from gaps in the ledger to know it happened.
      const schedule = await makeSchedule({ cadenceSeconds: 60 });
      await query(
        `UPDATE global_job_schedule SET next_run_at = now() - interval '10 minutes' WHERE id = $1`,
        [schedule.id]
      );

      const [enqueued] = await tickFor(schedule.id);
      expect(enqueued.skippedSlots).toBe(10);
      // ONE run for the oldest missed slot — not eleven replays.
      expect(await runsOf(schedule.id)).toHaveLength(1);
      expect(enqueued.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('an ON-TIME run reports ZERO skipped slots — the counter is not just "always something"', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      const [enqueued] = await tickFor(schedule.id);
      expect(enqueued.skippedSlots).toBe(0);
    });
  });

  // ── ACCEPTANCE G ──────────────────────────────────────────────────────────────────────
  describe('G — the operator-facing health comes from the DATABASE, so a RESTART cannot erase it', () => {
    // WHAT THIS BLOCK IS FOR. Unit 2 shipped readGlobalJobScheduleHealth() — the only thing
    // that can report 'breaker_tripped'/'missed' from durable state — with ZERO runtime
    // callers, and populated /healthz from a per-PROCESS list that only the statement which
    // TRIPPED the breaker ever wrote to. A process booting after the trip therefore reported
    // globalBreakersTripped=[] and lastError=null while the compliance purge was stopped
    // indefinitely. Every test here starts from state written by NOBODY the reader ever met.

    /** A schedule that is enabled, badly overdue, and STOPPED — with no process alive that
     *  saw any of it happen. Cadence is 1 day so the missed-slot count is legible. */
    async function stoppedSchedule(): Promise<{ id: string; jobType: string }> {
      const schedule = await makeSchedule({ cadenceSeconds: 86_400, maxConsecutiveFailures: 3 });
      await query(
        `UPDATE global_job_schedule
            SET enabled = true,
                created_at = now() - interval '30 days',
                next_run_at = now() - interval '30 days',
                consecutive_failures = 3,
                breaker_tripped_at = now() - interval '30 days',
                breaker_reason = 'failure: the machine that broke this is long gone'
          WHERE id = $1`,
        [schedule.id]
      );
      return schedule;
    }

    /**
     * Boot a scheduler that has NEVER seen anything, on its own Pool, and wait for its first
     * durable health read.
     *
     * `immediate: false` + a 10-minute tick means it enqueues nothing: the health read is
     * deliberately not gated on `immediate`, so this is also the assertion that a restarted
     * worker reports the truth AT BOOT rather than after up to a full tick interval.
     */
    async function bootFreshScheduler(): Promise<{
      metrics: SchedulerMetrics;
      stop: () => Promise<void>;
    }> {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const controller = new AbortController();
      const handle = startScheduler(pool, {
        signal: controller.signal,
        environment: 'staging',
        immediate: false,
        schedulerTickMs: 600_000,
        pollIntervalMs: 600_000,
      });
      const stop = async (): Promise<void> => {
        controller.abort();
        await handle.done;
        await pool.end();
      };
      const deadline = Date.now() + 10_000;
      while (handle.metrics.globalScheduleHealthAt === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return { metrics: handle.metrics, stop };
    }

    /** The bytes an operator would actually get from GET /healthz for these metrics. */
    function healthzPayload(metrics: SchedulerMetrics): Record<string, unknown> {
      let body = '';
      const res = {
        writeHead: () => undefined,
        end: (chunk: string) => {
          body = chunk;
        },
      } as unknown as ServerResponse;
      healthz({} as never, res, {
        chromiumReady: true,
        bootedAt: new Date().toISOString(),
        scheduler: metrics,
      });
      return JSON.parse(body) as Record<string, unknown>;
    }

    it('a scheduler that boots AFTER the trip reports it — the in-process list is no longer the source', async () => {
      const schedule = await stoppedSchedule();
      const booted = await bootFreshScheduler();
      try {
        const { metrics } = booted;
        // The read happened at all. An empty globalSchedules with a null timestamp means
        // UNKNOWN, and a test that skipped this check could pass on "nothing is wrong".
        expect(metrics.globalScheduleHealthAt).not.toBeNull();
        expect(metrics.globalScheduleHealthError).toBeNull();

        const snapshot = metrics.globalSchedules.find((s) => s.jobType === schedule.jobType);
        expect(snapshot).toBeDefined();
        expect(snapshot!.status).toBe('breaker_tripped');
        expect(snapshot!.breakerTrippedAt).not.toBeNull();
        expect(snapshot!.breakerReason).toMatch(/long gone/);
        expect(snapshot!.consecutiveFailures).toBe(3);
        // 30 daily slots came due against an anchor 30 days old; one is forgiven as merely
        // 'due' (MISSED_RUN_GRACE_PERIODS).
        expect(snapshot!.missedRuns).toBeGreaterThanOrEqual(29);

        // The alarm an operator reads first, which this process could not possibly have
        // witnessed — it did not exist when the breaker tripped.
        expect(metrics.globalBreakersTripped).toContain(schedule.jobType);
      } finally {
        await booted.stop();
      }
    });

    it('the /healthz PAYLOAD carries it, not just the metrics object', async () => {
      const schedule = await stoppedSchedule();
      const booted = await bootFreshScheduler();
      try {
        const payload = healthzPayload(booted.metrics);
        const scheduler = payload.scheduler as SchedulerMetrics;
        expect(scheduler.globalBreakersTripped).toContain(schedule.jobType);
        const serialised = JSON.stringify(payload);
        expect(serialised).toContain(schedule.jobType);
        expect(serialised).toContain('breaker_tripped');
      } finally {
        await booted.stop();
      }
    });

    it('a healthy schedule is NOT reported as tripped — the reader is not just "always alarmed"', async () => {
      // The negative control. Without it, a reader hard-coded to shout would pass every
      // assertion above.
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'future' });
      await query(
        `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by, started_at, finished_at, outcome)
           VALUES ($1, now() - interval '30 seconds', 'live-worker',
                   now() - interval '30 seconds', now() - interval '29 seconds', 'success')`,
        [schedule.id]
      );
      const booted = await bootFreshScheduler();
      try {
        const snapshot = booted.metrics.globalSchedules.find((s) => s.jobType === schedule.jobType);
        expect(snapshot!.status).toBe('ok');
        expect(snapshot!.missedRuns).toBe(0);
        expect(booted.metrics.globalBreakersTripped).not.toContain(schedule.jobType);
      } finally {
        await booted.stop();
      }
    });

    it('an operator RESET clears the alarm: a worker booted AFTER it no longer reports the breaker', async () => {
      // The other half of "durable is the source": a list that only ever grew would keep
      // shouting after the fault was cleared, and an alarm that cannot be turned off is an
      // alarm that gets ignored.
      //
      // NAMED FOR WHAT IT ASSERTS. This used to say "on a running worker", which claimed
      // more than the body proves: the alarm is re-read on the next durable refresh, and
      // what is checked below is a worker that BOOTS after the reset. Clearing on a worker
      // that stays up is true (the list is replaced, not appended, on every refresh) but it
      // is not what these expectations look at, and a test whose name overstates its
      // assertion is how a gap gets left behind believing it is covered.
      const schedule = await stoppedSchedule();
      const booted = await bootFreshScheduler();
      try {
        expect(booted.metrics.globalBreakersTripped).toContain(schedule.jobType);

        await resetGlobalJobBreaker(getPool(), schedule.jobType);
        await query(`UPDATE global_job_schedule SET next_run_at = now() + interval '1 day' WHERE id = $1`, [
          schedule.id,
        ]);
        // Re-boot rather than wait out a 10-minute tick; the assertion is about where the
        // list comes from, and a fresh process is the strictest way to ask.
        await booted.stop();
        const rebooted = await bootFreshScheduler();
        try {
          expect(rebooted.metrics.globalBreakersTripped).not.toContain(schedule.jobType);
          const snapshot = rebooted.metrics.globalSchedules.find(
            (s) => s.jobType === schedule.jobType
          );
          expect(snapshot!.status).not.toBe('breaker_tripped');
        } finally {
          await rebooted.stop();
        }
      } catch (err) {
        await booted.stop().catch(() => undefined);
        throw err;
      }
    });

    // ── THE ACCEPTANCE TEST IS A RESTART, AND THIS ONE IS A REAL OS PROCESS ──────────────
    describe('a genuinely separate process, over a real socket', () => {
      const FIXTURE = join(REPO_ROOT, 'tests/scheduler/__fixtures__/restarted-worker.cjs');

      beforeAll(() => {
        // The same compile worker/Dockerfile runs. Built here rather than assumed present so
        // the test is self-sufficient locally as well as in CI (which builds worker/ first).
        execFileSync(
          process.execPath,
          [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(REPO_ROOT, 'worker/tsconfig.json')],
          { cwd: REPO_ROOT, stdio: 'pipe' }
        );
      }, 120_000);

      /**
       * Park every source the TIERED producer would consider due, and hand back the undo.
       *
       * Only needed for the `immediate: true` child: that one runs a real boot tick, and
       * tickOnce()'s middle step is enqueueDueJobs() — a WRITE, into the job_queue this
       * whole db lane shares. Worse, the scheduler's queueLoop takes its first poll
       * IMMEDIATELY (worker/src/scheduler.ts queueLoop has no leading sleep — the
       * pollIntervalMs backoff happens only AFTER a poll finds nothing), so a job enqueued
       * by the boot tick can be claimed and DISPATCHED — a live ingest run — before the
       * assertion below has even fired. A large pollIntervalMs does not prevent that; making
       * the producer find nothing does.
       *
       * `next_check_at` is the producer's own cadence gate and the column a normal tick
       * advances anyway, so moving it is the same kind of write the scheduler makes, and it
       * is restored in a finally. The `expect(lastEnqueueCount).toBe(0)` in the test is the
       * proof this held: if a future fixture leaves a genuinely due source behind, that
       * assertion fails loudly instead of the suite quietly starting to do network I/O.
       */
      async function parkDueTieredSources(): Promise<() => Promise<void>> {
        const before = await query<{ id: string; next_check_at: Date | null }>(
          `WITH due AS (
             SELECT id, next_check_at FROM source
              WHERE next_check_at IS NULL OR next_check_at <= now()
              FOR UPDATE
           ), parked AS (
             UPDATE source s SET next_check_at = now() + interval '1 day'
               FROM due d WHERE s.id = d.id
           )
           SELECT id, next_check_at FROM due`
        );
        return async () => {
          for (const row of before) {
            await query(`UPDATE source SET next_check_at = $2 WHERE id = $1`, [
              row.id,
              row.next_check_at,
            ]);
          }
        };
      }

      async function bootWorkerProcess(immediate: boolean): Promise<{
        health: () => Promise<{ scheduler: SchedulerMetrics }>;
        stop: () => void;
      }> {
        const child = spawn(process.execPath, [FIXTURE], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL,
            FIXTURE_IMMEDIATE: String(immediate),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        const port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`child worker never listened. stderr:\n${stderr}`)),
            20_000
          );
          let out = '';
          child.stdout.on('data', (d: Buffer) => {
            out += d.toString();
            const m = /LISTENING (\d+)/.exec(out);
            if (m) {
              clearTimeout(timer);
              resolve(Number(m[1]));
            }
          });
          child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`child worker exited with ${code}. stderr:\n${stderr}`));
          });
        });
        const health = async (): Promise<{ scheduler: SchedulerMetrics }> => {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`);
          return (await res.json()) as { scheduler: SchedulerMetrics };
        };
        return { health, stop: () => child.kill('SIGTERM') };
      }

      /** Poll the child's REAL /healthz socket until it has read durable health, or fail. */
      async function awaitDurableHealth(
        worker: { health: () => Promise<{ scheduler: SchedulerMetrics }> },
        immediate: boolean
      ): Promise<SchedulerMetrics> {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const body = await worker.health();
          if (body.scheduler.globalScheduleHealthAt !== null) return body.scheduler;
          if (Date.now() > deadline) {
            throw new Error(
              `child worker (immediate=${immediate}) never read durable health — ` +
                `the ${immediate ? 'TRAILING refresh at the end of tickOnce' : 'DIRECT refresh on the boot branch'} did not report`
            );
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      /** The assertions that must hold whichever boot path got the health there. */
      function expectDurableAlarm(scheduler: SchedulerMetrics, jobType: string): void {
        expect(scheduler.globalScheduleHealthError).toBeNull();
        expect(scheduler.globalBreakersTripped).toContain(jobType);
        const snapshot = scheduler.globalSchedules.find((s) => s.jobType === jobType);
        expect(snapshot).toBeDefined();
        expect(snapshot!.status).toBe('breaker_tripped');
        expect(snapshot!.missedRuns).toBeGreaterThanOrEqual(29);
      }

      it('curl /healthz on a brand-new process reports the breaker that a DEAD process tripped', async () => {
        const schedule = await stoppedSchedule();
        const worker = await bootWorkerProcess(false);
        try {
          const scheduler = await awaitDurableHealth(worker, false);
          expectDurableAlarm(scheduler, schedule.jobType);
          // The tick counters are exactly what they were at BASELINE — this process really
          // has done no work and witnessed nothing. Every word above came from the database.
          // It is ALSO what identifies the path taken: ticks===0 means tickOnce never ran, so
          // the health above can only have come from the DIRECT refresh on the boot branch.
          expect(scheduler.ticks).toBe(0);
          expect(scheduler.lastGlobalEnqueueCount).toBe(0);
        } finally {
          worker.stop();
        }
      }, 60_000);

      // ── THE PATH PRODUCTION ACTUALLY TAKES ────────────────────────────────────────────
      // worker/src/index.ts starts the scheduler with no `immediate` argument, and the
      // default is TRUE — so every real worker reports durable health from the TRAILING
      // refresh at the end of tickOnce, never from the direct call the test above pins.
      // Until this case existed, deleting that trailing refresh left the entire db lane
      // green, INCLUDING the restart proof above, while a restarted production worker
      // reported a clean bill of health over a stopped compliance purge. The only other
      // guard on it is a MOCKED pool (tests/scheduler/reconcile-wiring.test.ts); this is the
      // real process, real socket, real database version of the same question.
      it('the same is true of the boot path PRODUCTION uses — immediate:true, health from the trailing refresh', async () => {
        const schedule = await stoppedSchedule();
        const restoreSources = await parkDueTieredSources();
        const worker = await bootWorkerProcess(true);
        try {
          const scheduler = await awaitDurableHealth(worker, true);
          expectDurableAlarm(scheduler, schedule.jobType);
          // ticks===1 is the proof this really is the OTHER path: the boot tick ran, so the
          // direct refresh was never called and every field above came out of tickOnce's
          // trailing read. A child that silently fell back to immediate:false fails here.
          expect(scheduler.ticks).toBe(1);
          // …and it enqueued nothing while doing it. Both halves are the contract of
          // parkDueTieredSources(): if a due source or an armed global schedule survives
          // into this test, it fails HERE rather than dispatching a live job off the shared
          // queue behind the assertion.
          expect(scheduler.lastEnqueueCount).toBe(0);
          expect(scheduler.lastGlobalEnqueueCount).toBe(0);
        } finally {
          worker.stop();
          await restoreSources();
        }
      }, 60_000);
    });
  });

  // ── ACCEPTANCE F ──────────────────────────────────────────────────────────────────────
  describe('F — a disabled schedule enqueues nothing, ever', () => {
    it('migration 0028 SHIPS corrections_retention disabled', () => {
      // Captured in beforeAll, before any test in this file could have flipped it. Enabling
      // it arms permanent deletion of user correction reports; that is a deliberate,
      // reversible operator act and explicitly not the migration's to take.
      expect(shippedRetention).not.toBeNull();
      expect(shippedRetention!.enabled).toBe(false);
    });

    it('a disabled, overdue schedule produces NO job and NO ledger row', async () => {
      const schedule = shippedRetention!;
      await query(
        `UPDATE global_job_schedule SET enabled = false, next_run_at = now() - interval '30 days' WHERE id = $1`,
        [schedule.id]
      );
      const expired = await insertReport(-30);

      expect(await tickFor(schedule.id)).toHaveLength(0);
      expect(await jobsOfType(RETENTION_JOB_TYPE)).toHaveLength(0);
      expect(await runsOf(schedule.id)).toHaveLength(0);

      // And nothing was deleted — the whole reason the flag matters.
      expect(await reportIds()).toEqual([expired]);
    });

    it('stays silent across repeated ticks, including one that also has work to do', async () => {
      const retention = shippedRetention!;
      await query(
        `UPDATE global_job_schedule SET enabled = false, next_run_at = now() - interval '30 days' WHERE id = $1`,
        [retention.id]
      );
      // A second, ENABLED schedule on the same tick, so "nothing was enqueued" cannot pass
      // vacuously because the producer simply did not run.
      const live = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });

      for (let i = 0; i < 3; i += 1) {
        const { enqueued } = await enqueueDueGlobalJobs(getPool());
        expect(enqueued.every((e) => e.jobType !== RETENTION_JOB_TYPE)).toBe(true);
        await query(`UPDATE global_job_run SET finished_at = now(), outcome = 'success'
                      WHERE schedule_id = $1 AND finished_at IS NULL`, [live.id]);
        await makeDue(live.id);
      }
      expect(await jobsOfType(RETENTION_JOB_TYPE)).toHaveLength(0);
      expect(await runsOf(retention.id)).toHaveLength(0);
      expect((await runsOf(live.id)).length).toBeGreaterThan(0); // the tick really ran
    });

    // ── the SECOND shipped schedule: stale_occurrence_flip (migration 0029) ────────────
    it('migration 0029 SHIPS stale_occurrence_flip disabled, daily, with an explicit breaker limit', () => {
      // Captured in beforeAll, before any test in this file could have touched it.
      // Registering the handler (worker/core/job-handlers.ts) is the CAPABILITY; this flag
      // is the ENABLEMENT. Turning it on mutates real activity_occurrence rows on the public
      // search surface, which is a decision the migration deliberately does not take.
      expect(shippedStaleFlip).not.toBeNull();
      expect(shippedStaleFlip!.enabled).toBe(false);
      expect(shippedStaleFlip!.cadenceSeconds).toBe(86_400);
      // Written explicitly in 0029 rather than inherited from the column default, so a
      // future change to that default cannot silently move this job's breaker limit.
      expect(shippedStaleFlip!.maxConsecutiveFailures).toBe(3);
    });

    it('a disabled, overdue stale_occurrence_flip produces NO job, NO ledger row, and demotes NOTHING', async () => {
      const schedule = shippedStaleFlip!;
      await query(
        `UPDATE global_job_schedule SET enabled = false, next_run_at = now() - interval '30 days' WHERE id = $1`,
        [schedule.id]
      );
      // A row the flip WOULD demote: this file's source takes baseline_cadence's 1-day
      // default (migration 0003) and STALE_CADENCE_GRACE is 2, so 3 days is past threshold.
      const [victim] = await query<{ id: string }>(
        `INSERT INTO activity_occurrence
           (series_id, activity_name, start_datetime_utc, status_state, confidence_label, last_checked_at)
         VALUES ($1, $2, now() + interval '30 days', 'confirmed', 'unscored', now() - interval '3 days')
         RETURNING id`,
        [seriesId, `${tag} would-be-demoted`]
      );
      try {
        expect(await tickFor(schedule.id)).toHaveLength(0);
        expect(await jobsOfType(STALE_FLIP_JOB_TYPE)).toHaveLength(0);
        expect(await runsOf(schedule.id)).toHaveLength(0);

        // ── TEETH ────────────────────────────────────────────────────────────────────
        // And nothing was demoted — the whole reason the flag matters. Flip `enabled` to
        // true in 0029 and this assertion is what goes red.
        const [after] = await query<{ status_state: string }>(
          `SELECT status_state FROM activity_occurrence WHERE id = $1`,
          [victim.id]
        );
        expect(after.status_state).toBe('confirmed');
      } finally {
        await query(`DELETE FROM activity_occurrence WHERE id = $1`, [victim.id]);
      }
    });
  });
});
