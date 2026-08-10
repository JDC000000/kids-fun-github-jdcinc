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
// WHAT IT ARMS. The only registered global job today is 'corrections_retention', which
// PERMANENTLY DELETES user-submitted correction reports. That is why the disabled-row case
// (F) and the lock cases (B) get as much attention as the happy path: the schedule's
// `enabled` flag and the unique index are the two things standing between a bug here and
// real, unrecoverable deletions.
//
// Registered in DB_INTEGRATION_SUITES (vitest.workspace.ts). Like
// tests/scheduler/job-dispatch-db.test.ts it resets the GLOBAL job_queue table, because
// dequeue() claims the oldest due pending job table-wide.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, getPool, query } from '../../lib/db/client';
import { startScheduler } from '../../worker/src/scheduler';
import { enqueueDueGlobalJobs } from '../../worker/scheduler/global-jobs';
import { reconcileAbandonedRuns } from '../../worker/core/reconcile';
import {
  readGlobalJobScheduleHealth,
  resetGlobalJobBreaker,
} from '../../worker/core/global-job-schedule';

const hasDb = Boolean(process.env.DATABASE_URL);

const RETENTION_JOB_TYPE = 'corrections_retention';

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
  ): Promise<Awaited<ReturnType<typeof enqueueDueGlobalJobs>>> {
    const all = await enqueueDueGlobalJobs(pool, workerId ? { workerId } : {});
    return all.filter((e) => e.scheduleId === scheduleId);
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

    it('a FINISHED run still cannot be replayed at the same slot', async () => {
      const schedule = await makeSchedule({ cadenceSeconds: 3600, dueAt: 'now' });
      const [{ scheduledFor }] = await tickFor(schedule.id);
      await query(
        `UPDATE global_job_run SET finished_at = now(), outcome = 'success' WHERE schedule_id = $1`,
        [schedule.id]
      );
      // Rewind to the EXACT slot that already ran — a clock skew, a replayed tick, or an
      // operator rewinding next_run_at by hand.
      await query(`UPDATE global_job_schedule SET next_run_at = $2 WHERE id = $1`, [
        schedule.id,
        scheduledFor,
      ]);
      expect(await tickFor(schedule.id)).toHaveLength(0);
      expect(await runsOf(schedule.id)).toHaveLength(1);
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
        const enqueued = await enqueueDueGlobalJobs(getPool());
        expect(enqueued.every((e) => e.jobType !== RETENTION_JOB_TYPE)).toBe(true);
        await query(`UPDATE global_job_run SET finished_at = now(), outcome = 'success'
                      WHERE schedule_id = $1 AND finished_at IS NULL`, [live.id]);
        await makeDue(live.id);
      }
      expect(await jobsOfType(RETENTION_JOB_TYPE)).toHaveLength(0);
      expect(await runsOf(retention.id)).toHaveLength(0);
      expect((await runsOf(live.id)).length).toBeGreaterThan(0); // the tick really ran
    });
  });
});
