// worker/core/checkrun.ts — G-T5-4: source_check_run logging (TSD §6.1, §9).
import type { Pool } from 'pg';

export async function startCheckRun(pool: Pool, sourceId: string): Promise<{ id: string; startedAt: Date }> {
  const startedAt = new Date();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO source_check_run (source_id, started_at, status) VALUES ($1, $2, 'running') RETURNING id`,
    [sourceId, startedAt]
  );
  return { id: rows[0].id, startedAt };
}

export interface FinishCheckRunOptions {
  status: 'success' | 'partial' | 'failed';
  recordsFound?: number;
  errors?: unknown;
  startedAt: Date;
}

export async function finishCheckRun(
  pool: Pool,
  checkRunId: string,
  opts: FinishCheckRunOptions
): Promise<void> {
  const durationMs = Date.now() - opts.startedAt.getTime();
  await pool.query(
    `UPDATE source_check_run SET status = $2, records_found = $3, errors = $4, duration_ms = $5 WHERE id = $1`,
    [
      checkRunId,
      opts.status,
      opts.recordsFound ?? null,
      opts.errors ? JSON.stringify(opts.errors) : null,
      durationMs,
    ]
  );
}
