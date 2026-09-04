// lib/sms/retention.ts — the sms_consent retention ENFORCEMENT job.
//
// Closes the gap confirmed against production on 2026-09-01: `/u/` promises "everything we
// store about you is deleted 30 days later" and nothing was enforcing it — 0039 seeds this job's
// schedule `enabled = false` and it had not been armed yet. The schema, the two indexes and
// several code comments all described a purge that was not running. Migration 0034's header had
// deferred the job explicitly ("out of scope for this migration") and that deferral was never
// closed while consumer-facing copy went live promising the behaviour.
//
// ⚠ THIS PARAGRAPH ORIGINALLY CITED THE WRONG EVIDENCE. It read: "`SELECT jobname, schedule,
// command FROM cron.job` returned zero rows". That query did return zero rows, and always will:
// this job does not use pg_cron. It is driven by the app-level `global_job_schedule` /
// `global_job_run` tables (0039), so `cron.job` is empty whether the job is armed or disarmed.
// The conclusion happened to be true on 2026-09-01; the proof offered for it could not have
// established it either way. Corrected 2026-09-04 against live production by the Operator.
//
// TWO OPERATIONS, ONE SHAPE — AND THE SECOND ONE CHANGED ON 2026-09-04:
//
//   30-day post-stop   an UPDATE that nulls the personal columns and KEEPS the row, because
//                      sms_send_log's CASL audit trail must keep pointing at a subscription
//                      that demonstrably existed.
//   90-day unconfirmed the SAME null-and-keep UPDATE. It used to be a real row DELETE. See
//                      purgeUnconfirmedSignups below for why that changed and what it costs.
//
// ⚠ THREE OTHER FILES STILL DESCRIBE THE OLD SHAPE AND ARE NOW WRONG. This module's own files
// were the agreed scope of that change, so the prose elsewhere was deliberately left alone
// rather than edited across workstreams — which means it is stale, not right:
//   • lib/retention/sms-config.ts, SMS_PENDING_RETENTION_DAYS  — "the row is DELETED outright"
//   • supabase/migrations/0034_sms_consent.sql, header          — "IS a row delete"
//   • supabase/migrations/0039_sms_retention_schedule.sql       — "the 90-day DELETE"
// They are comments on applied/committed files, so correcting them is a follow-up edit, not a
// rewrite of history. Flagged here because "every artifact agrees with every other artifact and
// none of them agrees with production" is the exact failure 0039 was written to correct.
//
// WHY NOT lib/db/retention-purge.ts. That module handles ONE shape: tables with a
// `retained_until` column, purged by DELETE (PURGEABLE_TABLES = analytics_event,
// correction_report). sms_consent has no such column, and the first operation above is an
// UPDATE. Adding it to PURGEABLE_TABLES would mean teaching a generic deleter about a
// table-specific update — so this is its own module that COPIES that module's conventions
// (bounded batches, dryRun, injectable now, typed counts, throws on real DB error) rather than
// bending it.
//
// COUNTS ONLY, NEVER CONTENTS. sms_consent is the most sensitive table in the schema (0034's own
// RLS comment) and this module runs unattended. Nothing here returns or logs a phone number, a
// postal code or a birth year — the result types below carry integers and an ISO cutoff.
//
// LIVES IN lib/retention/, NOT lib/sms/, AND THAT IS A BUILD CONSTRAINT NOT A TASTE ONE.
// worker/Dockerfile copies WHOLE DIRECTORIES on purpose ("so a refactor inside them cannot
// silently drop a file the image needs"). Copying all of lib/sms would drag Next-coupled,
// '@/'-aliased modules into the worker image; copying two files out of it would break that
// stated convention. Sitting beside the shared kill-switch parser satisfies both: one
// directory, one COPY line, and the shared surface stays reviewable.
//
// RELATIVE IMPORTS, load-bearing — compiled into the Fly worker by plain tsc and run under bare
// node, where '@/...' cannot resolve. See tests/scheduler/worker-image-closure.test.ts.
import { query } from '../db/client';
import { SMS_PENDING_RETENTION_DAYS, SMS_STOPPED_RETENTION_DAYS } from './sms-config';

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 100;

export interface SmsRetentionOptions {
  /** The "now" the sweep runs against (injectable for deterministic tests). */
  now?: Date;
  /** Count matching rows but change nothing. Default false — the job's job is to purge. */
  dryRun?: boolean;
  /** Rows per statement, to keep locks short. */
  batchSize?: number;
  /** Safety cap on the batch loop (runaway backstop; surfaced in the result). */
  maxBatches?: number;
}

export interface SmsRetentionResult {
  dryRun: boolean;
  /** ISO cutoff; rows older than this are in scope. */
  cutoff: string;
  /** Rows found in scope (dry run) or actually acted on (real run). */
  matched: number;
  /** Rows actually changed. 0 on a dry run. */
  purged: number;
  batches: number;
  retentionDays: number;
  /** True if maxBatches was hit and rows may remain for the next run. */
  truncated: boolean;
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number): number {
  if (!Number.isFinite(v ?? NaN)) return dflt;
  return Math.min(Math.max(Math.trunc(v as number), min), max);
}

function cutoffFor(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 30-DAY POST-STOP PURGE. Erases the four personal columns of stopped subscribers in place.
 *
 * `phone_number IS NOT NULL` is not decoration: it is what makes repeat runs idempotent and
 * cheap. An already-purged row has nothing left to null, and without this predicate every run
 * would rewrite every historical stopped row forever, growing the work monotonically while
 * achieving nothing. It also means `matched` on a dry run reports rows that would ACTUALLY
 * change, not rows that merely match the age condition.
 *
 * DOES NOT CLEAR preferences_token, and that is not an oversight — see purgeUnconfirmedSignups,
 * which does. PRD §1.3 enumerates four columns for this rule and this rule honours exactly them.
 *
 * Uses idx_sms_consent_stopped_at (0034). Throws on a real DB error — a maintenance job should
 * surface failures so the queue retries and eventually dead-letters, rather than recording a
 * silent success.
 */
export async function purgeStoppedSubscriberData(
  options: SmsRetentionOptions = {}
): Promise<SmsRetentionResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const cutoff = cutoffFor(now, SMS_STOPPED_RETENTION_DAYS);
  const batchSize = clampInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 50_000);
  const maxBatches = clampInt(options.maxBatches, DEFAULT_MAX_BATCHES, 1, 100_000);

  if (dryRun) {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sms_consent
        WHERE status = 'stopped' AND stopped_at < $1 AND phone_number IS NOT NULL`,
      [cutoff]
    );
    const matched = Number(rows[0]?.n ?? '0');
    return { dryRun: true, cutoff, matched, purged: 0, batches: 0,
             retentionDays: SMS_STOPPED_RETENTION_DAYS, truncated: false };
  }

  let purged = 0;
  let batches = 0;
  let truncated = false;
  for (;;) {
    if (batches >= maxBatches) { truncated = true; break; }
    const rows = await query<{ id: string }>(
      `UPDATE sms_consent
          SET phone_number = NULL, postal_code = NULL, birth_years = NULL,
              category_interests = NULL
        WHERE id IN (
          SELECT id FROM sms_consent
           WHERE status = 'stopped' AND stopped_at < $1 AND phone_number IS NOT NULL
           ORDER BY stopped_at
           LIMIT $2
        )
        RETURNING id`,
      [cutoff, batchSize]
    );
    batches += 1;
    purged += rows.length;
    if (rows.length < batchSize) break;
  }
  return { dryRun: false, cutoff, matched: purged, purged, batches,
           retentionDays: SMS_STOPPED_RETENTION_DAYS, truncated };
}

/**
 * 90-DAY NEVER-CONFIRMED PURGE. Erases the personal columns of pending signups that never
 * replied JOIN, and KEEPS the row.
 *
 * ═══ THIS WAS A DELETE UNTIL 2026-09-04 ═══
 * 0034 designed it as a row delete and gave a real reason: a signup that never confirmed
 * produced no commercial message, so there is no CASL trail to preserve. The FK design made it
 * safe rather than destructive — sms_send_log and sms_click_event reference sms_consent with
 * ON DELETE SET NULL (0035/0036), so log rows survive with a null subscriber_id instead of
 * being cascaded away.
 *
 * What that reasoning did not weigh is what the null costs. `subscriber_id` IS the link between
 * a send row and the subscription it belonged to, and nulling it is not a partial loss — after
 * the delete there is no way to tell which surviving log rows came from which deleted signup.
 * The 2026-09-04 audit ran into exactly that wall from the other side: 13 log rows with a null
 * subscriber_id, and no way to say what they had been attached to. Keeping the row keeps the
 * link, at the price of one all-NULL row per never-confirmed signup — a row that holds an id,
 * some timestamps and a status, and nothing about a person.
 *
 * Note what this does NOT fix, so nobody reads it as the incident's remedy: this job cannot have
 * produced those 13 rows. THE ARGUMENT IS DATE MATH, NOT ARM STATUS. `purgeUnconfirmedSignups`
 * reaches rows older than 90 days; the consent rows behind those 13 log rows were 1-7 DAYS old
 * when their sibling send-log row was written. A 90-day cutoff cannot reach a 7-day-old row, so
 * this job is ruled out whether it was armed, disarmed, or running every hour.
 *
 * ⚠ CORRECTED 2026-09-04 (Operator, against live production — access this repo does not have).
 * This paragraph previously asserted "this job has never run (0039 seeds the schedule disabled;
 * the 2026-09-01 production check found zero cron.job rows)". Both halves were wrong, in a way
 * worth keeping rather than quietly deleting, because both mistakes are easy to repeat:
 *   · THE JOB IS LIVE and has run successfully 4 times since 2026-09-02. 0039 does seed the
 *     schedule disabled — that half of the reading was right — but the same migration documents
 *     the command to arm it (`UPDATE global_job_schedule SET enabled = true ...`, in its operator
 *     notes), and somebody ran that after 2026-09-01. READING A MIGRATION TELLS YOU THE DEFAULT
 *     IT SEEDS, NEVER THE CURRENT LIVE STATE. Those are two different facts, and only production
 *     answers the second one.
 *   · THE `cron.job` CHECK WAS AIMED AT THE WRONG MECHANISM. Real query, real zero result, no
 *     bearing on this job: it runs through `global_job_schedule`, not pg_cron.
 * The conclusion survives both corrections unchanged, because it never depended on either claim.
 * That is the argument for resting a finding on its strongest ground rather than its most
 * convenient one — the date math was always the load-bearing part.
 *
 * This is a narrowing of what the codebase is ABLE to do — after this change no shipped code path
 * deletes an sms_consent row at all, which is what makes the companion migration's trigger a
 * meaningful alarm rather than background noise.
 *
 * ═══ FIVE COLUMNS, NOT THE STOPPED RULE'S FOUR ═══
 * preferences_token is cleared here and is not cleared by the 30-day rule. The two rules are
 * narrowing from opposite directions: the stopped rule narrows from KEEPING a live row, where
 * PRD §1.3's four columns are the whole ask; this rule narrows from DESTROYING the row
 * outright, which took the bearer token with it. Leaving a live preferences-page credential on
 * a row we now retain forever would make this change a net LOSS of privacy, which it must not
 * be. So the set here is every personal-or-credential column on the table.
 *
 * ═══ `phone_number IS NOT NULL` IS LOAD-BEARING ═══
 * Same predicate, same reason, as the stopped rule — but it became necessary here only with
 * this change. A deleted row stops matching a WHERE clause by ceasing to exist; a nulled row
 * does not. Without this predicate every purged pending row would still satisfy
 * `status = 'pending' AND consent_timestamp < cutoff` on every future run, forever, and the job
 * would rewrite its entire historical output nightly while achieving nothing. It also keeps
 * `matched` on a dry run honest: rows that would ACTUALLY change, not rows that merely match
 * the age condition.
 *
 * Uses idx_sms_consent_pending_since (0034).
 */
export async function purgeUnconfirmedSignups(
  options: SmsRetentionOptions = {}
): Promise<SmsRetentionResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const cutoff = cutoffFor(now, SMS_PENDING_RETENTION_DAYS);
  const batchSize = clampInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 50_000);
  const maxBatches = clampInt(options.maxBatches, DEFAULT_MAX_BATCHES, 1, 100_000);

  if (dryRun) {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sms_consent
        WHERE status = 'pending' AND consent_timestamp < $1 AND phone_number IS NOT NULL`,
      [cutoff]
    );
    const matched = Number(rows[0]?.n ?? '0');
    return { dryRun: true, cutoff, matched, purged: 0, batches: 0,
             retentionDays: SMS_PENDING_RETENTION_DAYS, truncated: false };
  }

  let purged = 0;
  let batches = 0;
  let truncated = false;
  for (;;) {
    if (batches >= maxBatches) { truncated = true; break; }
    const rows = await query<{ id: string }>(
      `UPDATE sms_consent
          SET phone_number = NULL, postal_code = NULL, birth_years = NULL,
              category_interests = NULL, preferences_token = NULL
        WHERE id IN (
          SELECT id FROM sms_consent
           WHERE status = 'pending' AND consent_timestamp < $1 AND phone_number IS NOT NULL
           ORDER BY consent_timestamp
           LIMIT $2
        )
        RETURNING id`,
      [cutoff, batchSize]
    );
    batches += 1;
    purged += rows.length;
    if (rows.length < batchSize) break;
  }
  return { dryRun: false, cutoff, matched: purged, purged, batches,
           retentionDays: SMS_PENDING_RETENTION_DAYS, truncated };
}
