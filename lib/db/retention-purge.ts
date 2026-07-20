// lib/db/retention-purge.ts — generic "purge rows past their retained_until" job.
//
// Extracted so the two retention jobs that share this EXACT mechanic — analytics_event
// (T31, lib/analytics/retention.ts) and correction_report (F-6, lib/corrections/
// retention.ts) — have ONE tested implementation instead of two near-identical copies.
// Each caller stays a thin wrapper that supplies its table + the window it reports.
//
// The purge deletes `WHERE retained_until < now` in bounded batches (short locks on a
// large table) with a max-batches runaway backstop, and supports a count-only dryRun.
// `now` is injectable for deterministic tests. It THROWS on a real DB error (a
// maintenance job SHOULD surface failures — unlike a best-effort writer); the run
// routes catch and report it.
//
// Server-only: touches `pg` via the shared pool.
import { query } from './client';

export interface RetentionPurgeOptions {
  /** The "now" the sweep runs against (injectable for deterministic tests). */
  now?: Date;
  /** Count expired rows but delete nothing. Default false — the job's job is to delete. */
  dryRun?: boolean;
  /** Rows deleted per statement, to keep locks short on a large table. */
  batchSize?: number;
  /** Safety cap on the batch loop (a runaway backstop; surfaced in the result). */
  maxBatches?: number;
}

export interface RetentionPurgeResult {
  dryRun: boolean;
  /** ISO timestamp used as the expiry cutoff (rows with retained_until < this are expired). */
  cutoff: string;
  /** Rows found expired (dry-run) or actually deleted (real run). */
  expired: number;
  /** Rows actually deleted (0 on a dry-run). */
  deleted: number;
  /** Number of DELETE batches executed. */
  batches: number;
  /** The active retention window in days, echoed for the response/audit line. */
  retentionDays: number;
  /** True if the maxBatches cap was hit and expired rows may remain for the next run. */
  truncated: boolean;
}

/**
 * Tables this generic purge is allowed to target. `table` is interpolated into SQL,
 * so it MUST come from our own code (a fixed identifier), NEVER user input. Both of
 * these have the exact `id uuid PK` + `retained_until timestamptz NOT NULL` + a
 * `retained_until` index shape the queries below assume. This allowlist makes the
 * "trusted identifier only" rule a hard, enforced invariant.
 */
export const PURGEABLE_TABLES = ['analytics_event', 'correction_report'] as const;
export type PurgeableTable = (typeof PURGEABLE_TABLES)[number];

const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES = 1_000; // up to 5M rows/run at the default batch size

/**
 * Purge rows of `table` past their retention window. Deletes `WHERE retained_until <
 * now` in bounded batches. `retentionDays` is not used in the query (the cutoff is
 * the per-row stamp) — it is echoed into the result for the audit/response line.
 */
export async function purgeExpiredByRetainedUntil(
  table: PurgeableTable,
  retentionDays: number,
  options: RetentionPurgeOptions = {}
): Promise<RetentionPurgeResult> {
  if (!PURGEABLE_TABLES.includes(table)) {
    // Defence in depth: only ever run against a known, retention-shaped table.
    throw new Error(`retention purge: refusing unknown table "${table}"`);
  }

  const now = options.now ?? new Date();
  const cutoffIso = now.toISOString();
  const dryRun = options.dryRun ?? false;
  const batchSize = clampInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 50_000);
  const maxBatches = clampInt(options.maxBatches, DEFAULT_MAX_BATCHES, 1, 100_000);

  if (dryRun) {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE retained_until < $1`,
      [cutoffIso]
    );
    const expired = Number(rows[0]?.n ?? '0');
    return {
      dryRun: true,
      cutoff: cutoffIso,
      expired,
      deleted: 0,
      batches: 0,
      retentionDays,
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
      `DELETE FROM ${table}
        WHERE id IN (
          SELECT id FROM ${table}
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
    retentionDays,
    truncated,
  };
}

/** Local clamp helper (mirrors app/api/search/route.ts::clampInt convention). */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
