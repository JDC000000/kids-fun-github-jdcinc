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
import { startCheckRun, finishCheckRun, loadRecordsFoundBaseline, loadPreviousHealthAlertCode, type RunHealthAlert } from './checkrun';
import { resolveSeries } from './series';
import { resolveVenue } from './venue';
import { upsertOccurrence } from './upsert';
import { recordProvenance } from './provenance';
import { classifyPrimaryCategory, resolvePrimaryCategoryId, applyOccurrenceCategoryTags } from './taxonomy';
import {
  computeConfidence,
  loadSourceConfidenceContext,
  statusForConfidence,
  statusForIngestedRecord,
} from './confidence';
import { isTermsApprovedForProduction } from './terms-gate';
import { withNormalizedTitle } from './title';
import {
  parseAgeText,
  resolveRecordAge,
  parseAudienceLabels,
  computeAgeBandMatches,
  loadAgeBands,
  upsertOccurrenceAge,
} from './age';

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
  /**
   * G-T10-3 (IR-08): occurrences written as `manual_candidate` — an EDITORIAL-tier
   * source's records, entering as unverified leads rather than confirmed fact. Counted
   * so an editorial run is legible on the health board instead of looking like a run
   * that confirmed nothing.
   */
  editorialCandidates: number;
  /**
   * F-11: the adapter's own health verdict for this run, or null if it raised none. Also
   * persisted to source_check_run.health_alert_code/detail — that column, not this field,
   * is what the dashboard and the SLA read.
   */
  healthAlert: RunHealthAlert | null;
  /**
   * How many items the source's feed delivered, before any of our filtering or capping —
   * null when the adapter reports none (fixture runs, adapters with no feed). Persisted to
   * source_check_run.items_in_feed; that column, not this field, is what a later query reads.
   *
   * NOT the same quantity as `recordsFound`, which counts what we EMITTED and is therefore
   * censored by our own `liveEventsLimit`.
   */
  itemsInFeed: number | null;
  /**
   * EXECUTION errors only — things that went wrong DOING the run (a fetch that threw, a
   * record that would not upsert), plus a health verdict that has now persisted across
   * consecutive runs.
   *
   * ⚠ THIS ARRAY IS THE JOB'S SUCCESS PREDICATE, not just a list for humans.
   * `runTermsGatedIngest` derives `ok` from `errors.length === 0` and the queue handler
   * THROWS when `ok` is false — so anything put here retries the entire crawl up to
   * max_attempts and raises a Sentry error on every attempt. Putting a one-run
   * observation here cost 182 false alerts and 2–5 redundant crawls per incident; see the
   * assessRun block in ingestSource. An observation about the DATA belongs in
   * `healthAlert` and in the check run's persisted `errors` jsonb, not here.
   */
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
  let editorialCandidates = 0;
  let healthAlert: RunHealthAlert | null = null;
  /** True when the PREVIOUS run raised the same verdict — see the assessRun block below. */
  let healthAlertSustained = false;
  /** The feed's own item count for this run — see where it is read, below. */
  let itemsInFeed: number | null = null;

  try {
    const raw = await adapter.fetch();
    let records = await adapter.extract(raw);
    if (adapter.normalizeHook) {
      const hook = adapter.normalizeHook.bind(adapter);
      records = await Promise.all(records.map((r) => hook(r)));
    }

    // P1-3: strip source packaging out of the title, keeping the source's own wording in
    // `sourceTitle`. See worker/core/title.ts for what is stripped and what each rule
    // demands as evidence.
    //
    // THIS LINE'S POSITION IS THE CORRECTNESS CONSTRAINT, not a formatting preference. It sits
    // AFTER extract() and normalizeHook() because two adapters read the raw title to derive
    // `ageText` (activenet's extractAgeText admits the whole title when it states an age;
    // eventbrite's extractAgeWording runs over e.name). Both have already run and already
    // produced their `ageText` by the time this executes, so the strings worker/core/age.ts
    // parses below — `record.ageText` and `record.ageAudienceLabels` — are exactly what they
    // were before this normaliser existed. age.ts never reads `record.title`.
    //
    // Everything downstream of here DOES see the clean title, deliberately: the series
    // canonical_title, the taxonomy classifier, the FTS vector and the persisted
    // activity_name. That is the point — the junk stops at the front door instead of being
    // stripped again by every reader.
    records = records.map(withNormalizedTitle);

    // THE FEED'S OWN ITEM COUNT — recorded UNCONDITIONALLY, and read BEFORE the verdict
    // block below on purpose.
    //
    // Everything the verdict carries is discarded on a non-alerting run: the `if
    // (verdict?.alert)` below has no else branch and no logging path, so an `ok` verdict's
    // detail is computed and dropped. A source that is quietly capped by its vendor on every
    // run is `ok` on every run, so nothing about it has ever reached a durable surface. That
    // is the blind spot this line closes, and it only closes it by being independent of the
    // verdict — hence a separate adapter method, read outside the branch, before it.
    //
    // Distinct from `recordsFound` below, which counts what the adapter EMITTED and is
    // therefore censored by our own `liveEventsLimit`. This is the same run measured before
    // our cap touches it. Null for fixture runs and for adapters with no feed to count.
    itemsInFeed = adapter.reportItemsInFeed?.() ?? null;

    // Adapter self-assessment (optional). A run over an undocumented, unversioned source
    // can complete without throwing and still be broken — the vendor moves a key, the
    // parser yields nothing, and the check run reports a cheerful green over an empty
    // municipality. Adapters that implement assessRun() get to say so.
    //
    // ═══ THE VERDICT IS AN OBSERVATION ABOUT THE DATA, NOT AN EXECUTION ERROR ═══
    // It used to be pushed into `errors`, and that turned out to have a THIRD effect
    // nobody intended. F-11's note said the verdict travels "two ways" — the panel line
    // and the `healthAlert` column — and listed only those. But `errors` is also the
    // JOB'S SUCCESS PREDICATE: source-runner.ts derives `ok` from
    // `summary.errors.length === 0`, and the queue handler throws when `ok` is false. So
    // every health verdict silently became a thrown job failure, which means:
    //   • the queue retried the ENTIRE crawl up to max_attempts (5);
    //   • the scheduler reported every attempt to Sentry as an uncaught worker exception;
    //   • for a politeness-gated source the 30s×attempts retry landed INSIDE the adapter's
    //     own crawl-backoff window, so the retry fetched nothing, which scored as a fresh
    //     yield collapse, which threw again — the alert manufacturing its own evidence.
    //
    // Measured in production before this change: 182 Sentry errors between 2026-08-11 and
    // 2026-09-14, every one of them `yield_collapse`. Every job that raised one reached
    // `status = 'done'` on a later attempt (job_queue), i.e. NOT ONE was a real ingestion
    // regression — they were short runs (burnaby 376/881 records against a steady 2441;
    // nvrc 0 against a steady 1157) that the next run corrected on its own. The cost was
    // 2–5 extra full crawls per incident against a vendor portal that was already
    // partially unavailable, plus an alarm nobody could act on.
    //
    // So the verdict now travels exactly the two ways F-11 described and NO OTHER:
    //   • into the check run's persisted `errors` jsonb (see `persistedErrors` below), so
    //     the panel renders the identical line it always did;
    //   • into `healthAlert`, which finishCheckRun writes to its own column.
    // `summary.errors` — the array the job's success predicate reads — is now execution
    // errors ONLY. Degrading the run's status is done explicitly below rather than as a
    // side effect of which array the string landed in.
    //
    // ═══ AND A REPEAT VERDICT IS STILL AN ERROR ═══
    // Removing the verdict from `errors` on its own would silence the alarm entirely, which
    // is the opposite failure: a source that genuinely empties would then run green forever
    // on the one channel anybody watches. What separates the two cases is PERSISTENCE, not a
    // wider threshold. A verdict that does not repeat was a blip the next run corrected — all
    // 182 of them were. A verdict the PREVIOUS run also raised is a source that did not come
    // back, and that is worth failing the job over: it fails loudly, retries, and reaches
    // Sentry exactly as it did before. Detection is delayed by one cadence (~1–2h for these
    // sources), which is the price of not crying wolf six times a day.
    if (adapter.assessRun) {
      const baseline = await loadRecordsFoundBaseline(pool, sourceId);
      const verdict = adapter.assessRun(baseline);
      if (verdict?.alert) {
        healthAlert = { code: verdict.code, detail: verdict.detail };
        const previousCode = await loadPreviousHealthAlertCode(pool, sourceId, checkRunId);
        if (previousCode === verdict.code) {
          healthAlertSustained = true;
          errors.push(
            `run health [${verdict.code}] SUSTAINED (2+ consecutive runs): ${verdict.detail}`
          );
        }
      }
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
              phone: record.venuePhone,
              lat: record.venueLat,
              lng: record.venueLng,
              // The coordinate and its declared authority travel TOGETHER through this hop.
              // Dropping the authority here would not lose provenance quietly — resolveVenue
              // throws on a coordinate with no authority — which is the point: the middle hop
              // is exactly where venuePhone was silently lost for two days before 0024.
              geoAuthority: record.venueGeoAuthority,
              geoSource: record.venueGeoSource,
              geoAttribution: record.venueGeoAttribution,
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
        // A source's own structured audience tags outrank free-text wording, and they resolve
        // by a different rule (union of every tag, not first-keyword-wins) — see
        // StructuredRecord.ageAudienceLabels. The adapter has already decided which signal
        // won for this record, so there is no precedence logic here beyond "structured first".
        // Precedence lives in worker/core/age.ts#resolveRecordAge so it is testable
        // without a database: source numbers > source tags > our reading of source prose.
        const ageParse = resolveRecordAge(record);

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
        // The composed write-path decision: BR-13 confidence gate, then IR-08's
        // editorial-candidate gate (G-T10-3), then the Round 27 terms cap. All three
        // live in worker/core/confidence.ts's statusForIngestedRecord() so the
        // precedence between them is stated once and unit-testable without a DB.
        // The confidence accounting above is left intact, so lowConfidenceFlagged keeps
        // meaning "the BR-13 gate held this" — not "terms did" or "editorial did".
        const statusState = statusForIngestedRecord({
          confidenceLabel: confidence.label,
          authorityTier: confidenceCtx.authorityTier,
          sourceTermsApproved,
        });
        if (statusState === 'manual_candidate') editorialCandidates += 1;

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

  // The run's EXECUTION status: did the work we attempted actually complete?
  const executionStatus =
    errors.length === 0 ? 'success' : occurrencesUpserted > 0 ? 'partial' : 'failed';

  // …then the health verdict degrades it, EXPLICITLY. This is the same arithmetic the old
  // `errors.push` produced by accident, restated as the rule it always was: an alerting
  // verdict must never leave a run looking green, because "cheerfully green over an empty
  // municipality" is the exact failure the adapters' assessRun() exists to catch. A run
  // that still upserted records is degraded to 'partial'; one that upserted none is
  // 'failed' — which is what keeps nvrc's 0-record run off the success ratio.
  const status =
    healthAlert && executionStatus === 'success'
      ? occurrencesUpserted > 0
        ? 'partial'
        : 'failed'
      : executionStatus;

  // What the health board renders. The verdict line is folded in HERE rather than pushed
  // into `errors` above, so the persisted jsonb is what it has always been while
  // `summary.errors` stays clean for the job's success predicate.
  //
  // PREPENDED, not appended, and the difference is load-bearing. The old `errors.push` ran
  // inside the try block immediately after assessRun() — BEFORE the per-record loop that
  // appends `record <id>: …` lines — so on a run that both alerted AND had record errors the
  // verdict was element 0. And element 0 is not an arbitrary slot: lib/admin/dashboard.ts
  // reads `cr.errors #>> '{0}'` as the failed-run panel's `errorSummary`. Appending here
  // would have replaced the health verdict with "record abc123: bad date" on the one line an
  // operator actually reads. No production row has ever carried more than one element, which
  // is precisely why this would have gone unnoticed — not why it would not have mattered.
  //
  // A sustained verdict already put its own, louder line into `errors` at that same point in
  // the run, so it is not re-added here; doing both would print the same collapse twice.
  const persistedErrors =
    healthAlert && !healthAlertSustained
      ? [`run health [${healthAlert.code}]: ${healthAlert.detail}`, ...errors]
      : errors;

  await finishCheckRun(pool, checkRunId, {
    status,
    recordsFound,
    itemsInFeed,
    errors: persistedErrors.length > 0 ? persistedErrors : undefined,
    healthAlert,
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
    editorialCandidates,
    healthAlert,
    itemsInFeed,
    errors,
  };
}
