// worker/core/series.ts — G-T5-4 series resolution (TSD §6.1, §6.2).
// activity_occurrence.series_id is NOT NULL, so every occurrence must be
// attached to an activity_series. upsertOccurrence() takes a seriesId; this is
// the resolver that produces it — resolve-or-insert on (source_id,
// canonical_title) so all dates of a recurring program share one series and the
// series is not duplicated across ingest runs.
//
// activity_series has a unique index on (source_id, canonical_title), so this
// uses INSERT ... ON CONFLICT DO NOTHING and a follow-up SELECT. That keeps the
// resolver race-safe even if a manual one-off run overlaps with the queued run.
import type { Pool } from 'pg';

export interface SeriesInput {
  sourceId: string;
  canonicalTitle: string;
  /** Optional geocoded venue (activity_series.venue_id). */
  venueId?: string | null;
  /** RRULE-style string; null for one-off / open-hours series. */
  recurrenceRule?: string | null;
}

export interface SeriesResult {
  seriesId: string;
  /** true if a new series row was created, false if an existing one was reused. */
  created: boolean;
}

export async function resolveSeries(pool: Pool, input: SeriesInput): Promise<SeriesResult> {
  const params = [
    input.canonicalTitle,
    input.sourceId,
    input.venueId ?? null,
    input.recurrenceRule ?? null,
  ];

  const inserted = await pool.query<{ id: string; created: boolean }>(
    `INSERT INTO activity_series (canonical_title, source_id, venue_id, recurrence_rule)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id, canonical_title) DO UPDATE SET
       venue_id = COALESCE(activity_series.venue_id, EXCLUDED.venue_id),
       recurrence_rule = COALESCE(activity_series.recurrence_rule, EXCLUDED.recurrence_rule),
       updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    params
  );
  if (inserted.rows[0]) {
    return { seriesId: inserted.rows[0].id, created: inserted.rows[0].created };
  }

  // Defensive fallback for databases where the conflict target is missing during
  // early local development. Current canonical migrations have the unique index.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM activity_series
     WHERE source_id = $1 AND canonical_title = $2
     LIMIT 1`,
    [input.sourceId, input.canonicalTitle]
  );
  if (!existing.rows[0]) {
    throw new Error('series conflict resolution failed: existing row not found');
  }
  return { seriesId: existing.rows[0].id, created: false };
}
