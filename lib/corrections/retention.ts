// lib/corrections/retention.ts — the correction_report retention ENFORCEMENT job.
//
// The correction-report counterpart to lib/analytics/retention.ts, closing PIPEDA
// Round 23 finding F-6: correction_report can hold user-submitted free text (`note`)
// but had no retention control — only a soft-delete `archived_at` nothing ever set.
// Migration 0020 added a per-row `retained_until` stamp (DB DEFAULT now()+6 months)
// + index (idx_correction_report_retained_until); this job DELETES rows past it.
//
// Same mechanic as the analytics job (batched hard-DELETE by retained_until, dry-run,
// max-batches backstop, injectable now), so both are thin wrappers over the shared
// lib/db/retention-purge.ts — one tested implementation, no forked batching loop.
//
// Scheduling: driven by the platform `schedule` skill hitting the secret-guarded
// POST /api/corrections/retention/run — the same recurring-job pattern as the
// analytics retention sweep and the weekly digest email. NO pg_cron / no new infra.
//
// Server-only: touches `pg` via the shared pool.
import {
  purgeExpiredByRetainedUntil,
  type RetentionPurgeOptions,
  type RetentionPurgeResult,
} from '@/lib/db/retention-purge';
import { correctionRetentionDays } from './retention-config';

export type CorrectionPurgeOptions = RetentionPurgeOptions;
export type CorrectionPurgeResult = RetentionPurgeResult;

/**
 * Purge correction reports past their retention window. Deletes
 * `WHERE retained_until < now` in bounded batches. Throws on a real DB error
 * (a maintenance job SHOULD surface failures); the run route catches and reports it.
 */
export async function purgeExpiredCorrectionReports(
  options: CorrectionPurgeOptions = {}
): Promise<CorrectionPurgeResult> {
  return purgeExpiredByRetainedUntil('correction_report', correctionRetentionDays(), options);
}
