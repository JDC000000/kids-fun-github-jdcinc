// worker/core/ingest.ts — G-T5-4: per-source ingest runner (TSD §5.2, §6.1/§6.2).
// The production wiring that ties the pieces together for one source:
//   startCheckRun → adapter.fetch → extract → (normalizeHook, P) →
//   resolveSeries (create/reuse activity_series) → upsertOccurrence(series_id, …) →
//   recordProvenance → finishCheckRun.
//
// This closes the series_id wiring gap: occurrence.series_id is NOT NULL, so
// every record is attached to a resolved series BEFORE the DB-backed upsert runs.
// Per-record failures are collected (not thrown) so one bad record can't sink the
// whole run — they surface via the check-run status/errors for the health board.
import type { Pool } from 'pg';
import type { Adapter, StructuredRecord } from './adapter';
import { startCheckRun, finishCheckRun } from './checkrun';
import { resolveSeries } from './series';
import { upsertOccurrence } from './upsert';
import { recordProvenance } from './provenance';
import { confidenceLabelForCategory, resolvePrimaryCategoryId } from './taxonomy';

export interface IngestSummary {
  checkRunId: string;
  recordsFound: number;
  seriesCreated: number;
  occurrencesUpserted: number;
  occurrencesCreated: number;
  provenanceRows: number;
  errors: string[];
}

/**
 * Series identity for a record. Venue-qualified so the same program title at two
 * different venues does not collapse into one series; date is deliberately
 * excluded so every date of a program shares one series (§6.2). Occurrence
 * idempotency stays (series_id, source_record_id), so this only groups.
 */
function seriesTitleFor(record: StructuredRecord): string {
  return record.venueName ? `${record.title} — ${record.venueName}` : record.title;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one full ingest for `adapter` against `sourceId`, recording the audit trail. */
export async function ingestSource(
  pool: Pool,
  adapter: Adapter,
  sourceId: string
): Promise<IngestSummary> {
  const { id: checkRunId, startedAt } = await startCheckRun(pool, sourceId);
  const errors: string[] = [];
  let recordsFound = 0;
  let seriesCreated = 0;
  let occurrencesUpserted = 0;
  let occurrencesCreated = 0;
  let provenanceRows = 0;

  try {
    const raw = await adapter.fetch();
    let records = await adapter.extract(raw);
    if (adapter.normalizeHook) {
      const hook = adapter.normalizeHook.bind(adapter);
      records = await Promise.all(records.map((r) => hook(r)));
    }

    for (const record of records) {
      recordsFound += 1;
      try {
        // Resolve/create the owning series first — series_id is NOT NULL.
        const series = await resolveSeries(pool, {
          sourceId,
          canonicalTitle: seriesTitleFor(record),
        });
        if (series.created) seriesCreated += 1;

        const primaryCategoryId = await resolvePrimaryCategoryId(pool, record);
        const { occurrenceId, created } = await upsertOccurrence(pool, series.seriesId, record, {
          primaryCategoryId,
          statusState: 'confirmed',
          confidenceLabel: confidenceLabelForCategory(record),
        });
        occurrencesUpserted += 1;
        if (created) occurrencesCreated += 1;

        const facts = [
          { occurrenceId, field: 'activity_name', sourceUrl: record.sourceUrl, sourceFamily: adapter.family },
          { occurrenceId, field: 'start_datetime_utc', sourceUrl: record.sourceUrl, sourceFamily: adapter.family },
        ];
        await recordProvenance(pool, facts);
        provenanceRows += facts.length;
      } catch (err) {
        errors.push(`record ${record.sourceRecordId}: ${errMsg(err)}`);
      }
    }
  } catch (err) {
    errors.push(`fetch/extract: ${errMsg(err)}`);
  }

  const status =
    errors.length === 0 ? 'success' : occurrencesUpserted > 0 ? 'partial' : 'failed';
  await finishCheckRun(pool, checkRunId, {
    status,
    recordsFound,
    errors: errors.length > 0 ? errors : undefined,
    startedAt,
  });

  return {
    checkRunId,
    recordsFound,
    seriesCreated,
    occurrencesUpserted,
    occurrencesCreated,
    provenanceRows,
    errors,
  };
}
