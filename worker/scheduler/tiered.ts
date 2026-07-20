// worker/scheduler/tiered.ts — G-T5-3 + G-T15-2: tiered cadence scheduler (TSD §7.2).
// Cadence lives in the `source` table (config, not code): baseline_cadence
// (daily default), near_date_cadence (sub-daily, nullable), and ingestion_method.
// The TIER decision itself lives in worker/scheduler/cadence.ts (resolveCadenceTier) so
// the tier rules exist once; this function is the DB orchestration that applies them:
// select due, approved sources, resolve each one's tier, enqueue an ingest job, and stamp
// next_check_at forward by the tier's effective interval.
//
// Trigger-agnostic: call it from a pg_cron job (Supabase), a Vercel Cron-hit API route,
// or the worker's own setInterval — whichever mechanism a given environment has.
import type { Pool } from 'pg';
import { resolveCadenceTier, nextCheckIntervalSeconds, type CadenceTier } from './cadence';

export interface DueSource {
  id: string;
  family: string;
  /** The tier resolved for this source this tick (G-T15-2). */
  tier: CadenceTier;
  /** Seconds next_check_at was advanced by. */
  cadenceSeconds: number;
}

interface DueCandidateRow {
  id: string;
  family: string;
  ingestion_method: string;
  baseline_seconds: number | null;
  near_date_seconds: number | null;
  has_near_occurrence: boolean;
}

/** Enqueues an ingest job for every source whose cadence tier says it's due.
 *  Idempotent per tick: skips sources with an already-pending/running job.
 *  Scheduler is live-run oriented, so it only enqueues explicitly approved
 *  terms+robots sources; fixture-only staging review uses ingest-once. Manual-tier
 *  sources (ingestion_method='manual') are operator-fed and never auto-enqueued. */
export async function enqueueDueJobs(pool: Pool): Promise<DueSource[]> {
  // Candidate = terms+robots approved, past its cadence gate (next_check_at), no active job,
  // and not operator-fed. The near-occurrence flag drives the sub-daily near_date tier.
  const { rows } = await pool.query<DueCandidateRow>(
    `SELECT
       s.id,
       s.family,
       s.ingestion_method,
       extract(epoch FROM s.baseline_cadence)::float8   AS baseline_seconds,
       extract(epoch FROM s.near_date_cadence)::float8  AS near_date_seconds,
       EXISTS (
         SELECT 1
           FROM activity_series ser
           JOIN activity_occurrence o ON o.series_id = ser.id
          WHERE ser.source_id = s.id
            AND o.archived_at IS NULL
            AND o.start_datetime_utc IS NOT NULL
            AND o.start_datetime_utc >= now()
            AND o.start_datetime_utc <= now() + interval '7 days'
       ) AS has_near_occurrence
     FROM source s
     WHERE s.terms_status IN ('allowed', 'summarise_only')
       AND s.robots_status = 'allowed'
       AND s.ingestion_method <> 'manual'
       AND (s.next_check_at IS NULL OR s.next_check_at <= now())
       AND NOT EXISTS (
         SELECT 1 FROM job_queue jq
         WHERE jq.source_id = s.id AND jq.status IN ('pending', 'running')
       )`
  );

  const due: DueSource[] = [];
  for (const row of rows) {
    const resolution = resolveCadenceTier({
      ingestionMethod: row.ingestion_method,
      baselineCadenceSeconds: row.baseline_seconds,
      nearDateCadenceSeconds: row.near_date_seconds,
      hasNearOccurrence: row.has_near_occurrence,
    });
    // Defensive: a manual row can't reach here (SQL excludes it), but never enqueue one.
    if (!resolution.scheduled) continue;

    const cadenceSeconds = nextCheckIntervalSeconds(resolution);
    await pool.query(
      `INSERT INTO job_queue (source_id, job_type, scheduled_for) VALUES ($1, 'ingest', now())`,
      [row.id]
    );
    await pool.query(
      `UPDATE source
         SET next_check_at = now() + make_interval(secs => $2::double precision)
       WHERE id = $1`,
      [row.id, cadenceSeconds]
    );
    due.push({ id: row.id, family: row.family, tier: resolution.tier, cadenceSeconds });
  }

  return due;
}
