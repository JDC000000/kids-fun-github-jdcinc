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

/**
 * Close out a check run, and — on a run that actually refreshed the data — stamp
 * `source.last_check_at`.
 *
 * That stamp is the ONLY input to worker/core/confidence.ts's `freshness` factor, and until
 * now nothing on the ingest path ever wrote it (only the seasonal adapter did, via
 * worker/adapters/seasonal/map.ts). The consequences were measured on 2026-08-01:
 *   • sources whose stamp was still NULL scored freshness = 1.0 unconditionally — the
 *     factor was inert, so a source going dark was never discounted;
 *   • the two sources that HAD been stamped once, by an unrelated job 18 days earlier,
 *     were frozen at the 0.2 FRESHNESS_FLOOR forever even though their runs succeeded
 *     daily. With freshness pinned at 0.2 the parse-quality bar for `medium` becomes 2.5,
 *     i.e. unreachable, so every one of their occurrences was permanently low/unscored.
 * Stamping it here closes the loop the formula always assumed was closed.
 *
 * Only success/partial stamp it: `freshness` means "how current is the DATA we hold", so a
 * failed fetch must not be able to claim the data was refreshed. Failures are already
 * carried by the success-rate dimension of worker/health/sla.ts.
 */
export async function finishCheckRun(
  pool: Pool,
  checkRunId: string,
  opts: FinishCheckRunOptions
): Promise<void> {
  const durationMs = Date.now() - opts.startedAt.getTime();
  const { rows } = await pool.query<{ source_id: string }>(
    `UPDATE source_check_run SET status = $2, records_found = $3, errors = $4, duration_ms = $5
      WHERE id = $1
      RETURNING source_id`,
    [
      checkRunId,
      opts.status,
      opts.recordsFound ?? null,
      opts.errors ? JSON.stringify(opts.errors) : null,
      durationMs,
    ]
  );

  const sourceId = rows[0]?.source_id;
  if (!sourceId || opts.status === 'failed') return;
  await pool.query(`UPDATE source SET last_check_at = now() WHERE id = $1`, [sourceId]);
}
