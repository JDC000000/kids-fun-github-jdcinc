// worker/core/sms-retention.ts — the `sms_retention` queue job.
//
// WHAT IT ENFORCES. The two retention rules migration 0034 describes in its header and whose
// indexes it ships, but whose JOB it explicitly deferred ("out of scope for this migration"):
// the 30-day post-stop erasure of personal columns, and the 90-day deletion of signups that
// never confirmed. That deferral was never closed. Confirmed against production on 2026-09-01:
// `SELECT jobname, schedule, command FROM cron.job` returned ZERO rows, while /u/ had been
// telling people "everything we store about you is deleted 30 days later". This job is the
// thing that makes that sentence true.
//
// WHY THE WORKER AND NOT A VERCEL ROUTE. Identical reasoning to corrections_retention (see that
// file's header): the app is on Vercel Hobby with no maxDuration override anywhere in the repo,
// so a route doing bounded batch work over an arbitrary backlog is killed mid-loop at the
// plan's ceiling — silently, leaving rows unpurged while the caller sees a timeout it cannot
// distinguish from a network blip. The worker is a long-running Fly process with no ceiling. It
// also needs no shared secret, no egress and no public surface, which is strictly less to get
// wrong in front of an irreversible action.
//
// ONE DEFINITION, ONE RUNTIME. Unlike corrections_retention there is no second caller: no HTTP
// route exists for this job, deliberately. lib/retention/sms.ts is nonetheless kept in lib/
// rather than worker/ so its unit and DB tests run in the main suite, and so a future route (if
// anyone ever wants one) cannot fork the implementation.
import {
  purgeStoppedSubscriberData,
  purgeUnconfirmedSignups,
} from '../../lib/retention/sms';
import {
  SMS_RETENTION_DRY_RUN_ENV,
  resolveSmsRetentionDryRun,
} from '../../lib/retention/sms-config';
import type { Job } from './queue';

/**
 * The job_type this handler is registered under. Must match what the enqueuer writes into
 * job_queue.job_type — job_type is free text (0011 has no CHECK), so nothing in the database
 * catches a typo; the dispatcher's unknown-job-type error does.
 */
export const SMS_RETENTION_JOB_TYPE = 'sms_retention';

export interface SmsRetentionHandlerOptions {
  /** Injectable for tests; defaults to console. */
  logger?: Pick<Console, 'log'>;
}

/**
 * Build the `sms_retention` job handler.
 *
 * Takes NO pool, for the same reason the corrections handler does not: the purge functions go
 * through lib/db/client.ts's own lazily-created pool, which is the cost of calling the shared
 * implementation unchanged rather than forking it to accept an injected one.
 *
 * LOGS THE RESOLVED MODE BEFORE RUNNING, not after. This line has to exist even if the purge
 * then throws, because "was the kill-switch on?" must be answerable from the worker log rather
 * than inferred from an env var whose spelling is exactly what went wrong in F1.
 *
 * BOTH PURGES RUN IN ONE JOB, stopped-data first. They are independent — neither's rows can
 * satisfy the other's WHERE clause (one requires status='stopped', the other status='pending')
 * — so the order is arbitrary and no transaction spans them. Keeping them in one job means one
 * schedule row, one enable switch and one log line pair to read.
 *
 * Throws on a DB failure, which is what we want: the queue retries with backoff and dead-letters
 * after max_attempts rather than recording a silent success in front of a retention promise.
 */
export function makeSmsRetentionJobHandler(
  options: SmsRetentionHandlerOptions = {}
): (job: Job) => Promise<void> {
  const logger = options.logger ?? console;
  return async (job: Job): Promise<void> => {
    const mode = resolveSmsRetentionDryRun();
    logger.log(
      `[worker] sms_retention job ${job.id}: effective mode ` +
        `${mode.dryRun ? 'DRY RUN (changing nothing)' : 'PURGING'} — ` +
        `${SMS_RETENTION_DRY_RUN_ENV}=${mode.raw === null ? '<unset>' : `"${mode.raw}"`} ` +
        `(${mode.reason})`
    );

    const stopped = await purgeStoppedSubscriberData({ dryRun: mode.dryRun });
    // Counts only — never a phone number, postal code or birth year. sms_consent is the most
    // sensitive table in the schema (0034's RLS comment) and this runs unattended.
    logger.log(
      `[worker] sms_retention job ${job.id}: stopped-data purge dryRun=${stopped.dryRun} ` +
        `matched=${stopped.matched} purged=${stopped.purged} batches=${stopped.batches} ` +
        `retentionDays=${stopped.retentionDays} truncated=${stopped.truncated}`
    );

    const pending = await purgeUnconfirmedSignups({ dryRun: mode.dryRun });
    logger.log(
      `[worker] sms_retention job ${job.id}: unconfirmed-signup purge dryRun=${pending.dryRun} ` +
        `matched=${pending.matched} purged=${pending.purged} batches=${pending.batches} ` +
        `retentionDays=${pending.retentionDays} truncated=${pending.truncated}`
    );
  };
}
