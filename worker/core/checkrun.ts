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

/** Successful runs sampled when computing a source's trailing record-count baseline. */
export const RECORDS_FOUND_BASELINE_RUNS = 5;

/**
 * Mean `records_found` over a source's most recent successful/partial runs — the
 * trailing baseline an adapter compares this run against to detect a YIELD COLLAPSE
 * (the run "succeeded" but the data quietly vanished). Returns null when there is no
 * history: a first run is not a collapse.
 *
 * Distinct from worker/health/sla.ts `parseYieldRate`, which is a BINARY rolling-window
 * measure ("what share of successful runs produced any records at all"). This is a
 * VOLUME measure for one run against its own past.
 */
export async function loadRecordsFoundBaseline(
  pool: Pool,
  sourceId: string,
  runs: number = RECORDS_FOUND_BASELINE_RUNS
): Promise<number | null> {
  const { rows } = await pool.query<{ records_found: number | null }>(
    `SELECT records_found
       FROM source_check_run
      WHERE source_id = $1
        AND status IN ('success', 'partial')
        AND records_found IS NOT NULL
      ORDER BY started_at DESC
      LIMIT $2`,
    [sourceId, runs]
  );
  const counts = rows.map((r) => Number(r.records_found)).filter((n) => Number.isFinite(n) && n > 0);
  if (counts.length === 0) return null;
  return Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
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
