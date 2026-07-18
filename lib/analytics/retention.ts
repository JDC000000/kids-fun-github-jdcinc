// lib/analytics/retention.ts — the retention ENFORCEMENT job (T31 / G-T31-3).
//
// A real, scheduled data-retention sweep: it DELETES `analytics_event` rows whose
// `retained_until` has passed. Deleting by the per-row `retained_until` stamp (set
// at insert from the app-owned window — see lib/analytics/config.ts) is the correct
// design: it honours the exact window each row was written under, and it is index-
// backed (idx_analytics_event_retained_until from migration 0006). This is the
// enforcement half of "retention is a real designed property, not a paper policy":
// the window is stamped on write and this job actually purges expired rows.
//
// Scheduling: driven by the platform `schedule` skill hitting the secret-guarded
// POST /api/analytics/retention/run — the same recurring-job pattern as the weekly
// digest email (app/api/email/weekly/run). NO pg_cron / no new infra is stood up.
//
// Server-only: touches `pg` via the shared pool.
import { query } from '@/lib/db/client';
import { retentionDays } from './config';

export interface PurgeOptions {
  /** The "now" the sweep runs against (injectable for deterministic tests). */
  now?: Date;
  /** Count expired rows but delete nothing. Default false — the job's job is to delete. */
  dryRun?: boolean;
  /** Rows deleted per statement, to keep locks short on a large table. */
  batchSize?: number;
  /** Safety cap on the batch loop (a runaway backstop; surfaced in the result). */
  maxBatches?: number;
}

export interface PurgeResult {
  dryRun: boolean;
  /** ISO timestamp used as the expiry cutoff (rows with retained_until < this are expired). */
  cutoff: string;
  /** Rows found expired (dry-run) or actually deleted (real run). */
  expired: number;
  /** Rows actually deleted (0 on a dry-run). */
  deleted: number;
  /** Number of DELETE batches executed. */
  batches: number;
  /** The active retention window in days (for the response/audit line). */
  retentionDays: number;
  /** True if the maxBatches cap was hit and expired rows may remain for the next run. */
  truncated: boolean;
}

const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES = 1_000; // up to 5M rows/run at the default batch size

/**
 * Purge analytics events past their retention window. Deletes
 * `WHERE retained_until < now` in bounded batches. Throws on a real DB error
 * (a maintenance job SHOULD surface failures — unlike the best-effort event
 * writer); the run route catches and reports it.
 */
export async function purgeExpiredAnalyticsEvents(options: PurgeOptions = {}): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const cutoffIso = now.toISOString();
  const dryRun = options.dryRun ?? false;
  const batchSize = clampInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 50_000);
  const maxBatches = clampInt(options.maxBatches, DEFAULT_MAX_BATCHES, 1, 100_000);
  const windowDays = retentionDays();

  if (dryRun) {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM analytics_event WHERE retained_until < $1`,
      [cutoffIso]
    );
    const expired = Number(rows[0]?.n ?? '0');
    return {
      dryRun: true,
      cutoff: cutoffIso,
      expired,
      deleted: 0,
      batches: 0,
      retentionDays: windowDays,
      truncated: false,
    };
  }

  let deleted = 0;
  let batches = 0;
  let truncated = false;
  for (;;) {
    if (batches >= maxBatches) {
      truncated = true;
      break;
    }
    const rows = await query<{ id: string }>(
      `DELETE FROM analytics_event
        WHERE id IN (
          SELECT id FROM analytics_event
           WHERE retained_until < $1
           ORDER BY retained_until
           LIMIT $2
        )
      RETURNING id`,
      [cutoffIso, batchSize]
    );
    batches += 1;
    deleted += rows.length;
    if (rows.length < batchSize) break; // drained
  }

  return {
    dryRun: false,
    cutoff: cutoffIso,
    expired: deleted,
    deleted,
    batches,
    retentionDays: windowDays,
    truncated,
  };
}

/** Local clamp helper (mirrors app/api/search/route.ts::clampInt convention). */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
