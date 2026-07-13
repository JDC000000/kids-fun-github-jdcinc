// worker/scheduler/tiered.ts — G-T5-3: tiered cadence scheduler (TSD §7.2).
// Cadence lives in the `source` table (config, not code): baseline_cadence
// (daily default) + near_date_cadence (sub-daily, nullable, preferred when
// set — the "volatile" tier). This function is the single source of truth
// for "what's due right now" and is trigger-agnostic: call it from a
// pg_cron job (Supabase), a Vercel Cron-hit API route, or the worker's own
// setInterval — whichever mechanism a given environment has available.
import type { Pool } from 'pg';

export interface DueSource {
  id: string;
  family: string;
}

/** Enqueues an ingest job for every source whose cadence says it's due.
 *  Idempotent per tick: skips sources with an already-pending/running job.
 *  Scheduler is live-run oriented, so it only enqueues explicitly approved
 *  terms+robots sources; fixture-only staging review uses ingest-once. */
export async function enqueueDueJobs(pool: Pool): Promise<DueSource[]> {
  const { rows } = await pool.query<DueSource>(
    `SELECT s.id, s.family
     FROM source s
     WHERE s.terms_status IN ('allowed', 'summarise_only')
       AND s.robots_status = 'allowed'
       AND (s.next_check_at IS NULL OR s.next_check_at <= now())
       AND NOT EXISTS (
         SELECT 1 FROM job_queue jq
         WHERE jq.source_id = s.id AND jq.status IN ('pending', 'running')
       )`
  );

  for (const source of rows) {
    await pool.query(
      `INSERT INTO job_queue (source_id, job_type, scheduled_for) VALUES ($1, 'ingest', now())`,
      [source.id]
    );
    await pool.query(
      `UPDATE source
       SET next_check_at = now() + COALESCE(near_date_cadence, baseline_cadence)
       WHERE id = $1`,
      [source.id]
    );
  }

  return rows;
}
