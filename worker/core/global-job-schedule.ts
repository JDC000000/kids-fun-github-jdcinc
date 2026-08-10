// worker/core/global-job-schedule.ts — durable state for GLOBAL (source-less) scheduled
// jobs: the schedule, the run ledger, the circuit breaker, and the read-time health view.
//
// The producer that turns a due schedule into a job_queue row lives in
// worker/scheduler/global-jobs.ts, mirroring the existing split (worker/scheduler/tiered.ts
// is the per-source producer; worker/core/queue.ts holds the queue primitives it uses).
// This module owns the SQL that touches global_job_schedule / global_job_run and nothing
// else, so there is exactly one place where the lock, the breaker and the ledger are
// spelled out. Schema and the full rationale: supabase/migrations/0028_global_job_schedule.sql.
//
// EVERY GUARANTEE HERE IS THE DATABASE'S, NOT THE APPLICATION'S. The in-flight lock is a
// partial UNIQUE INDEX (idx_global_job_run_in_flight); the slot lock is a UNIQUE INDEX
// (idx_global_job_run_slot); the failure counter and the breaker trip inside the same
// statement that closes the run. There is no read-then-write anywhere in this file that a
// second process could interleave with, because that pattern is exactly what produces the
// duplicate purge this whole unit exists to prevent.
import type { Pool, PoolClient } from 'pg';

/** Anything that can run a query — a Pool, or a PoolClient inside a transaction. The
 *  producer's tick runs its whole claim inside one transaction, so its statements arrive
 *  on a client, not on the pool. */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Terminal states a ledger row can be closed in. */
export type GlobalJobRunOutcome = 'success' | 'failure' | 'abandoned';

/**
 * How many cadence periods may elapse with no ledger row before the reader calls it a
 * MISS. 1 = the slot that is currently due is not yet "missed" — a tick may simply not
 * have fired in the last few seconds. Anything older than that had a whole cadence to be
 * produced and was not.
 */
export const MISSED_RUN_GRACE_PERIODS = 1;

/**
 * The breaker's trip condition, written ONCE and reused by every statement that applies an
 * outcome, so the producer's stop predicate and the two writers can never disagree.
 *
 * It reads `t.*` — a PRE-UPDATE snapshot of the schedule row taken in a sibling CTE —
 * never the row being updated, because `RETURNING` and later CTE stages see the NEW values
 * and would report "tripped now" as false on the very statement that tripped it.
 *
 * `t.breaker_tripped_at IS NULL` keeps it a ONE-TIME transition: an already-open breaker
 * does not re-stamp its trip time, so the recorded moment stays the moment it broke.
 */
const BREAKER_TRIPS_NOW_SQL = `(t.outcome <> 'success'
  AND t.breaker_tripped_at IS NULL
  AND t.consecutive_failures + 1 >= t.max_consecutive_failures)`;

/**
 * Apply one run outcome to its schedule: reset-or-increment the consecutive-failure count
 * and trip the breaker if this outcome crosses the limit.
 *
 * Shared by finishGlobalJobRun() and the reconcile sweep so the accounting exists once.
 * Expects a CTE named `closed` yielding (schedule_id, outcome), and produces the columns
 * job_type / consecutive_failures / max_consecutive_failures / breaker_tripped /
 * breaker_tripped_now.
 *
 * `$BREAKER_REASON` is the caller's parameter placeholder for the reason text.
 */
function applyOutcomeSql(breakerReasonParam: string): string {
  return `,
     target AS (
       SELECT s.id,
              s.job_type,
              s.consecutive_failures,
              s.max_consecutive_failures,
              s.breaker_tripped_at,
              c.outcome
         FROM global_job_schedule s
         JOIN closed c ON c.schedule_id = s.id
     ),
     applied AS (
       UPDATE global_job_schedule s
          SET consecutive_failures = CASE WHEN t.outcome = 'success'
                                          THEN 0 ELSE t.consecutive_failures + 1 END,
              last_success_at      = CASE WHEN t.outcome = 'success'
                                          THEN now() ELSE s.last_success_at END,
              breaker_tripped_at   = CASE WHEN ${BREAKER_TRIPS_NOW_SQL}
                                          THEN now() ELSE t.breaker_tripped_at END,
              breaker_reason       = CASE WHEN ${BREAKER_TRIPS_NOW_SQL}
                                          THEN ${breakerReasonParam} ELSE s.breaker_reason END
         FROM target t
        WHERE s.id = t.id
       RETURNING s.id,
                 s.job_type,
                 s.consecutive_failures,
                 s.max_consecutive_failures,
                 (s.breaker_tripped_at IS NOT NULL) AS breaker_tripped
     )
     SELECT a.job_type,
            a.consecutive_failures,
            a.max_consecutive_failures,
            a.breaker_tripped,
            t.outcome,
            (t.breaker_tripped_at IS NULL AND a.breaker_tripped) AS breaker_tripped_now
       FROM applied a
       JOIN target t ON t.id = a.id`;
}

/** A schedule's health as a reader can determine it from stored state ALONE. */
export type GlobalJobScheduleStatus =
  /** Not enabled. Cannot be due, cannot miss. */
  | 'disabled'
  /** The breaker is open. Deliberately not being enqueued; needs an explicit reset. */
  | 'breaker_tripped'
  /** Cadence slots went by with no ledger row. Derived, never written — see below. */
  | 'missed'
  /** A run is open (enqueued, or claimed and not yet finished). */
  | 'running'
  /** Past next_run_at with nothing open — the next tick will enqueue it. */
  | 'due'
  /** Enabled, on cadence, nothing outstanding. */
  | 'ok';

export interface GlobalJobScheduleHealth {
  scheduleId: string;
  jobType: string;
  enabled: boolean;
  cadenceSeconds: number;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  breakerTrippedAt: Date | null;
  breakerReason: string | null;
  /** Newest slot the LEDGER actually holds a row for (null = never run). */
  lastRunSlot: Date | null;
  /** True while a ledger row is open — i.e. the in-flight lock is held. */
  inFlight: boolean;
  /**
   * Cadence slots that came due and produced NO ledger row. Derived at read time from
   * cadence + the absence of rows, so it is computable with the entire worker fleet dead;
   * that is the whole point (see the module header and migration 0028).
   */
  missedRuns: number;
  status: GlobalJobScheduleStatus;
  /** The DATABASE's clock at the moment of the read. Every comparison above is made
   *  against this, not against the reader process's clock. */
  observedAt: Date;
}

interface HealthRow {
  schedule_id: string;
  job_type: string;
  enabled: boolean;
  cadence_seconds: number;
  next_run_at: Date;
  last_run_at: Date | null;
  last_success_at: Date | null;
  consecutive_failures: number;
  max_consecutive_failures: number;
  breaker_tripped_at: Date | null;
  breaker_reason: string | null;
  last_run_slot: Date | null;
  in_flight: boolean;
  missed_runs: number;
  observed_at: Date;
}

/**
 * Read every global schedule's health.
 *
 * PURE SELECT. Nothing is written, nothing is claimed, no process has to be alive. This is
 * the accepted A3 design ruling made concrete: a MISSED run is DERIVED by the reader from
 * cadence and the absence of a ledger row, never flagged by the worker when it notices it
 * fell behind. A worker that has been killed — Fly's kill_timeout is 5 SECONDS — writes
 * nothing at all, and that is precisely the case an operator needs to see.
 *
 * THE DERIVATION. Anchor on the newest slot the ledger holds for the schedule, or on the
 * schedule's creation if it has never run. `floor(elapsed / cadence)` slots have come due
 * since that anchor; MISSED_RUN_GRACE_PERIODS of them are forgiven (the currently-due slot
 * is "due", not yet "missed") and the rest are misses. A schedule that has been running
 * normally anchors a few seconds ago and derives 0.
 */
export async function readGlobalJobScheduleHealth(
  db: Queryable,
  opts: { jobType?: string } = {}
): Promise<GlobalJobScheduleHealth[]> {
  const { rows } = await db.query<HealthRow>(
    `SELECT
       s.id                                       AS schedule_id,
       s.job_type,
       s.enabled,
       EXTRACT(EPOCH FROM s.cadence)::float8      AS cadence_seconds,
       s.next_run_at,
       s.last_run_at,
       s.last_success_at,
       s.consecutive_failures,
       s.max_consecutive_failures,
       s.breaker_tripped_at,
       s.breaker_reason,
       led.last_slot                              AS last_run_slot,
       COALESCE(led.open_runs, 0) > 0             AS in_flight,
       CASE
         WHEN NOT s.enabled THEN 0
         ELSE GREATEST(
                0,
                LEAST(
                  1000000,
                  floor(
                    EXTRACT(EPOCH FROM (now() - COALESCE(led.last_slot, s.created_at)))
                    / EXTRACT(EPOCH FROM s.cadence)
                  ) - $2::int
                )
              )::int
       END                                        AS missed_runs,
       now()                                      AS observed_at
     FROM global_job_schedule s
     LEFT JOIN LATERAL (
       SELECT max(r.scheduled_for)                               AS last_slot,
              count(*) FILTER (WHERE r.finished_at IS NULL)::int AS open_runs
         FROM global_job_run r
        WHERE r.schedule_id = s.id
     ) led ON TRUE
     WHERE ($1::text IS NULL OR s.job_type = $1::text)
     ORDER BY s.job_type`,
    [opts.jobType ?? null, MISSED_RUN_GRACE_PERIODS]
  );

  return rows.map((r) => {
    const health: Omit<GlobalJobScheduleHealth, 'status'> = {
      scheduleId: r.schedule_id,
      jobType: r.job_type,
      enabled: r.enabled,
      cadenceSeconds: Number(r.cadence_seconds),
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastSuccessAt: r.last_success_at,
      consecutiveFailures: r.consecutive_failures,
      maxConsecutiveFailures: r.max_consecutive_failures,
      breakerTrippedAt: r.breaker_tripped_at,
      breakerReason: r.breaker_reason,
      lastRunSlot: r.last_run_slot,
      inFlight: r.in_flight,
      missedRuns: r.missed_runs,
      observedAt: r.observed_at,
    };
    return { ...health, status: resolveStatus(health) };
  });
}

function resolveStatus(h: Omit<GlobalJobScheduleHealth, 'status'>): GlobalJobScheduleStatus {
  if (!h.enabled) return 'disabled';
  // Both halves of the stop condition are checked, matching the producer's predicate
  // exactly: clearing one without the other must not silently re-arm the schedule.
  if (h.breakerTrippedAt !== null || h.consecutiveFailures >= h.maxConsecutiveFailures) {
    return 'breaker_tripped';
  }
  // A gap outranks "something is running now" — the operator needs to see the gap even
  // while a catch-up run is in flight.
  if (h.missedRuns > 0) return 'missed';
  if (h.inFlight) return 'running';
  if (h.nextRunAt.getTime() <= h.observedAt.getTime()) return 'due';
  return 'ok';
}

export interface AppliedOutcome {
  jobType: string;
  outcome: GlobalJobRunOutcome;
  /** consecutive_failures AFTER this outcome was applied. */
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  /** True once the breaker is open. */
  breakerTripped: boolean;
  /** True only on the statement that TRIPPED it — the one escalation worth shouting about. */
  breakerTrippedNow: boolean;
}

interface AppliedOutcomeRow {
  job_type: string;
  outcome: GlobalJobRunOutcome;
  consecutive_failures: number;
  max_consecutive_failures: number;
  breaker_tripped: boolean;
  breaker_tripped_now: boolean;
}

function toAppliedOutcome(r: AppliedOutcomeRow): AppliedOutcome {
  return {
    jobType: r.job_type,
    outcome: r.outcome,
    consecutiveFailures: r.consecutive_failures,
    maxConsecutiveFailures: r.max_consecutive_failures,
    breakerTripped: r.breaker_tripped,
    breakerTrippedNow: r.breaker_tripped_now,
  };
}

function breakerReasonFor(outcome: GlobalJobRunOutcome, error: string | null): string {
  const detail = error && error.trim() !== '' ? error.trim() : 'no error message recorded';
  return `${outcome}: ${detail}`;
}

/**
 * Close the ledger row carried by `jobId` and apply its outcome to the schedule, in ONE
 * statement.
 *
 * Matches nothing (returns null) for an ordinary per-source ingest job, which has no
 * ledger row — so the caller can invoke it unconditionally for every job it finalises
 * rather than branching on a guess about which jobs are global.
 *
 * FAILURE ACCOUNTING AND THE BREAKER LIVE IN THIS STATEMENT, not in a follow-up query,
 * because "increment, read back, maybe trip" as separate statements is a race: two
 * failures finishing at once would each read the pre-increment count and neither would trip.
 */
export async function finishGlobalJobRun(
  db: Queryable,
  jobId: string,
  outcome: GlobalJobRunOutcome,
  error: string | null
): Promise<AppliedOutcome | null> {
  const { rows } = await db.query<AppliedOutcomeRow>(
    `WITH closed AS (
       UPDATE global_job_run r
          SET finished_at = now(),
              outcome     = $2::text,
              error       = $3::text,
              claimed_by  = COALESCE(r.claimed_by, src.locked_by)
         FROM (
           SELECT r2.id, jq.locked_by
             FROM global_job_run r2
             LEFT JOIN job_queue jq ON jq.id = r2.job_id
            WHERE r2.job_id = $1::uuid
              AND r2.finished_at IS NULL
         ) src
        WHERE r.id = src.id
       RETURNING r.schedule_id, r.outcome
     )${applyOutcomeSql('$4::text')}`,
    [jobId, outcome, error, breakerReasonFor(outcome, error)]
  );
  return rows.length === 0 ? null : toAppliedOutcome(rows[0]);
}

/**
 * Record that a worker has CLAIMED the queue job carrying a ledger run.
 *
 * Unconditional per claimed job by design: for an ingest job it matches zero rows. The
 * alternative — branching on `sourceId === null` — is a heuristic about what "global"
 * means, and heuristics about job identity are exactly what Unit 1 had to fix.
 */
export async function claimGlobalJobRun(
  db: Queryable,
  jobId: string,
  workerId: string
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE global_job_run
        SET started_at = COALESCE(started_at, now()),
            claimed_by = $2::text
      WHERE job_id = $1::uuid
        AND finished_at IS NULL`,
    [jobId, workerId]
  );
  return (rowCount ?? 0) > 0;
}

export interface ReconcileGlobalRunsResult {
  /** Runs closed as 'abandoned' — their in-flight lock is released and the failure counted. */
  abandoned: number;
  /** Runs whose job had already reached 'done' before the process died: the work really
   *  happened, so they close as 'success' and do NOT count against the breaker. */
  resolvedSuccessful: number;
  /** Job types whose breaker this sweep tripped. One escalation each, not a stream. */
  breakersTripped: string[];
}

export const ABANDONED_GLOBAL_RUN_ERROR =
  'abandoned: worker process died while this scheduled run was in flight ' +
  '(reclaimed by reconcileAbandonedRuns)';

/**
 * Release ledger runs whose holder is gone.
 *
 * THIS IS WHAT STOPS THE FEATURE DYING QUIETLY. The in-flight lock
 * (idx_global_job_run_in_flight) is what makes a duplicate purge impossible; the same
 * property means a run that is never finished blocks its schedule FOREVER. Fly's default
 * kill_timeout is 5 seconds, so a machine dying mid-run is routine, not exotic. Without
 * this sweep the first crash would silently retire the schedule and nothing would report
 * it — the failure mode this project has already shipped once.
 *
 * The outcome is not assumed. If the queue row reached 'done' before the process died, the
 * work DID happen and recording it as a failure would walk the breaker toward tripping on
 * successful runs; that case closes as 'success'. Everything else closes as 'abandoned'
 * and counts, because a job that keeps killing its worker is exactly what the breaker is
 * for.
 *
 * Called only from worker/core/reconcile.ts, so the scheduler keeps ONE sweep entry point.
 */
export async function reconcileAbandonedGlobalJobRuns(
  db: Queryable,
  thresholdSeconds: number
): Promise<ReconcileGlobalRunsResult> {
  const { rows } = await db.query<AppliedOutcomeRow>(
    `WITH closed AS (
       UPDATE global_job_run r
          SET finished_at = now(),
              outcome     = CASE WHEN src.job_status = 'done' THEN 'success' ELSE 'abandoned' END,
              error       = CASE WHEN src.job_status = 'done' THEN NULL ELSE $2::text END,
              claimed_by  = COALESCE(r.claimed_by, src.locked_by)
         FROM (
           SELECT r2.id, jq.status AS job_status, jq.locked_by
             FROM global_job_run r2
             LEFT JOIN job_queue jq ON jq.id = r2.job_id
            WHERE r2.finished_at IS NULL
              AND COALESCE(r2.started_at, r2.enqueued_at) < now() - make_interval(secs => $1)
         ) src
        WHERE r.id = src.id
       RETURNING r.schedule_id, r.outcome
     )${applyOutcomeSql('$2::text')}`,
    [thresholdSeconds, ABANDONED_GLOBAL_RUN_ERROR]
  );

  return {
    abandoned: rows.filter((r) => r.outcome === 'abandoned').length,
    resolvedSuccessful: rows.filter((r) => r.outcome === 'success').length,
    breakersTripped: rows.filter((r) => r.breaker_tripped_now).map((r) => r.job_type),
  };
}

export interface BreakerResetResult {
  jobType: string;
  /** What the breaker was stamped at BEFORE the reset (null = it was not tripped). */
  clearedTrippedAt: Date | null;
  /** The consecutive-failure count the reset discarded. */
  clearedFailures: number;
}

/**
 * Explicit operator recovery: clear a tripped breaker.
 *
 * DELIBERATELY NOT CALLED FROM ANY RUNTIME PATH. The breaker exists because a sibling
 * project's scheduler retried a failing job forever against an org spend limit; a breaker
 * that resets itself after a cooldown is that same loop with a longer period. Recovery
 * means someone decided the underlying fault is fixed.
 *
 * Clears BOTH halves of the stop condition, because the producer requires both to be clear
 * — resetting one and not the other would leave a schedule that looks recovered and never
 * runs. Returns null when there is no such schedule.
 */
export async function resetGlobalJobBreaker(
  db: Queryable,
  jobType: string
): Promise<BreakerResetResult | null> {
  const { rows } = await db.query<{
    job_type: string;
    cleared_tripped_at: Date | null;
    cleared_failures: number;
  }>(
    // The pre-reset values come from the CTE: RETURNING sees the NEW row, which is all
    // NULL/0 by construction, so it cannot say what was actually cleared.
    `WITH before AS (
       SELECT id, breaker_tripped_at, consecutive_failures
         FROM global_job_schedule
        WHERE job_type = $1::text
     )
     UPDATE global_job_schedule s
        SET breaker_tripped_at   = NULL,
            breaker_reason       = NULL,
            consecutive_failures = 0
       FROM before b
      WHERE s.id = b.id
     RETURNING s.job_type,
               b.breaker_tripped_at   AS cleared_tripped_at,
               b.consecutive_failures AS cleared_failures`,
    [jobType]
  );
  if (rows.length === 0) return null;
  return {
    jobType: rows[0].job_type,
    clearedTrippedAt: rows[0].cleared_tripped_at,
    clearedFailures: rows[0].cleared_failures,
  };
}
