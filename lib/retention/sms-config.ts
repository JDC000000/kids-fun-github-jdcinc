// lib/retention/sms-config.ts — configuration for the sms_consent retention job.
//
// Mirrors lib/corrections/retention-config.ts's operational surface, minus the cron secret:
// this job has no HTTP route (see worker/core/sms-retention.ts for why it is worker-only).
//
// Env vars:
//   SMS_RETENTION_DRY_RUN — forces both purges to COUNT ONLY, touching nothing. An operator
//                           kill-switch for observe-first. UNSET = the job really purges; see
//                           the reasoning on resolveSmsRetentionDryRun below, which is a
//                           decision that was made explicitly rather than copied.
//
// WINDOWS ARE NOT ENV-OVERRIDABLE. Migration 0034's header states both windows in prose and
// the two indexes exist to serve exactly these queries. An env that could disagree with the
// migration would let the retention PROMISE on /u/ drift from the retention BEHAVIOUR silently,
// which is the failure this whole job exists to correct — /u/ promised a 30-day deletion that
// nothing performed, confirmed against production 2026-09-01 (zero cron.job rows).
//
// RELATIVE IMPORT, load-bearing: this module is compiled into the Fly worker by plain tsc and
// run under bare node, where a '@/...' specifier emitted verbatim cannot resolve. See
// worker/tsconfig.json and tests/scheduler/worker-image-closure.test.ts.
import { resolveDryRunSwitch, type DryRunResolution } from './dry-run-switch';

export type { DryRunResolution };

/**
 * 30 days after a subscriber STOPS, the four personal columns are erased in place.
 * Migration 0034 header, lines 49-55. Not a delete: the CASL audit trail in sms_send_log must
 * keep pointing at a subscription that demonstrably existed.
 */
export const SMS_STOPPED_RETENTION_DAYS = 30;

/**
 * 90 days after a signup that never confirmed, the row is DELETED outright.
 * Migration 0034 header, lines 56-59. A pending signup never produced a commercial message, so
 * there is no audit trail to preserve — which is why 0035/0036 reference sms_consent with
 * ON DELETE SET NULL rather than CASCADE.
 */
export const SMS_PENDING_RETENTION_DAYS = 90;

/** The env var carrying the operator kill-switch, exported so callers can name it in a log
 *  line without re-spelling a literal. */
export const SMS_RETENTION_DRY_RUN_ENV = 'SMS_RETENTION_DRY_RUN';

/**
 * Resolve the SMS retention kill-switch.
 *
 * ═══ UNSET MEANS RUN, AND THIS WAS A DELIBERATE CHOICE, NOT A COPIED DEFAULT ═══
 * The question was raised explicitly: sms_retention is a brand-new job, shipped disabled at the
 * schedule level, operating on the most sensitive table in the schema (0034's own RLS comment).
 * That is a real argument for defaulting unset to PAUSE.
 *
 * It loses to a stronger one. THIS JOB EXISTS BECAUSE A DELETION PROMISE WAS LIVE AND NOTHING
 * PERFORMED IT — /u/ has been telling people "everything we store about you is deleted 30 days
 * later" while no purge ran anywhere. If unset meant PAUSE, then the moment an operator flips
 * global_job_schedule.enabled = true, believing they have turned deletion on, the job would run
 * and delete nothing — silently reproducing the exact bug this is the fix for, now with an extra
 * layer of indirection to see through.
 *
 * The safety argument is already answered twice over without inverting the default: the schedule
 * ships DISABLED (so nothing runs until someone deliberately arms it), and an operator who wants
 * an observe-first run sets this var explicitly before arming. Both are affirmative acts by
 * someone who is paying attention. "Enabled means actually purging" is the property worth
 * protecting, because its absence is what created this task.
 *
 * It also matches lib/corrections/retention-config.ts, whose header gives the same reasoning in
 * its own terms — an unset default of PAUSE "would quietly turn the retention guarantee off
 * everywhere it has not been explicitly configured, which is the larger harm."
 */
export function resolveSmsRetentionDryRun(): DryRunResolution {
  return resolveDryRunSwitch(SMS_RETENTION_DRY_RUN_ENV, 'run', 'sms-retention');
}

/** Whether both purges are forced to count-only. */
export function smsRetentionDryRunForced(): boolean {
  return resolveSmsRetentionDryRun().dryRun;
}
