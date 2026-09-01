// worker/core/job-handlers.ts — job_type → handler dispatch for the worker's queue lane.
//
// THE DEFECT THIS CLOSES. job_queue has carried a `job_type` column since migration 0011
// (0011_job_queue.sql:13, `job_type text NOT NULL DEFAULT 'ingest'`), enqueue() has always
// accepted an arbitrary jobType and a NULL sourceId (worker/core/queue.ts:14-25), and
// dequeue() has always returned it (queue.ts:38,46). But the runtime bound exactly ONE
// handler for every claimed job — `makeTermsGatedIngestJobHandler(pool, environment)` in
// worker/src/scheduler.ts — and that handler opens with
// `if (!job.sourceId) throw new Error('ingest job has no source_id')`
// (worker/core/source-runner.ts:127). So a global job (source_id=NULL) threw on every
// attempt, retried to max_attempts and dead-lettered. The column and the enqueue path were
// fine; the dispatch was missing. This module is that dispatch and nothing more.
//
// AN UNKNOWN job_type IS AN ERROR, LOUDLY. It must not be silently succeeded (the row would
// go to 'done' having done nothing at all — the failure mode this project has already
// shipped once) and it must not fall through to the ingest handler (which would report the
// misleading 'ingest job has no source_id' for a job that was never an ingest job). It
// throws UnknownJobTypeError, so the existing queue machinery retries and then dead-letters
// it with a message that names the offending job_type and lists what IS registered.
import type { Pool } from 'pg';
import { SMS_RETENTION_JOB_TYPE, makeSmsRetentionJobHandler } from './sms-retention';
import type { Job } from './queue';
import { makeTermsGatedIngestJobHandler } from './source-runner';
import type { Environment } from './terms-gate';
import {
  CORRECTIONS_RETENTION_JOB_TYPE,
  makeCorrectionsRetentionJobHandler,
} from './corrections-retention';
import {
  STALE_OCCURRENCE_FLIP_JOB_TYPE,
  makeStaleOccurrenceFlipJobHandler,
} from './stale-occurrence-flip';

/** Every queue handler has the same shape: run the job, or throw. Returning normally is a
 *  claim that the work was DONE — the scheduler marks the row 'done' on that basis. */
export type JobHandler = (job: Job) => Promise<void>;

/** The default job_type (migration 0011's column DEFAULT) — per-source terms-gated ingest. */
export const INGEST_JOB_TYPE = 'ingest';

/** Stable prefix for the unknown-job-type failure, so it is greppable in job_queue.last_error
 *  and in Sentry without depending on the rest of the sentence. */
export const UNKNOWN_JOB_TYPE_ERROR_PREFIX = 'unsupported job_type';

/**
 * Thrown when a claimed job's job_type has no registered handler.
 *
 * Deliberately a distinct class with a distinctive message: this is an operator-visible
 * configuration error (someone enqueued a type the worker was never taught), not a
 * transient fault, and it must be distinguishable at a glance from an ingest failure.
 */
export class UnknownJobTypeError extends Error {
  readonly jobType: string;
  readonly jobId: string;
  readonly knownJobTypes: readonly string[];

  constructor(jobType: string, jobId: string, knownJobTypes: readonly string[]) {
    super(
      `${UNKNOWN_JOB_TYPE_ERROR_PREFIX} "${jobType}" for job ${jobId}: ` +
        `no handler is registered. Registered job types: ${knownJobTypes.join(', ')}`
    );
    this.name = 'UnknownJobTypeError';
    this.jobType = jobType;
    this.jobId = jobId;
    this.knownJobTypes = knownJobTypes;
  }
}

/**
 * The job_type → handler registry.
 *
 * 'ingest' maps to the EXISTING terms-gated handler, unchanged and un-widened: a NULL
 * source_id on an ingest job is still a genuine error and still throws. Only the *routing*
 * changed — a global job never reaches this handler any more, because it is no longer the
 * only handler there is.
 *
 * REGISTERING A TYPE HERE IS A CAPABILITY, NOT AN ENABLEMENT. Both global types below are
 * dispatchable the moment this code is deployed, and neither is SCHEDULED: their
 * global_job_schedule rows ship `enabled = false` (migrations 0028 and 0029), and turning
 * one on is a separate operator act. The drift guard in
 * tests/scheduler/job-type-dispatch.test.ts pins this map's key set, so adding a type is
 * always a visible edit in the same commit.
 */
export function buildJobHandlerRegistry(
  pool: Pool,
  environment: Environment
): Map<string, JobHandler> {
  return new Map<string, JobHandler>([
    [INGEST_JOB_TYPE, makeTermsGatedIngestJobHandler(pool, environment)],
    [CORRECTIONS_RETENTION_JOB_TYPE, makeCorrectionsRetentionJobHandler()],
    [STALE_OCCURRENCE_FLIP_JOB_TYPE, makeStaleOccurrenceFlipJobHandler(pool)],
    [SMS_RETENTION_JOB_TYPE, makeSmsRetentionJobHandler()],
  ]);
}

/**
 * Build the single handler the scheduler's poll loop calls for every claimed job: look the
 * job_type up in the registry and run it, or throw UnknownJobTypeError.
 *
 * The registry is built once per scheduler, matching the previous behaviour of building the
 * ingest handler once (worker/src/scheduler.ts).
 */
export function makeJobDispatcher(pool: Pool, environment: Environment): JobHandler {
  const registry = buildJobHandlerRegistry(pool, environment);
  const knownJobTypes = [...registry.keys()].sort();
  return async (job: Job): Promise<void> => {
    const handler = registry.get(job.jobType);
    if (!handler) {
      throw new UnknownJobTypeError(job.jobType, job.id, knownJobTypes);
    }
    await handler(job);
  };
}
