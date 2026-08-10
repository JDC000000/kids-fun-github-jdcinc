// worker/core/corrections-retention.ts — the `corrections_retention` queue job.
//
// WHAT IT IS. The first GLOBAL (source-less) job on the worker queue: it enforces the
// correction_report retention window by deleting rows past their `retained_until` stamp
// (migration 0020). job_queue rows for it carry job_type='corrections_retention' and
// source_id=NULL.
//
// WHY IT RUNS IN THE WORKER AND NOT BEHIND AN HTTP FETCH (ruling P3).
// The obvious-looking implementation — POST to the existing
// /api/corrections/retention/run route from here — does not work on this deployment.
// The app is on Vercel Hobby and NOTHING in the repo sets `maxDuration` (no export in
// app/api/corrections/retention/run/route.ts, no `functions` block in vercel.json), so
// that route is killed at the plan's default ceiling (~10s). A purge that has to drain
// an arbitrary backlog in 5,000-row batches is exactly the shape of work that ceiling
// truncates — silently, mid-loop, leaving expired rows undeleted while the caller sees a
// timeout it cannot distinguish from a network blip. The worker is a long-running Fly
// process with no such ceiling, so the purge runs IN-PROCESS here. It also needs no
// shared secret, no egress and no public surface, which is strictly less to get wrong.
//
// ONE DEFINITION, TWO CALLERS. purgeExpiredCorrectionReports() is imported directly from
// lib/corrections/retention.ts — the same module the Vercel route calls. The purge SQL
// (lib/db/retention-purge.ts) and the retention window (lib/corrections/retention-config.ts)
// are NOT copied into worker/. The privacy page's automatic-deletion promise is a
// compliance claim, and it only holds if the two runtimes can never drift apart.
// worker/Dockerfile therefore ships lib/corrections + lib/db into the image; see
// worker/tsconfig.json and tests/scheduler/worker-image-closure.test.ts.
import { purgeExpiredCorrectionReports } from '../../lib/corrections/retention';
import {
  CORRECTION_RETENTION_DRY_RUN_ENV,
  resolveCorrectionRetentionDryRun,
} from '../../lib/corrections/retention-config';
import type { Job } from './queue';

/**
 * The job_type this handler is registered under. Must match what the enqueuer writes into
 * job_queue.job_type — job_type is free text (migration 0011 has no CHECK), so nothing in
 * the database catches a typo; the dispatcher's unknown-job-type error does.
 */
export const CORRECTIONS_RETENTION_JOB_TYPE = 'corrections_retention';

export interface CorrectionsRetentionHandlerOptions {
  /** Injectable for tests; defaults to console. */
  logger?: Pick<Console, 'log'>;
}

/**
 * Build the `corrections_retention` job handler.
 *
 * Takes NO pool. purgeExpiredCorrectionReports() goes through lib/db/client.ts's own
 * lazily-created pool (built from the same DATABASE_URL the worker's pool uses), which is
 * a deliberate consequence of calling the shared implementation unchanged rather than
 * forking it to accept an injected pool. Practical effect in the worker process: up to 5
 * extra connections, created on first use and released by pg's idle timeout, only while a
 * retention job is actually running. See the report for the alternative considered.
 *
 * Honours CORRECTION_RETENTION_DRY_RUN exactly as the route does
 * (app/api/corrections/retention/run/route.ts:66) — an operator kill-switch that stopped
 * deletions on one runtime but not the other would be worse than no kill-switch. It logs
 * the RESOLVED mode and the reason it resolved that way, because "is the kill-switch on?"
 * must be answerable from the worker log rather than inferred from an env var whose
 * spelling is what went wrong in the first place (F1).
 *
 * Throws on a DB failure, which is what we want: the queue retries with backoff and
 * dead-letters after max_attempts rather than recording a silent success.
 */
export function makeCorrectionsRetentionJobHandler(
  options: CorrectionsRetentionHandlerOptions = {}
): (job: Job) => Promise<void> {
  const logger = options.logger ?? console;
  return async (job: Job): Promise<void> => {
    const mode = resolveCorrectionRetentionDryRun();
    // BEFORE the purge, not after: this is the line that says what is about to happen to
    // real rows, and it has to exist even if the purge then throws.
    logger.log(
      `[worker] corrections_retention job ${job.id}: effective mode ` +
        `${mode.dryRun ? 'DRY RUN (deleting nothing)' : 'DELETING'} — ` +
        `${CORRECTION_RETENTION_DRY_RUN_ENV}=${mode.raw === null ? '<unset>' : `"${mode.raw}"`} ` +
        `(${mode.reason})`
    );
    const result = await purgeExpiredCorrectionReports({ dryRun: mode.dryRun });
    // Counts only — never row contents (the `note` column is user-submitted free text).
    logger.log(
      `[worker] corrections_retention job ${job.id}: dryRun=${result.dryRun} ` +
        `expired=${result.expired} deleted=${result.deleted} batches=${result.batches} ` +
        `retentionDays=${result.retentionDays} truncated=${result.truncated}`
    );
  };
}
