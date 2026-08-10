// worker/core/stale-occurrence-flip.ts — the `stale_occurrence_flip` queue job: the second
// GLOBAL (source-less) job type, and the durable scheduler's first tenant that was not
// written for the scheduler.
//
// WHAT IT IS. worker/health/stale.ts's flipStaleOccurrences() demotes every past-cadence,
// live-status, non-archived occurrence to status_state='stale'. It has existed since
// G-T15-4 and, until this file, HAD NO RUNTIME CALLER AT ALL — the only thing that ever
// invoked it was tests/health/stale.test.ts. This module is the caller, in the shape the
// global-job producer can schedule.
//
// WHY THIS JOB IS THE RIGHT SHAPE FOR THAT PRODUCER. worker/scheduler/global-jobs.ts jumps
// next_run_at to the first slot in the FUTURE, so missed slots are DROPPED, never replayed
// (see EnqueuedGlobalJob.skippedSlots there — it is the contract, and it is loud). That is
// safe only for LEVEL-TRIGGERED work, and this is level-triggered in the strongest sense
// available: the flip's predicate is a statement about the world RIGHT NOW
// (`last_checked_at < now() - cadence * grace`), not about the slot it is running for. One
// run after ten missed slots leaves nothing behind, because the tenth run would have
// selected a superset of what the first nine would have.
// tests/scheduler/job-dispatch-db.test.ts proves that with rows that went stale at three
// different ages and ONE run.
//
// IT IS ALSO IDEMPOTENT, and by construction rather than by luck: 'stale' is not a member
// of STALE_DEMOTE_FROM, so a row this job already flipped is not a candidate on the next
// run. Running it twice differs from running it once only in that the second run reports 0.
//
// ── WHAT A FAILURE HERE MEANS, AND WHY IT MUST NOT BE SWALLOWED ──────────────────────────
// This handler does not catch. That is the deliberate opposite of worker/core/reconcile.ts,
// whose sweep swallows its own errors because it is the RECOVERY mechanism and must never
// stop the tick. This job is ordinary work: if the UPDATE cannot run, the correct outcome
// is a failed job_queue row, a 'failure' ledger row, a consecutive-failure increment and —
// after enough of them — an open circuit breaker that stops the schedule until a human
// looks. Returning normally is a claim that the demotion was applied; making that claim
// falsely is precisely the silent-success failure this project has shipped before.
import type { Pool } from 'pg';
import { flipStaleOccurrences } from '../health/stale';
import type { Job } from './queue';

/**
 * The job_type this handler is registered under, and the value migration 0029 writes into
 * global_job_schedule.job_type. job_queue.job_type is free text with no CHECK (migration
 * 0011), so nothing in the database catches a typo between the two — the dispatcher's
 * UnknownJobTypeError does, loudly, at run time.
 */
export const STALE_OCCURRENCE_FLIP_JOB_TYPE = 'stale_occurrence_flip';

export interface StaleOccurrenceFlipHandlerOptions {
  /** Injectable for tests; defaults to console. */
  logger?: Pick<Console, 'log'>;
}

/**
 * Build the `stale_occurrence_flip` job handler.
 *
 * TAKES THE WORKER'S POOL, unlike makeCorrectionsRetentionJobHandler() next door — which
 * takes none because it calls a shared lib/ implementation that owns its own pool. There is
 * no such constraint here: flipStaleOccurrences() accepts a Pool, the registry builder
 * already holds the worker's, and passing it keeps this job on the connections the worker
 * is already accounted for.
 *
 * LOGS COUNTS, NOT ROWS. flipStaleOccurrences() returns the id of every row it changed, and
 * on a first run over a long-neglected table that list is as long as the backlog. The
 * handler reports the count and discards the ids: an unbounded log line is a real operational
 * hazard, and the ids answer no question the count does not.
 */
export function makeStaleOccurrenceFlipJobHandler(
  pool: Pool,
  options: StaleOccurrenceFlipHandlerOptions = {}
): (job: Job) => Promise<void> {
  const logger = options.logger ?? console;
  return async (job: Job): Promise<void> => {
    // BEFORE the UPDATE, not after: this is the line that says real rows are about to be
    // mutated, and it has to exist even if the UPDATE then throws.
    logger.log(
      `[worker] stale_occurrence_flip job ${job.id}: demoting past-cadence occurrences ` +
        `to status_state='stale' (threshold = grace × the owning source's effective cadence)`
    );
    const result = await flipStaleOccurrences(pool);
    logger.log(`[worker] stale_occurrence_flip job ${job.id}: flipped=${result.count}`);
  };
}
