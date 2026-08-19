// scripts/backfill-scope/citycalendar-recon.ts — the pure half of the §3.4 CityCalendar
// targeted-re-ingest RECONCILIATION.
//
// READ-ONLY BY CONSTRUCTION AND BY OMISSION. This module has no database import, no network
// import, no clock and no filesystem. It cannot write a row because it has nothing to write
// one with. `citycalendar-recon-run.ts` supplies stored rows and live feed events; everything
// here is a decision about ONE row and is unit-testable without either.
//
// ── WHAT THIS ANSWERS, AND WHY IT IS A DIFFERENT QUESTION FROM measure.ts's ───────────────
// docs/worker-fix-backfill-scope.md §3.4 could only drive the CityCalendar adapter with the
// STORED TITLE plus a synthetic catch-all `Audiences` tag, because production persists neither
// the description nor `customFields` (§4: `StructuredRecord.raw` carries the whole Trumba event
// and is written to no column). With half the guard's haystack missing, that measurement can
// only ever report "the title ALONE does not trigger suppression" — which is why the 10 rows in
// §6's ambiguous table are ambiguous, and why the post-redeploy recheck's `ambiguous: 0` for
// this class is a bucket-label artefact rather than a resolution. Those 10 rows are still
// exactly the open population; they moved from `ambiguous` to `not_applicable` and nothing
// about the underlying uncertainty changed.
//
// §3.4's recommended remedy is (b) TARGETED RE-INGEST: the adapter is a pure function of a feed
// that is still online, so re-fetching the Trumba JSON and joining `eventID` →
// `activity_occurrence.source_record_id` reconstructs the TRUE inputs — description and
// `customFields` included — exactly. This module is the join-and-diff half of that, run as a
// measurement rather than as a correction.
//
// ── THE THREE-VALUED VERDICT, AND WHY THE THIRD VALUE IS NOT A FAILURE ────────────────────
// §3.4 names the catch, and it is the reason this class "is not free": a rolling calendar feed
// no longer carries past-dated occurrences, so some stored rows have NO counterpart in today's
// fetch. Their absence is a property of the feed's retention window, not evidence about the
// row. Collapsing them into `confirms` would silently convert "we did not look" into "we
// checked and it was fine" across the majority of the population — so `cannot-speak` is a
// first-class outcome here, reported with its own count, and NOTHING is inferred from it.
//
//   confirms      today's shipped adapter, driven with the LIVE event, reproduces the stored
//                 claim exactly. The stored row is what the current code would write.
//   contradicts   it produces something else. Subdivided by REMEDY below, because "the next
//                 re-ingest fixes this by itself" and "no re-ingest will ever fix this" are
//                 different problems with the same symptom.
//   cannot-speak  no live counterpart, or a counterpart the shipped adapter would not ingest.
//                 Never an inference in either direction.
//
// ── WHY THE REAL ADAPTER, NOT A COPY OF ITS REGEXES ───────────────────────────────────────
// `namesAdultOnlySubject`, `isCatchAllAudience`, `ADULT_SUBJECT_RE`, `CHILD_AUDIENCE_RE` and
// `CAREGIVER_PROGRAMME_RE` are ALL module-private to worker/adapters/citycalendar/index.ts.
// A copy here would measure a snapshot of `f59cd71` rather than `f59cd71`, and would rot
// silently the first time one is tuned. The driver hands this module the output of the real
// `CityCalendarAdapter.extract()`, so what is reconciled is what ships. Same discipline as
// fix-classes.ts, and the same reason.
import { parseAgeText, parseAudienceLabels, type AgeParse } from '../../worker/core/age';
import type { StructuredRecord } from '../../worker/core/adapter';
import { classifyCityCalendar } from './fix-classes';

/** One city_calendar occurrence as production stores it, joined to its occurrence_age row. */
export interface StoredCityCalendarRow {
  occurrenceId: string;
  /** The Trumba `eventID`, as text. NULL on rows written before migration 0011 added it. */
  sourceRecordId: string | null;
  activityName: string;
  hasAgeRow: boolean;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes: string | null;
  bandCount: number;
  lastCheckedAt: string | null;
  /**
   * The most recent `provenance.fetched_at` for `field = 'age_min_months'` on this occurrence.
   *
   * WHY THIS COLUMN AND NOT ANOTHER. worker/core/ingest.ts:303 appends that provenance fact
   * **only** when `ageParse?.resolved` — so its absence from the newest ingest run is a
   * DIRECT OBSERVATION that the run in question resolved no age claim, rather than an
   * inference from what the row happens to hold now. Both writes use `now()` in separate
   * autocommit statements and `recordProvenance` runs strictly after `upsertOccurrence`, so
   * within one run `fetched_at >= last_checked_at` always. See `observeRow`.
   */
  lastResolvedAgeFactAt: string | null;
}

/**
 * The subset of a Trumba event this module reads for EVIDENCE ONLY — never for a decision.
 * Every decision comes from the adapter's own output. These fields exist so the Operator can
 * re-verify a row-level claim against the feed by eye without re-running anything.
 */
export interface TrumbaEventLike {
  eventID: number | string;
  title?: string;
  description?: string;
  startDateTime?: string;
  canceled?: boolean;
  customFields?: Array<{ label?: string; value?: string }>;
}

export type LiveVerdict = 'confirms' | 'contradicts' | 'cannot-speak';

/**
 * What, if anything, a re-ingest would do about a contradiction. This is the distinction
 * §3h exists to make and the one that decides whether the Operator is being asked for a
 * correction window at all.
 */
export type Remedy =
  /** Stored already equals the live derivation. Nothing to do. */
  | 'none'
  /** The adapter still makes a claim, just a different one — `if (ageParse)` is true, so the
   *  next re-ingest overwrites the row unaided. NOT a backfill candidate. */
  | 'self_heals_on_reingest'
  /** The adapter makes NO claim and a positive claim is stored. worker/core/ingest.ts:294
   *  writes nothing, so the stale claim survives every future re-ingest, forever. THIS is the
   *  bucket that would justify asking the Operator for a correction window. */
  | 'needs_operator_write_3h'
  /** The live feed cannot speak to this row. No remedy can be proposed from this evidence. */
  | 'unknown';

/**
 * Which code path most plausibly wrote the stored row. A notes mismatch means something very
 * different when the row was authored by the LLM age-fallback job than when the adapter wrote
 * it — in the former case the adapter is not the author and the diff is not its contradiction.
 * The shapes are the four `measure.ts` LLM_SHAPES_SQL counts, verbatim.
 */
export type StoredProvenance = 'adapter_or_hand' | 'llm_fallback' | 'no_age_row';

export interface LiveEvidence {
  eventId: string;
  liveTitle: string;
  /** Raw `customFields` Audiences value as published, or null when the field is absent. */
  audiencesField: string | null;
  /** Present so a reader can see whether there WAS a description half of the haystack. */
  descriptionChars: number;
  /**
   * True when the adapter's suppression is the ONLY branch that can explain its silence.
   *
   * This is read off the shipped `ageText()` control flow, not off a copy of its regexes:
   * when the Audiences custom field is present and non-empty, `wording` is non-empty by
   * construction (it is the first arm of the `??` chain), so the `if (!wording) return
   * undefined` early-out cannot fire — and the only other `return undefined` in that function
   * is the `isCatchAllAudience(wording) && namesAdultOnlySubject(hay)` line. An undefined
   * `ageText` under a present Audiences field therefore means the suppression fired, and
   * means nothing else.
   *
   * null when the Audiences field is absent, because then silence is ambiguous between the
   * suppression and the prose fallback simply finding nothing — and this module does not
   * guess.
   */
  suppressionFired: boolean | null;
  /** Whether the shipped `extract()` filter would ingest this event at all. */
  extractable: boolean;
}

export interface ReconFinding {
  occurrenceId: string;
  sourceRecordId: string | null;
  activityName: string;
  liveVerdict: LiveVerdict;
  remedy: Remedy;
  /** Short machine-readable reason. Every count in the report is explainable by one of these. */
  reason: string;
  storedClaim: string;
  derivedClaim: string;
  storedProvenance: StoredProvenance;
  /** The title-only measurement's own bucket for this row — see `priorMeasurementBucket`. */
  priorBucket: string;
  liveEvidence: LiveEvidence | null;
  lastCheckedAt: string | null;
  observation: RowObservation;
}

/**
 * What the DATABASE has already witnessed about this row, as opposed to what this run predicts.
 * measure.ts draws the same distinction with `--deployed-since` and it is the difference
 * between "this row WOULD survive a re-ingest" and "this row HAS survived one".
 */
export interface RowObservation {
  /**
   * Was this row last upserted by the currently-deployed worker build? null when no
   * `--deployed-since` boundary was supplied, or the row has never been checked.
   */
  observedByDeployedBuild: boolean | null;
  /** `provenance.fetched_at` of the newest resolved age fact, if any. */
  lastResolvedAgeFactAt: string | null;
  /**
   * True when the MOST RECENT ingest of this row recorded no resolved age fact — i.e. that run
   * either withheld a claim entirely or produced an unresolved one. Observed from the
   * provenance table, not inferred from the current row value.
   *
   * null when the row has never been checked, because then there is no "most recent run".
   */
  lastIngestRecordedNoResolvedAge: boolean | null;
}

export function observeRow(row: StoredCityCalendarRow, deployedSince: string | null): RowObservation {
  const checkedAt = row.lastCheckedAt === null ? null : Date.parse(row.lastCheckedAt);
  const boundary = deployedSince === null ? null : Date.parse(deployedSince);
  const factAt = row.lastResolvedAgeFactAt === null ? null : Date.parse(row.lastResolvedAgeFactAt);
  return {
    observedByDeployedBuild:
      checkedAt === null || boundary === null || Number.isNaN(checkedAt) || Number.isNaN(boundary)
        ? null
        : checkedAt > boundary,
    lastResolvedAgeFactAt: row.lastResolvedAgeFactAt,
    lastIngestRecordedNoResolvedAge:
      checkedAt === null || Number.isNaN(checkedAt) ? null : factAt === null || Number.isNaN(factAt) || factAt < checkedAt,
  };
}

/**
 * The bucket the TITLE-ONLY measurement put this row in — obtained by calling
 * `fix-classes.classifyCityCalendar` itself rather than by re-deriving its rule, so the
 * cross-check is exact by construction and cannot drift from what `measure.ts` reports.
 *
 * WHY THIS IS IN THE REPORT AT ALL. The post-redeploy recheck shows `ambiguous: 0` for this
 * class, which reads like resolution and is not: all 49 rows sit in `not_applicable`, split
 * `citycalendar:stored-wording-was-not-a-catch-all` ×39 and
 * `citycalendar:title-alone-does-not-trigger-suppression` ×10 — and that second bucket is
 * character-for-character the 10 rows docs §6 lists as ambiguous. Carrying the label onto every
 * row lets this reconciliation be joined back to the earlier measurement without anyone having
 * to trust a hand-copied list of ten IDs.
 */
export function priorMeasurementBucket(row: StoredCityCalendarRow): string {
  return classifyCityCalendar({
    occurrenceId: row.occurrenceId,
    family: 'city_calendar',
    activityName: row.activityName,
    // classifyCityCalendar does not read this field; only classifyVenueAllAges does.
    openHoursState: null,
    hasAgeRow: row.hasAgeRow,
    ageMinMonths: row.ageMinMonths,
    ageMaxMonths: row.ageMaxMonths,
    ageNotes: row.ageNotes,
    bandCount: row.bandCount,
    lastCheckedAt: row.lastCheckedAt,
  }).reason;
}

/** The §6 open population: the rows the title-only measurement could not decide. */
export const OPEN_POPULATION_BUCKET = 'citycalendar:title-alone-does-not-trigger-suppression';

/** A stored age claim is "positive" when it asserts bounds a parent's filter can match on. */
export function hasPositiveClaim(row: StoredCityCalendarRow): boolean {
  return row.hasAgeRow && (row.ageMinMonths !== null || row.ageMaxMonths !== null);
}

export function describeStored(row: StoredCityCalendarRow): string {
  if (!row.hasAgeRow) return 'no occurrence_age row';
  const notes = row.ageNotes === null ? 'NULL' : JSON.stringify(row.ageNotes);
  return `[${row.ageMinMonths ?? '-'}, ${row.ageMaxMonths ?? '∞'}) bands=${row.bandCount} notes=${notes}`;
}

export function describeDerived(parse: AgeParse | null): string {
  if (!parse) return 'no claim (no occurrence_age row would be written — ingest.ts:294)';
  const notes = parse.notes === undefined ? 'NULL' : JSON.stringify(parse.notes);
  return `[${parse.ageMinMonths ?? '-'}, ${parse.ageMaxMonths ?? '∞'}) resolved=${parse.resolved} notes=${notes}`;
}

/**
 * The four `age_notes` shapes worker/llm's age-fallback writes. A row carrying one of these
 * was authored by that job, not by the adapter's parse.
 */
const LLM_NOTES_RE = /^llm-(?:un)?resolved:|\(llm-(?:un)?resolved\)$/;

export function storedProvenance(row: StoredCityCalendarRow): StoredProvenance {
  if (!row.hasAgeRow) return 'no_age_row';
  return row.ageNotes !== null && LLM_NOTES_RE.test(row.ageNotes) ? 'llm_fallback' : 'adapter_or_hand';
}

/**
 * Reproduce worker/core/ingest.ts:237-239 EXACTLY, including the branch CityCalendar does not
 * currently take. Mirroring the whole expression rather than hard-coding `parseAgeText` is
 * deliberate: if the adapter ever starts emitting `ageAudienceLabels`, this reconciliation
 * follows it instead of silently measuring the wrong parser.
 *
 *     const ageParse = record.ageAudienceLabels?.length ? parseAudienceLabels(record.ageAudienceLabels)
 *                    : record.ageText ? parseAgeText(record.ageText) : null;
 */
export function ingestAgeParse(record: StructuredRecord): AgeParse | null {
  return record.ageAudienceLabels?.length
    ? parseAudienceLabels(record.ageAudienceLabels)
    : record.ageText
      ? parseAgeText(record.ageText)
      : null;
}

function audiencesValue(event: TrumbaEventLike): string | null {
  const field = (event.customFields ?? []).find(
    (f) => (f.label ?? '').trim().toLowerCase() === 'audiences'
  );
  const value = (field?.value ?? '').trim();
  return value === '' ? null : value;
}

export function buildEvidence(
  event: TrumbaEventLike,
  record: StructuredRecord | undefined
): LiveEvidence {
  const audiences = audiencesValue(event);
  const extractable = record !== undefined;
  return {
    eventId: String(event.eventID),
    liveTitle: event.title ?? '',
    audiencesField: audiences,
    descriptionChars: (event.description ?? '').length,
    // Only assertable when a wording is guaranteed to exist — see the field's own doc comment.
    suppressionFired:
      !extractable || audiences === null ? null : record.ageText === undefined,
    extractable,
  };
}

/** Do stored and derived assert the same parent-visible bounds? */
function sameBounds(row: StoredCityCalendarRow, parse: AgeParse): boolean {
  return row.ageMinMonths === parse.ageMinMonths && row.ageMaxMonths === parse.ageMaxMonths;
}

function sameNotes(row: StoredCityCalendarRow, parse: AgeParse): boolean {
  // upsertOccurrenceAge writes `parse.notes ?? null`, so `undefined` and NULL are the same
  // stored value. Comparing them as different would manufacture a contradiction out of a
  // TypeScript nicety.
  return row.ageNotes === (parse.notes ?? null);
}

export interface ReconcileInput {
  row: StoredCityCalendarRow;
  /** The live Trumba event this row joins to, or undefined when the feed no longer carries it. */
  event: TrumbaEventLike | undefined;
  /**
   * What the REAL `CityCalendarAdapter.extract()` produced for that event, or undefined when
   * the shipped filter (`!canceled && title && startDateTime`) dropped it. Supplied by the
   * driver so this module never has to know how the adapter works.
   */
  record: StructuredRecord | undefined;
  /** `bootedAt` of the deployed worker. Optional; absent means "no observation boundary". */
  deployedSince?: string | null;
}

/**
 * Classify ONE stored row against the live feed. Total function: every input shape lands on
 * exactly one of the three verdicts with a named reason.
 */
export function reconcileRow({ row, event, record, deployedSince = null }: ReconcileInput): ReconFinding {
  const base = {
    occurrenceId: row.occurrenceId,
    sourceRecordId: row.sourceRecordId,
    activityName: row.activityName,
    storedClaim: describeStored(row),
    storedProvenance: storedProvenance(row),
    priorBucket: priorMeasurementBucket(row),
    lastCheckedAt: row.lastCheckedAt,
    observation: observeRow(row, deployedSince),
  };

  // ── cannot-speak, three ways. None of these is evidence about the row. ──────────────────
  if (row.sourceRecordId === null || row.sourceRecordId === '') {
    return {
      ...base,
      liveVerdict: 'cannot-speak',
      remedy: 'unknown',
      reason: 'no-live-counterpart:row-has-no-source-record-id',
      derivedClaim: 'not derivable — nothing to join on',
      liveEvidence: null,
    };
  }
  if (event === undefined) {
    return {
      ...base,
      liveVerdict: 'cannot-speak',
      remedy: 'unknown',
      // §3.4's named caveat: a rolling feed drops past-dated occurrences. Absence carries no
      // information either way and is NEVER read as agreement.
      reason: 'no-live-counterpart:not-in-current-feed',
      derivedClaim: 'not derivable — event absent from the current feed window',
      liveEvidence: null,
    };
  }
  if (record === undefined) {
    return {
      ...base,
      liveVerdict: 'cannot-speak',
      remedy: 'unknown',
      // The event IS in the feed, but the shipped extract() filter drops it (cancelled, or
      // missing a title / startDateTime), so no re-ingest would derive anything for it.
      reason: 'no-live-counterpart:dropped-by-shipped-extract-filter',
      derivedClaim: 'not derivable — extract() would not ingest this event',
      liveEvidence: buildEvidence(event, undefined),
    };
  }

  const evidence = buildEvidence(event, record);
  const parse = ingestAgeParse(record);
  const derivedClaim = describeDerived(parse);
  const withEvidence = { ...base, derivedClaim, liveEvidence: evidence };

  // ── the live feed can speak. Diff it. ──────────────────────────────────────────────────
  if (parse === null) {
    if (hasPositiveClaim(row)) {
      // THE §3h ROW. The fixed adapter withholds the claim; ingest.ts:294 therefore writes
      // nothing; the stale positive claim survives every future re-ingest, forever.
      return {
        ...withEvidence,
        liveVerdict: 'contradicts',
        remedy: 'needs_operator_write_3h',
        reason: 'contradicted:claim-withdrawn-stale-row-survives-reingest',
      };
    }
    if (row.hasAgeRow) {
      // A row exists but asserts no bounds. Nothing a parent's filter can match on, so the
      // parent-visible claim agrees; the row's mere existence is the only divergence.
      return {
        ...withEvidence,
        liveVerdict: 'confirms',
        remedy: 'none',
        reason: 'confirmed:no-positive-claim-either-side',
      };
    }
    return {
      ...withEvidence,
      liveVerdict: 'confirms',
      remedy: 'none',
      reason: 'confirmed:no-claim-either-side',
    };
  }

  if (!row.hasAgeRow) {
    return {
      ...withEvidence,
      liveVerdict: 'contradicts',
      remedy: 'self_heals_on_reingest',
      reason: 'contradicted:live-derives-a-claim-where-no-row-is-stored',
    };
  }
  if (!sameBounds(row, parse)) {
    return {
      ...withEvidence,
      liveVerdict: 'contradicts',
      remedy: 'self_heals_on_reingest',
      reason: 'contradicted:bounds-differ-overwrite-on-reingest',
    };
  }
  if (!sameNotes(row, parse)) {
    return {
      ...withEvidence,
      liveVerdict: 'contradicts',
      remedy: 'self_heals_on_reingest',
      // Bounds — the parent-visible half — already agree; only the provenance string differs.
      // Reported rather than folded into `confirms`, because it is a different stored value.
      reason: 'contradicted:bounds-match-but-notes-differ',
    };
  }
  // age_band_matches is a deterministic function of (bounds, age_band table) — computed by
  // computeAgeBandMatches from exactly the two numbers just compared — so equal bounds imply
  // equal bands and re-deriving them from the DB would add a query without adding a fact.
  return {
    ...withEvidence,
    liveVerdict: 'confirms',
    remedy: 'none',
    reason: 'confirmed:bounds-and-notes-match',
  };
}

/**
 * Index live events by the key `activity_occurrence.source_record_id` holds:
 * `String(event.eventID)`, which is what `CityCalendarAdapter.extract()` writes into
 * `sourceRecordId`. Kept as a separate exported function so the join is testable on its own —
 * a wrong join would make every downstream verdict wrong in the safest-looking direction
 * (everything becomes `no-live-counterpart`), which is precisely the failure that must not
 * pass silently.
 *
 * Duplicate eventIDs: the feed publishes one entry per occurrence and `eventID` is its
 * identity, but a recurring series can in principle repeat one. FIRST wins and the collision
 * is returned rather than swallowed, so the report can state it.
 */
export function indexFeedByEventId(events: TrumbaEventLike[]): {
  byEventId: Map<string, TrumbaEventLike>;
  duplicateEventIds: string[];
} {
  const byEventId = new Map<string, TrumbaEventLike>();
  const duplicateEventIds: string[] = [];
  for (const event of events) {
    const key = String(event.eventID);
    if (byEventId.has(key)) {
      if (!duplicateEventIds.includes(key)) duplicateEventIds.push(key);
      continue;
    }
    byEventId.set(key, event);
  }
  return { byEventId, duplicateEventIds };
}

/** Index the adapter's OWN output by the same key it writes, so the two indexes cannot drift. */
export function indexRecordsBySourceRecordId(records: StructuredRecord[]): Map<string, StructuredRecord> {
  const byId = new Map<string, StructuredRecord>();
  for (const record of records) {
    if (!byId.has(record.sourceRecordId)) byId.set(record.sourceRecordId, record);
  }
  return byId;
}

export interface ReconTally {
  confirms: number;
  contradicts: number;
  cannotSpeak: number;
}

export function tallyVerdicts(findings: ReconFinding[]): ReconTally {
  return {
    confirms: findings.filter((f) => f.liveVerdict === 'confirms').length,
    contradicts: findings.filter((f) => f.liveVerdict === 'contradicts').length,
    cannotSpeak: findings.filter((f) => f.liveVerdict === 'cannot-speak').length,
  };
}

export function tallyReasons(findings: ReconFinding[]): Array<[string, number]> {
  const byReason = new Map<string, number>();
  for (const f of findings) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  // Sorted by count then name so the output is byte-stable across runs.
  return [...byReason.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Reconcile the whole population. Deterministic: input order in, same order out, no clock,
 * no ambient state.
 */
export function reconcileAll(
  rows: StoredCityCalendarRow[],
  events: TrumbaEventLike[],
  records: StructuredRecord[],
  deployedSince: string | null = null
): { findings: ReconFinding[]; duplicateEventIds: string[] } {
  const { byEventId, duplicateEventIds } = indexFeedByEventId(events);
  const byRecordId = indexRecordsBySourceRecordId(records);
  const findings = rows.map((row) => {
    const key = row.sourceRecordId ?? '';
    return reconcileRow({
      row,
      event: byEventId.get(key),
      record: byRecordId.get(key),
      deployedSince,
    });
  });
  return { findings, duplicateEventIds };
}
