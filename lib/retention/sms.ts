// lib/sms/retention.ts — the sms_consent retention ENFORCEMENT job.
//
// Closes the gap confirmed against production on 2026-09-01: `/u/` promises "everything we
// store about you is deleted 30 days later" and NOTHING performed it. `SELECT jobname, schedule,
// command FROM cron.job` returned zero rows; the schema, the two indexes and several code
// comments all described a purge that did not exist. Migration 0034's header had deferred the
// job explicitly ("out of scope for this migration") and that deferral was never closed while
// consumer-facing copy went live promising the behaviour.
//
// TWO OPERATIONS, AND THEY ARE GENUINELY DIFFERENT SHAPES (0034 header, lines 49-59):
//
//   30-day post-stop   an UPDATE that nulls four personal columns and KEEPS the row, because
//                      sms_send_log's CASL audit trail must keep pointing at a subscription
//                      that demonstrably existed.
//   90-day unconfirmed a real row DELETE, because a signup that never confirmed produced no
//                      commercial message and so has no audit trail to preserve.
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
 * 90-DAY NEVER-CONFIRMED PURGE. Deletes pending signups that never replied JOIN.
 *
 * A real DELETE, and the FK design is what makes it safe: sms_send_log and sms_click_event
 * reference sms_consent with ON DELETE SET NULL (0035/0036), so any log rows survive with a
 * null subscriber_id rather than being cascaded away. That is the same mechanism
 * /admin/sms-subscribers/[id] relies on — its phone_hash fallback exists precisely because a
 * send record can outlive the consent row it pointed at.
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
        WHERE status = 'pending' AND consent_timestamp < $1`,
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
      `DELETE FROM sms_consent
        WHERE id IN (
          SELECT id FROM sms_consent
           WHERE status = 'pending' AND consent_timestamp < $1
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
