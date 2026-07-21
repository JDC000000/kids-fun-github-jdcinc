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
import { resolveVenue } from './venue';
import { upsertOccurrence } from './upsert';
import { recordProvenance } from './provenance';
import { classifyPrimaryCategory, resolvePrimaryCategoryId, applyOccurrenceCategoryTags } from './taxonomy';
import { computeConfidence, loadSourceConfidenceContext, statusForConfidence } from './confidence';
import { isTermsApprovedForProduction } from './terms-gate';
import { parseAgeText, computeAgeBandMatches, loadAgeBands, upsertOccurrenceAge } from './age';

export interface IngestSummary {
  checkRunId: string;
  recordsFound: number;
  seriesCreated: number;
  occurrencesUpserted: number;
  occurrencesCreated: number;
  provenanceRows: number;
  /** Occurrences whose free-text age wording was deterministically resolved into a structured band range. */
  ageResolved: number;
  /** G-T13-3: secondary-category rows written into occurrence_category_tag this run. */
  secondaryCategoriesWritten: number;
  /** G-T13-3: suitability-tag rows written into occurrence_category_tag this run. */
  suitabilityTagsWritten: number;
  /** G-T13-6: occurrences the BR-13 confidence gate routed to needs_review (low/unscored). */
  lowConfidenceFlagged: number;
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
  let ageResolved = 0;
  let secondaryCategoriesWritten = 0;
  let suitabilityTagsWritten = 0;
  let lowConfidenceFlagged = 0;

  try {
    const raw = await adapter.fetch();
    let records = await adapter.extract(raw);
    if (adapter.normalizeHook) {
      const hook = adapter.normalizeHook.bind(adapter);
      records = await Promise.all(records.map((r) => hook(r)));
    }

    // Seeded age bands, loaded once per run for deterministic age normalisation.
    const ageBands = await loadAgeBands(pool);

    // BR-13 confidence context — authority tier, cadence and rolling source-health,
    // loaded ONCE per run (not per record). The in-flight check_run is 'running',
    // which the loader's stat filters exclude, so this never counts itself.
    const confidenceCtx = await loadSourceConfidenceContext(pool, sourceId);

    // Round 27 terms cap (application-layer counterpart of migration 0021's write-time
    // trigger). The staging terms gate deliberately lets a NON-approved source run for
    // fixture review — but its occurrences must never surface as user-visible 'confirmed'
    // (that is exactly how the incident's pending-source rows became confirmed). Loaded
    // once per run; when the source is not terms-approved, the confidence gate's
    // 'confirmed' verdict is held down to 'needs_review' (hidden) BEFORE the upsert, so
    // the DB guard is a pure backstop rather than a hard error on a legitimate run.
    const termsRow = await pool.query<{ terms_status: string | null }>(
      `SELECT terms_status FROM source WHERE id = $1`,
      [sourceId]
    );
    const sourceTermsApproved = isTermsApprovedForProduction(termsRow.rows[0]?.terms_status);

    for (const record of records) {
      recordsFound += 1;
      try {
        const venue = record.venueName
          ? await resolveVenue(pool, {
              name: record.venueName,
              address: record.venueAddress,
              lat: record.venueLat,
              lng: record.venueLng,
              municipalityName: record.venueMunicipalityName,
              displayArea: record.venueDisplayArea,
              officialUrl: record.locationUrl,
            })
          : null;

        // Resolve/create the owning series first — series_id is NOT NULL.
        const series = await resolveSeries(pool, {
          sourceId,
          canonicalTitle: seriesTitleFor(record),
          venueId: venue?.venueId ?? null,
        });
        if (series.created) seriesCreated += 1;

        const primaryCategoryId = await resolvePrimaryCategoryId(pool, record);
        const primaryClass = classifyPrimaryCategory(record);

        // Deterministic age parse first — its resolution feeds parse_quality below.
        // (The occurrence_age row itself needs the occurrenceId, so it's written
        // after the upsert.) Ambiguous wording resolves to null bounds; absent
        // wording is a neutral parse signal, not a failure.
        const ageParse = record.ageText ? parseAgeText(record.ageText) : null;

        // BR-13: real confidence = authority × parse_quality × freshness × volatility.
        // The gate routes low/unscored records to needs_review (hidden until reviewed)
        // instead of the old unconditional 'confirmed'.
        const confidence = computeConfidence({
          authorityTier: confidenceCtx.authorityTier,
          parseQuality: {
            categoryCertainty: primaryClass.certainty,
            explicitCategoryHint: primaryClass.source === 'hint',
            hasStartDatetime: Boolean(record.startDatetimeUtc),
            hasOpenHours: Boolean(record.openHoursState),
            costStatus: record.costStatus,
            ageResolved: ageParse ? ageParse.resolved : null,
          },
          lastCheckAtMs: confidenceCtx.lastCheckAtMs,
          cadenceSeconds: confidenceCtx.cadenceSeconds,
          healthScore: confidenceCtx.healthScore,
          nowMs: Date.now(),
        });
        const confidenceStatus = statusForConfidence(confidence.label);
        if (confidenceStatus === 'needs_review') lowConfidenceFlagged += 1;
        // Terms cap (Round 27): a non-approved source can never surface 'confirmed';
        // hold it at needs_review. Confidence accounting above is left intact so
        // lowConfidenceFlagged keeps meaning "the BR-13 gate held this", not "terms did".
        const statusState =
          confidenceStatus === 'confirmed' && !sourceTermsApproved ? 'needs_review' : confidenceStatus;

        const { occurrenceId, created } = await upsertOccurrence(pool, series.seriesId, record, {
          primaryCategoryId,
          statusState,
          confidenceLabel: confidence.label,
        });
        occurrencesUpserted += 1;
        if (created) occurrencesCreated += 1;

        // G-T13-3: write the secondary categories + suitability tags this record
        // signals into occurrence_category_tag, alongside the primary above.
        const tagResult = await applyOccurrenceCategoryTags(pool, occurrenceId, record);
        secondaryCategoriesWritten += tagResult.secondaryCategories;
        suitabilityTagsWritten += tagResult.suitabilityTags;

        // Deterministic age normalisation: resolve the raw free-text age wording
        // into a structured occurrence_age row so the age search facet works.
        // Ambiguous wording is left unresolved (null bounds) for the future
        // LLM-fallback; unknown/absent wording writes no row (search "don't hide").
        if (ageParse) {
          await upsertOccurrenceAge(pool, occurrenceId, ageParse, computeAgeBandMatches(ageParse, ageBands));
          if (ageParse.resolved) ageResolved += 1;
        }

        const facts = [
          { occurrenceId, field: 'activity_name', sourceUrl: record.sourceUrl, sourceFamily: adapter.family },
          { occurrenceId, field: 'start_datetime_utc', sourceUrl: record.sourceUrl, sourceFamily: adapter.family },
        ];
        if (ageParse?.resolved) {
          facts.push({ occurrenceId, field: 'age_min_months', sourceUrl: record.sourceUrl, sourceFamily: adapter.family });
        }
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
    ageResolved,
    secondaryCategoriesWritten,
    suitabilityTagsWritten,
    lowConfidenceFlagged,
    errors,
  };
}
