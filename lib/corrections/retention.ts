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
// Callers: POST /api/corrections/retention/run (Vercel, secret-guarded) AND the Fly
// worker's `corrections_retention` queue job (worker/core/corrections-retention.ts),
// which imports THIS module directly rather than fetching the route — see that file
// for why. Both runtimes therefore share one purge implementation and one window; the
// public privacy page's automatic-deletion promise depends on that staying true.
//
// Server-only: touches `pg` via the shared pool.
//
// RELATIVE import, not '@/lib/db/retention-purge', and that is load-bearing: the worker
// compiles this file with plain `tsc` and runs the emitted CommonJS under bare node.
// `@/*` is a BUNDLER alias (next.config/webpack, vitest.config.ts resolve.alias, the root
// tsconfig `paths`) — tsc type-checks it but emits `require("@/lib/db/retention-purge")`
// verbatim, which node cannot resolve. Under Next/Vitest the two spellings are identical;
// under the worker only this one works. tests/scheduler/worker-image-closure.test.ts fails
// if a '@/' specifier reappears anywhere in the worker's module closure.
import {
  purgeExpiredByRetainedUntil,
  type RetentionPurgeOptions,
  type RetentionPurgeResult,
} from '../db/retention-purge';
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
