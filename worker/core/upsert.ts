// worker/core/upsert.ts — G-T5-4: idempotent occurrence upsert + confidence
// scaffolding (TSD §6.1, §5.2). Idempotent on (series_id, source_record_id) —
// re-ingesting the same source record updates in place rather than
// duplicating. This is a *same-source* idempotency key, distinct from T14's
// Deduplication engine, which later merges duplicates found *across*
// different sources by fuzzy title/venue/time similarity.
import type { Pool } from 'pg';
import type { StructuredRecord } from './adapter';

export interface UpsertResult {
  occurrenceId: string;
  created: boolean;
}

export interface UpsertFields {
  primaryCategoryId?: string | null;
  statusState?: string;
  /** Confidence label placeholder — full scoring (authority x parse quality x
   *  freshness x volatility, BR-13) lands with the normalisation pipeline (T13). */
  confidenceLabel?: string;
}

export async function upsertOccurrence(
  pool: Pool,
  seriesId: string,
  record: StructuredRecord,
  fields: UpsertFields = {}
): Promise<UpsertResult> {
  const { rows } = await pool.query(
    `INSERT INTO activity_occurrence (
       series_id, source_record_id, activity_name,
       primary_category_id, start_datetime_utc, end_datetime_utc, open_hours_state,
       cost_min_cad, cost_max_cad, cost_status, source_url, booking_url, location_url,
       status_state, confidence_label, last_checked_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (series_id, source_record_id) WHERE source_record_id IS NOT NULL
     DO UPDATE SET
       activity_name        = EXCLUDED.activity_name,
       primary_category_id  = COALESCE(EXCLUDED.primary_category_id, activity_occurrence.primary_category_id),
       start_datetime_utc    = EXCLUDED.start_datetime_utc,
       end_datetime_utc      = EXCLUDED.end_datetime_utc,
       open_hours_state      = EXCLUDED.open_hours_state,
       cost_min_cad          = EXCLUDED.cost_min_cad,
       cost_max_cad          = EXCLUDED.cost_max_cad,
       cost_status           = EXCLUDED.cost_status,
       source_url            = EXCLUDED.source_url,
       booking_url           = EXCLUDED.booking_url,
       location_url          = EXCLUDED.location_url,
       status_state          = EXCLUDED.status_state,
       confidence_label      = EXCLUDED.confidence_label,
       last_checked_at       = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      seriesId,
      record.sourceRecordId,
      record.title,
      fields.primaryCategoryId ?? null,
      record.startDatetimeUtc ?? null,
      record.endDatetimeUtc ?? null,
      record.openHoursState ?? null,
      record.costMinCad ?? null,
      record.costMaxCad ?? null,
      record.costStatus ?? 'unknown',
      record.sourceUrl,
      record.bookingUrl ?? null,
      record.locationUrl ?? null,
      fields.statusState ?? 'needs_review',
      fields.confidenceLabel ?? 'unscored',
    ]
  );
  return { occurrenceId: rows[0].id, created: rows[0].created };
}
