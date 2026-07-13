// worker/core/series.ts — G-T5-4 series resolution (TSD §6.1, §6.2).
// activity_occurrence.series_id is NOT NULL, so every occurrence must be
// attached to an activity_series. upsertOccurrence() takes a seriesId; this is
// the resolver that produces it — resolve-or-insert on (source_id,
// canonical_title) so all dates of a recurring program share one series and the
// series is not duplicated across ingest runs.
//
// activity_series has no unique constraint on (source_id, canonical_title), so
// this does a lookup-then-insert rather than ON CONFLICT. A per-source ingest
// runs as a single active job (the queue guards one running job per source), so
// concurrent duplicate inserts for one source are not expected; a future series
// dedup index would harden this against races.
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
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM activity_series
     WHERE source_id = $1 AND canonical_title = $2
     LIMIT 1`,
    [input.sourceId, input.canonicalTitle]
  );
  if (existing.rows[0]) {
    return { seriesId: existing.rows[0].id, created: false };
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id, venue_id, recurrence_rule)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.canonicalTitle, input.sourceId, input.venueId ?? null, input.recurrenceRule ?? null]
  );
  return { seriesId: inserted.rows[0].id, created: true };
}
