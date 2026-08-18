// worker/adapters/venue/separate.ts — G-T11-2: open-hours series vs special-event
// occurrence separation (TSD §6.2 series-vs-occurrence, correctness rule T-02).
//
// A venue (museum / attraction) publishes two structurally different things on
// the same page:
//
//   1. Regular OPEN HOURS — e.g. "the aquarium is open daily 9am–5pm". This is a
//      standing state, NOT a scheduled event. It becomes ONE activity_series with
//      an open_hours_state occurrence and NO fixed start time (recurrence_rule
//      stays null — see worker/core/series.ts / ingest.ts). The DB models this
//      directly: activity_occurrence.open_hours_state (migration 0004) with a
//      CHECK (start_datetime_utc IS NOT NULL OR open_hours_state IS NOT NULL).
//
//   2. SPECIAL EVENTS — e.g. a one-off "Ocean After Hours" evening program. Each
//      is a DISCRETE dated occurrence with start/end datetimes and NO
//      open_hours_state.
//
// The correctness rule (T-02, "Aquarium daily visit ≠ pool swim"): the daily
// open-hours "visit" must never be conflated with a dated program, and a dated
// program must never be folded into open_hours_state. assertSeparation() enforces
// the invariant structurally so a parser bug can't silently miscategorise one as
// the other — matching exactly the DB's occurrence_has_time_or_open_hours CHECK,
// and additionally pinning open-hours "admission" to a venue category
// (attraction / museum_venue), never a rec-programme category such as public_swim.
import type { StructuredRecord } from '../../core/adapter';
import { VENUE_GEO_AUTHORITY } from '../../core/venue-geo-authority';

type CostStatus = NonNullable<StructuredRecord['costStatus']>;

/** Venue categories an open-hours "general admission" record may carry. Kept
 *  narrow so the daily visit can never drift into a rec-programme category
 *  (public_swim / skate / open_gym) — the T-02 "Aquarium ≠ swim" guard. */
export type VenueCategory = 'attraction' | 'museum_venue';

export interface VenueIdentity {
  /** Stable registry/env key for the venue, e.g. 'vancouver-aquarium'. */
  venueKey: string;
  /** Human venue name (also the venue row name). */
  venueName: string;
  /** Open-hours admission category — never a rec-programme category. */
  venueCategory: VenueCategory;
  officialUrl: string;
  address?: string;
  displayArea?: string;
  municipality?: string;
  lat?: number;
  lng?: number;
}

export interface OpenHoursInput {
  /** Human-readable standing state, e.g. "Daily 9:00 AM–5:00 PM". */
  openHoursState: string;
  /** Series/occurrence title for the standing admission. Default "General Admission". */
  admissionLabel?: string;
  /** Admission cost posture; venue admission is typically paid → 'check_source'. */
  costStatus?: CostStatus;
  sourceUrl: string;
  bookingUrl?: string;
}

export interface SpecialEventInput {
  /** Source-native slug/id used to build the dedup key. */
  slug: string;
  title: string;
  /** ISO 8601 UTC — REQUIRED: a special event is always a dated occurrence. */
  startDatetimeUtc: string;
  endDatetimeUtc?: string;
  costStatus?: CostStatus;
  ageText?: string;
  sourceUrl: string;
  bookingUrl?: string;
  /** Optional explicit category hint; otherwise left for title classification. */
  categoryHint?: string;
}

export interface SeparatedVenueRecords {
  /** Standing open-hours records (open_hours_state set, no start datetime). */
  openHours: StructuredRecord[];
  /** Dated special-event records (start datetime set, no open_hours_state). */
  specialEvents: StructuredRecord[];
  /** openHours ++ specialEvents, in ingest order. */
  all: StructuredRecord[];
}

const DEFAULT_ADMISSION_LABEL = 'General Admission';

/** venue-level fields common to every record emitted for a venue. */
function venueFields(venue: VenueIdentity): Partial<StructuredRecord> {
  return {
    venueName: venue.venueName,
    venueAddress: venue.address,
    venueLat: venue.lat,
    venueLng: venue.lng,
    // Hand-entered site coordinates in worker/adapters/venue/config.ts, no geocoder and no
    // per-entry provenance — the same class of claim as citycalendar's venueGeo, so the same
    // tier. These two venues are contested by nobody today; the declaration exists so that
    // stays a fact about the data rather than an assumption about it.
    venueGeoAuthority:
      venue.lat !== undefined && venue.lng !== undefined
        ? VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL
        : undefined,
    venueGeoSource:
      venue.lat !== undefined && venue.lng !== undefined ? `venue:${venue.venueKey}:config` : undefined,
    venueMunicipalityName: venue.municipality,
    venueDisplayArea: venue.displayArea,
    locationUrl: venue.officialUrl,
  };
}

/** Build the standing open-hours record: open_hours_state set, NO start datetime. */
export function buildOpenHoursRecord(venue: VenueIdentity, input: OpenHoursInput): StructuredRecord {
  return {
    ...venueFields(venue),
    sourceRecordId: 'open-hours',
    title: input.admissionLabel?.trim() || DEFAULT_ADMISSION_LABEL,
    openHoursState: input.openHoursState,
    // Explicitly NO startDatetimeUtc/endDatetimeUtc — this is a standing state.
    costStatus: input.costStatus ?? 'check_source',
    // Pin to a venue category so the daily visit is never classified as a
    // rec-programme (public_swim / skate / open_gym) — T-02.
    categoryHint: venue.venueCategory,
    // Deliberately NO ageText. A venue's opening-hours markup states when the doors are
    // open, never who the visit is for, and OpenHoursInput carries no age member for a
    // caller to supply one — so any value here would be this builder's own invention, not
    // the source's claim. It used to hardcode 'All ages', which worker/core/age.ts resolves
    // to [0, ∞) `resolved: true` and so scored parse_quality.ageResolved as a FULLY RESOLVED
    // age — the BR-13 formula (worker/core/confidence.ts) then credited a literal typed here
    // exactly as much as a source's genuine structured age bounds. Leaving it undefined makes
    // ageParse null, i.e. "this record makes no age claim", which is the honest signal and
    // the neutral (0.6) age term the formula documents for it. Same posture as
    // buildSpecialEventRecord below, which passes input.ageText through undefaulted.
    sourceUrl: input.sourceUrl,
    bookingUrl: input.bookingUrl,
  };
}

/** Build a discrete special-event record: start datetime set, NO open_hours_state. */
export function buildSpecialEventRecord(venue: VenueIdentity, input: SpecialEventInput): StructuredRecord {
  return {
    ...venueFields(venue),
    sourceRecordId: `event::${input.slug}`,
    title: input.title,
    startDatetimeUtc: input.startDatetimeUtc,
    endDatetimeUtc: input.endDatetimeUtc,
    // Explicitly NO openHoursState — a dated event is not a standing state.
    costStatus: input.costStatus ?? 'check_source',
    ageText: input.ageText,
    categoryHint: input.categoryHint,
    sourceUrl: input.sourceUrl,
    bookingUrl: input.bookingUrl,
  };
}

/** True for a standing open-hours record (state set, no fixed start time). */
export function isOpenHoursRecord(record: StructuredRecord): boolean {
  return Boolean(record.openHoursState) && !record.startDatetimeUtc;
}

/** True for a discrete dated special-event record. */
export function isSpecialEventRecord(record: StructuredRecord): boolean {
  return Boolean(record.startDatetimeUtc) && !record.openHoursState;
}

/**
 * Structural guard for the series-vs-occurrence split (T-02). Throws if any
 * record is ambiguous — carrying BOTH a start datetime and open_hours_state, or
 * NEITHER (which the DB CHECK would also reject), or an open-hours record that
 * has slipped into a rec-programme category. Called by separateVenueRecords()
 * before the records reach the pipeline so a miscategorisation fails loudly at
 * ingest rather than surfacing a daily "visit" as a scheduled programme.
 */
export function assertSeparation(records: StructuredRecord[]): void {
  const REC_PROGRAMME_CATEGORIES = new Set(['public_swim', 'skate', 'open_gym']);
  for (const r of records) {
    const hasStart = Boolean(r.startDatetimeUtc);
    const hasOpenHours = Boolean(r.openHoursState);
    if (hasStart && hasOpenHours) {
      throw new Error(
        `venue record "${r.title}" (${r.sourceRecordId}) is BOTH dated and open-hours — a special event must not carry open_hours_state`
      );
    }
    if (!hasStart && !hasOpenHours) {
      throw new Error(
        `venue record "${r.title}" (${r.sourceRecordId}) has neither a start datetime nor open_hours_state — violates occurrence_has_time_or_open_hours`
      );
    }
    if (hasOpenHours && r.categoryHint && REC_PROGRAMME_CATEGORIES.has(r.categoryHint)) {
      throw new Error(
        `venue open-hours record "${r.title}" is categorised as "${r.categoryHint}" — a daily venue visit must not be a rec programme (T-02: Aquarium ≠ swim)`
      );
    }
  }
}

/**
 * Split a venue's parsed data into one open-hours series record and its discrete
 * special-event occurrences, enforcing the T-02 separation invariant.
 */
export function separateVenueRecords(
  venue: VenueIdentity,
  parsed: { openHours?: OpenHoursInput; events: SpecialEventInput[] }
): SeparatedVenueRecords {
  const openHours = parsed.openHours ? [buildOpenHoursRecord(venue, parsed.openHours)] : [];
  const specialEvents = parsed.events.map((e) => buildSpecialEventRecord(venue, e));
  const all = [...openHours, ...specialEvents];
  assertSeparation(all);
  return { openHours, specialEvents, all };
}
