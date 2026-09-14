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

/**
 * The health-alert code raised by this source's PREVIOUS finished check run, or null when
 * the previous run raised none (or there is no previous run).
 *
 * ═══ WHY THE INGEST PATH NEEDS THE RUN BEFORE THIS ONE ═══
 * A yield verdict compares ONE run to a trailing baseline, so it cannot tell a source that
 * has genuinely emptied from a source whose run was merely SHORT — a vendor mid-maintenance,
 * a half-served page, a crawl that stopped early. Both look identical in a single sample,
 * and production settled which one dominates: of 182 `yield_collapse` alerts raised between
 * 2026-08-11 and 2026-09-14, every single one was followed by a full-yield run, and every
 * job that raised one reached `status = 'done'`. Not one was a regression.
 *
 * Persistence is what separates them, and it needs no new threshold — the ratio, the
 * baseline and the per-run verdict are all untouched. A verdict that repeats across
 * CONSECUTIVE runs is a source that did not come back; a verdict that does not repeat was a
 * blip the next run already corrected. Only the first kind is worth failing a job over.
 *
 * `excludeCheckRunId` is the in-flight run, which is already on the table as 'running' with
 * a null code by the time this is called. Excluding it by id rather than filtering
 * `status <> 'running'` also skips over runs a dead worker stranded in 'running'.
 */
export async function loadPreviousHealthAlertCode(
  pool: Pool,
  sourceId: string,
  excludeCheckRunId: string
): Promise<string | null> {
  const { rows } = await pool.query<{ health_alert_code: string | null }>(
    `SELECT health_alert_code
       FROM source_check_run
      WHERE source_id = $1
        AND id <> $2
        AND status <> 'running'
      ORDER BY started_at DESC
      LIMIT 1`,
    [sourceId, excludeCheckRunId]
  );
  return rows[0]?.health_alert_code ?? null;
}

/**
 * A run-level health verdict raised by the adapter's own self-assessment
 * (Adapter.assessRun → AdapterRunDiagnostics with alert=true).
 *
 * F-11: this used to exist ONLY as a prose line inside the `errors` array, which meant no
 * query could distinguish "an adapter says a human must look at this run" from "three of
 * nine hundred records had a bad date". Persisting it as its own column is what lets the
 * dashboard's attention panel and both SLA success-ratio paths see the alert at all. See
 * migration 0026 and the decision note on AdapterRunDiagnostics in worker/core/adapter.ts.
 */
export interface RunHealthAlert {
  code: string;
  detail: string;
}

export interface FinishCheckRunOptions {
  status: 'success' | 'partial' | 'failed';
  recordsFound?: number;
  /**
   * How many items the source's FEED delivered this run, before any of our own filtering or
   * capping. Null/absent when the adapter reports none — a fixture run, or an adapter with no
   * feed to count. Written to `source_check_run.items_in_feed` (migration 0031).
   *
   * WHY THIS IS NOT `recordsFound` BY ANOTHER NAME. `recordsFound` is incremented once per
   * EXTRACTED record (worker/core/ingest.ts), so it is identically the adapter's emit count —
   * the quantity our own `liveEventsLimit` censors. `loadRecordsFoundBaseline` above computes
   * every trailing baseline in this project from it, which means our own configuration is an
   * input to every yield-collapse threshold we have: a cap sitting below vendor supply pins
   * the baseline to the cap, and the run that emits exactly the cap looks identical whether
   * the vendor sent that many or ten times that many. `items_in_feed` is the same run measured
   * BEFORE our cap touches it, and it had never been recorded anywhere. Nothing reads it yet
   * — reading it is what a later stage does, once weeks of it exist. This is the stage that
   * starts writing it.
   */
  itemsInFeed?: number | null;
  errors?: unknown;
  /** The run's health verdict, or null/absent when the adapter raised none. */
  healthAlert?: RunHealthAlert | null;
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
    `UPDATE source_check_run
        SET status = $2, records_found = $3, errors = $4, duration_ms = $5,
            health_alert_code = $6, health_alert_detail = $7, items_in_feed = $8
      WHERE id = $1
      RETURNING source_id`,
    [
      checkRunId,
      opts.status,
      opts.recordsFound ?? null,
      opts.errors ? JSON.stringify(opts.errors) : null,
      durationMs,
      opts.healthAlert?.code ?? null,
      opts.healthAlert?.detail ?? null,
      opts.itemsInFeed ?? null,
    ]
  );

  const sourceId = rows[0]?.source_id;
  if (!sourceId || opts.status === 'failed') return;
  await pool.query(`UPDATE source SET last_check_at = now() WHERE id = $1`, [sourceId]);
}
