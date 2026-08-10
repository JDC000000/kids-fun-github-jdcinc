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
// exactly one transaction gets a row back, and only that one goes on to enqueue. Deleting
// either index (or the ON CONFLICT) is what tests/scheduler/global-jobs-db.test.ts's
// concurrency case is aimed at.
//
// LOSING IS NOT ONE OUTCOME, THOUGH, AND TREATING IT AS ONE WEDGED THE SCHEDULE. Losing on
// the in-flight index is normal and correct; losing on the SLOT index means next_run_at
// points at an instant that has already been served, which no number of retries can fix.
// resolveClaimConflict() below tells the two apart and is where the reasoning lives.
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
  /**
   * ⚠ CADENCE SLOTS THAT WILL NEVER GET A RUN. Read this before you register a new job_type.
   *
   * The advance below jumps next_run_at to the first slot in the FUTURE, so one run is
   * produced for the OLDEST missed slot and every slot in between is DROPPED — after a
   * 30-day outage of a daily job this is 30, and only the 31st is executed.
   *
   * That is correct ONLY for a LEVEL-TRIGGERED job — one whose single run brings the world
   * to the desired state regardless of how long it was away. `corrections_retention` is:
   * it deletes everything already past retained_until, so 30 replays would be 29 no-ops.
   *
   * For an EDGE-TRIGGERED job — one where each slot has its OWN work (send the Tuesday
   * digest, bill the January period, snapshot yesterday's counters) — this silently
   * destroys work. If your job is edge-triggered, DO NOT put it on this producer without
   * first replacing the jump with a per-slot catch-up loop. The count is surfaced here, in
   * the tick's WARN log and in SchedulerMetrics.totalGlobalSlotsSkipped so the loss is
   * visible rather than inferred; visibility is not permission.
   *
   * 0 on an on-time run.
   */
  skippedSlots: number;
}

/**
 * One schedule the tick found DUE but could not claim, and why.
 *
 * `slot_already_served` is the only outcome that also moves next_run_at — see the claim
 * block below for why leaving it put would have wedged the schedule permanently.
 */
export interface SkippedGlobalSchedule {
  jobType: string;
  scheduleId: string;
  /** The due instant that could not be claimed. */
  scheduledFor: Date;
  reason: GlobalClaimConflict;
  /** Where next_run_at was moved to, for 'slot_already_served'. Null when it was left put. */
  nextRunAt: Date | null;
  /** Cadence slots jumped over by that move — see EnqueuedGlobalJob.skippedSlots. Null when
   *  next_run_at was left put, because nothing was jumped over. */
  skippedSlots: number | null;
}

/**
 * Why a due schedule produced no run.
 *
 *  • `run_in_flight`        — a previous run of this schedule is still open (or a sibling
 *    tick claimed this instant a moment ago). The schedule stays DUE and the next tick
 *    tries again; this is the level-triggered design working, not a fault.
 *  • `slot_already_served`  — the ledger already holds a run for this exact due instant, so
 *    the slot unique index will reject it on this tick and on every tick after it. Retrying
 *    is not a recovery strategy, it is the wedge. next_run_at is advanced past the served
 *    slot instead, loudly.
 */
export type GlobalClaimConflict = 'run_in_flight' | 'slot_already_served';

/** What one tick of the global producer did. */
export interface GlobalTickResult {
  enqueued: EnqueuedGlobalJob[];
  /** Due schedules that produced no run this tick. Empty on a quiet, healthy tick. */
  skipped: SkippedGlobalSchedule[];
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
 * Move next_run_at to the first slot STRICTLY IN THE FUTURE, by whole cadence periods —
 * but ONLY while the instant it currently points at is both DUE and ALREADY SERVED.
 *
 * Written once and used by BOTH callers below — the one that just enqueued a run for that
 * instant, and the one that un-wedges a schedule pointing at an instant some earlier run
 * already served. Two spellings of "where does this schedule go next" are two things that
 * can disagree, and a disagreement here is a schedule that stops.
 *
 * ── THE GUARD IS `next_run_at <= now()`, NOT `next_run_at = <the value we read>` ─────────
 * The obvious guard — echoing the due instant back as a parameter — silently never matches.
 * node-postgres parses timestamptz into a JS Date, which has MILLISECOND resolution, so a
 * next_run_at carrying microseconds comes back truncated and no longer equals itself. A
 * guard that can never be satisfied turns this into a no-op and stops the schedule: the
 * exact failure it was written to prevent. (Measured, not reasoned: it failed 17 tests.)
 *
 * `next_run_at <= now()` is exact at any precision, always true for both callers (each is
 * inside the transaction that SELECTed this row as due, and now() is fixed for the whole
 * transaction), and makes the statement idempotent if the row lock above is ever removed —
 * a sibling that advanced first leaves next_run_at in the future, so this matches nothing
 * instead of advancing a second period past a value this caller never saw.
 *
 * ── PHASE, HONESTLY. THIS COMMENT USED TO SAY "A DAILY JOB STAYS ON ITS HOUR". IT DOESN'T ─
 * The advance is `next_run_at + cadence * n` with cadence an INTERVAL, so day-arithmetic is
 * DST-aware IN THE DATABASE SESSION'S TimeZone — and that is `Etc/UTC` here (measured on
 * the deployed configuration with `SHOW TimeZone`, not assumed). UTC has no DST, so
 * `interval '1 day'` is exactly 24 hours and a daily job holds a FIXED UTC INSTANT forever.
 *
 * A fixed UTC instant is NOT a fixed local hour, because America/Vancouver observes DST.
 * Measured across the 2027 spring-forward: 2027-03-13 11:00Z + 1 day = 2027-03-14 11:00Z,
 * which is 03:00 local before and 04:00 local after. The local hour therefore shifts ±1h at
 * each transition. It OSCILLATES rather than accumulating — the job does not drift away —
 * and it is harmless for `corrections_retention`, which only needs to run about once a day.
 *
 * IT IS NOT HARMLESS FOR AN HOUR-SENSITIVE JOB. "Run at 06:00 local, before the site wakes
 * up" is not something this producer can promise, and a job written on the strength of the
 * old comment would silently run an hour early or late for half the year. Such a job needs
 * its due instant recomputed in an explicit zone (date_trunc AT TIME ZONE
 * 'America/Vancouver'), not a fixed-interval add. (Setting the session TimeZone to
 * Vancouver would fix the local hour and break the UTC instant instead — for the same
 * example the step becomes 23 hours. There is no setting that gives you both.)
 */
const ADVANCE_NEXT_RUN_AT_SQL = `
  UPDATE global_job_schedule s
     SET last_run_at = CASE WHEN $2::boolean THEN now() ELSE s.last_run_at END,
         next_run_at = s.next_run_at
                       + s.cadence * (
                           floor(
                             EXTRACT(EPOCH FROM (now() - s.next_run_at))
                             / EXTRACT(EPOCH FROM s.cadence)
                           ) + 1
                         )
    FROM (
      SELECT id, next_run_at AS was_due_at, cadence
        FROM global_job_schedule
       WHERE id = $1
    ) prev
   WHERE s.id = prev.id
     AND s.next_run_at <= now()
  RETURNING prev.was_due_at,
            s.next_run_at,
            GREATEST(
              0,
              floor(
                EXTRACT(EPOCH FROM (now() - prev.was_due_at)) / EXTRACT(EPOCH FROM prev.cadence)
              )
            )::int AS skipped_slots`;

interface AdvancedRow {
  /** The due instant that was left behind — a PRE-update snapshot from the `prev` CTE,
   *  because RETURNING sees the new row and would report where it went, not where it was. */
  was_due_at: Date;
  next_run_at: Date;
  skipped_slots: number;
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
): Promise<GlobalTickResult> {
  const workerId = opts.workerId ?? resolveWorkerId();
  const client: PoolClient = await pool.connect();
  const enqueued: EnqueuedGlobalJob[] = [];
  const skipped: SkippedGlobalSchedule[] = [];
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
      // THE CLAIM. One row back = this transaction owns the run; zero rows = a conflict,
      // and WHICH conflict decides whether the schedule may be left where it is.
      const { rows: claimed } = await client.query<{ id: string }>(
        `INSERT INTO global_job_run (schedule_id, scheduled_for, enqueued_by)
              VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
           RETURNING id`,
        [schedule.id, schedule.next_run_at, workerId]
      );
      if (claimed.length === 0) {
        skipped.push(await resolveClaimConflict(client, schedule));
        continue;
      }
      const runId = claimed[0].id;

      const jobId = await enqueue(
        client,
        null,
        schedule.job_type,
        new Date(),
        GLOBAL_JOB_MAX_ATTEMPTS
      );
      await client.query(`UPDATE global_job_run SET job_id = $2 WHERE id = $1`, [runId, jobId]);

      // Advance to the first slot in the future, SKIPPING the slots an outage missed rather
      // than replaying them: the purge is level-triggered — it removes everything already
      // past retained_until — so running it 30 times to "catch up" 30 missed days would do
      // 29 no-ops. The skip is not swept under the carpet: `skipped_slots` counts it here,
      // the caller logs it, and the gap also stays derivable from the ledger by
      // readGlobalJobScheduleHealth(). See EnqueuedGlobalJob.skippedSlots before putting an
      // EDGE-triggered job type on this producer. Phase semantics: ADVANCE_NEXT_RUN_AT_SQL.
      const { rows: advanced } = await client.query<AdvancedRow>(ADVANCE_NEXT_RUN_AT_SQL, [
        schedule.id,
        true,
      ]);

      const advance = advanced[0];
      if (!advance) {
        // Unreachable: the run this transaction just inserted satisfies the statement's
        // EXISTS, and now() is fixed for the transaction so `next_run_at <= now()` holds
        // exactly as it did in the SELECT above. It is checked anyway because the
        // alternative to noticing is COMMITTING a run whose schedule was never moved on —
        // a claimed slot that stays due. Throwing rolls the whole tick back, so the next
        // tick starts from a consistent row rather than from half of one.
        throw new Error(
          `global schedule ${schedule.job_type} (${schedule.id}) did not advance past ` +
            `${schedule.next_run_at.toISOString()} after its run was claimed`
        );
      }

      enqueued.push({
        jobType: schedule.job_type,
        scheduleId: schedule.id,
        runId,
        jobId,
        scheduledFor: schedule.next_run_at,
        nextRunAt: advance.next_run_at,
        skippedSlots: advance.skipped_slots,
      });
    }

    await client.query('COMMIT');
    return { enqueued, skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Decide what a ZERO-ROW claim means, and un-wedge the schedule if it is the fatal kind.
 *
 * ── THE BUG THIS REPLACES ───────────────────────────────────────────────────────────────
 * This used to be a bare `continue`, which skipped the next_run_at advance for BOTH
 * conflicts. That is right for one of them and PERMANENTLY FATAL for the other:
 *
 *   • `run_in_flight` — a previous run of this schedule is still open, or a sibling tick
 *     claimed this instant a moment ago. Leaving next_run_at alone is CORRECT: the schedule
 *     stays due, the next tick tries again, and it becomes claimable the moment the run
 *     closes (or worker/core/reconcile.ts releases it). Level-triggered, never a backlog.
 *
 *   • `slot_already_served` — the ledger already holds a run for this EXACT due instant.
 *     idx_global_job_run_slot will reject the insert on this tick and on every tick that
 *     ever follows, so "stay due and retry" is not a recovery strategy, it is a schedule
 *     that never runs again while reporting the benign status 'due'. Reachable by an
 *     operator hand-edit of next_run_at, a database restore, or a clock rewind — i.e.
 *     precisely the situations in which a silent permanent stop is least affordable.
 *     Recovery is to advance PAST the served slot, which is what happens here.
 *
 * The discriminator is a plain existence check on (schedule_id, scheduled_for) — the very
 * pair idx_global_job_run_slot is unique on — and it runs INSIDE the tick's transaction, so
 * it cannot see another tick's uncommitted claim. A slot being claimed right now by a
 * sibling therefore reads as `run_in_flight` (leave it alone, the sibling will advance it),
 * which is the safe way round.
 */
async function resolveClaimConflict(
  client: PoolClient,
  schedule: DueScheduleRow
): Promise<SkippedGlobalSchedule> {
  // THE PARAMETER IS THE ONE THE FAILED INSERT USED, and that is the whole point: this asks
  // idx_global_job_run_slot's own question, against its own two columns, with the same
  // value it just rejected. `scheduled_for` is written from this JS-side Date (millisecond
  // resolution), NOT from the schedule row's timestamptz (microsecond), so comparing
  // against `global_job_schedule.next_run_at` instead would look right and quietly answer a
  // different question about a value a few microseconds away.
  const { rows } = await client.query<{ slot_already_served: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM global_job_run
        WHERE schedule_id = $1 AND scheduled_for = $2::timestamptz
     ) AS slot_already_served`,
    [schedule.id, schedule.next_run_at]
  );

  const base = {
    jobType: schedule.job_type,
    scheduleId: schedule.id,
    scheduledFor: schedule.next_run_at,
  };
  // Check-then-act is safe HERE and nowhere else in this module: the act is moving a due
  // instant on a row this transaction holds a FOR UPDATE lock on, and the thing that must
  // not race — creating a second run — was already decided by the unique index above. The
  // worst outcome of a stale read is a misclassified log line.
  if (!rows[0].slot_already_served) {
    return { ...base, reason: 'run_in_flight', nextRunAt: null, skippedSlots: null };
  }

  // `false` = do NOT stamp last_run_at: nothing ran here, only the due instant moves.
  const { rows: advanced } = await client.query<AdvancedRow>(ADVANCE_NEXT_RUN_AT_SQL, [
    schedule.id,
    false,
  ]);
  return {
    ...base,
    reason: 'slot_already_served',
    nextRunAt: advanced[0]?.next_run_at ?? null,
    skippedSlots: advanced[0]?.skipped_slots ?? null,
  };
}
