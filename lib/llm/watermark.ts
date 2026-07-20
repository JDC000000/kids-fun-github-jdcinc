// lib/llm/watermark.ts — the incremental watermark + system decision log (llm_batch_run,
// llm_batch_decision from migration 0019).
//
// INCREMENTAL / IDEMPOTENT contract:
//   • Detection queries compare a record's change-time —
//     greatest(created_at, coalesce(last_checked_at, created_at)) — against the job's stored
//     last_watermark IN SQL (via watermarkPredicate), so a run only ever considers records
//     that are new-or-changed since the last SUCCESSFUL run. No full-dataset re-scan.
//   • A successful run advances last_watermark to the DB `now()` captured at run START
//     (runTimestamp()), so everything examined this run is excluded next run. Records that
//     change DURING the run have a later change-time and are caught next run.
//   • A DRY-RUN does NOT advance the watermark (observe-only), so enabling the job later
//     still processes the same backlog.
import type { PoolClient } from 'pg';
import { query } from '@/lib/db/client';

/**
 * The DB `now()` at run start, as a timestamptz literal string. Sourcing the run timestamp
 * from the DB (not the app clock) makes the watermark immune to app/DB clock skew.
 */
export async function runTimestamp(): Promise<string> {
  const rows = await query<{ now: string }>(`SELECT now()::text AS now`);
  return rows[0].now;
}

/**
 * A SQL predicate fragment (with a bound param placeholder) that is true for records changed
 * since the job's last successful run. `$${jobNameParamIndex}` must bind the job_name.
 * `alias` is the activity_occurrence alias in the caller's query.
 */
export function watermarkPredicate(alias: string, jobNameParamIndex: number): string {
  return (
    `greatest(${alias}.created_at, coalesce(${alias}.last_checked_at, ${alias}.created_at)) > ` +
    `coalesce((SELECT last_watermark FROM llm_batch_run WHERE job_name = $${jobNameParamIndex}), '-infinity'::timestamptz)`
  );
}

/** Advance (upsert) the watermark + run stats after a SUCCESSFUL real run. */
export async function advanceWatermark(
  jobName: string,
  toTimestamp: string,
  stats: { considered: number; actioned: number; status?: string }
): Promise<void> {
  await query(
    `INSERT INTO llm_batch_run (job_name, last_watermark, last_run_at, last_status, records_considered, records_actioned, updated_at)
       VALUES ($1, $2::timestamptz, now(), $3, $4, $5, now())
     ON CONFLICT (job_name) DO UPDATE SET
       last_watermark     = EXCLUDED.last_watermark,
       last_run_at        = EXCLUDED.last_run_at,
       last_status        = EXCLUDED.last_status,
       records_considered = EXCLUDED.records_considered,
       records_actioned   = EXCLUDED.records_actioned,
       updated_at         = now()`,
    [jobName, toTimestamp, stats.status ?? 'ok', stats.considered, stats.actioned]
  );
}

/** Record a run that did NOT advance the watermark (dry-run / disabled / error). */
export async function recordNonAdvancingRun(
  jobName: string,
  status: string,
  stats: { considered: number; actioned: number }
): Promise<void> {
  await query(
    `INSERT INTO llm_batch_run (job_name, last_run_at, last_status, records_considered, records_actioned, updated_at)
       VALUES ($1, now(), $2, $3, $4, now())
     ON CONFLICT (job_name) DO UPDATE SET
       last_run_at        = now(),
       last_status        = EXCLUDED.last_status,
       records_considered = EXCLUDED.records_considered,
       records_actioned   = EXCLUDED.records_actioned,
       updated_at         = now()`,
    [jobName, status, stats.considered, stats.actioned]
  );
}

export interface DecisionRow {
  jobName: string;
  useCase: 'dedup' | 'age' | 'category_cost';
  targetId: string;
  relatedId?: string | null;
  customId: string;
  action: string;
  deterministicScore?: number | null;
  llmConfidence?: number | null;
  detail?: Record<string, unknown> | null;
}

/** Append one decision to the system audit trail (optionally within a transaction). */
export async function recordDecision(row: DecisionRow, exec?: Pick<PoolClient, 'query'>): Promise<void> {
  const sql = `INSERT INTO llm_batch_decision
      (job_name, use_case, target_id, related_id, custom_id, action, deterministic_score, llm_confidence, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`;
  const params = [
    row.jobName,
    row.useCase,
    row.targetId,
    row.relatedId ?? null,
    row.customId,
    row.action,
    row.deterministicScore ?? null,
    row.llmConfidence ?? null,
    row.detail === undefined || row.detail === null ? null : JSON.stringify(row.detail),
  ];
  if (exec) {
    await exec.query(sql, params);
    return;
  }
  await query(sql, params);
}
