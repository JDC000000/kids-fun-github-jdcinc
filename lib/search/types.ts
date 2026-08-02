// lib/search/types.ts — Search domain types (TSD §5A, §6).
//
// These types are the read-model contract for search. They mirror the canonical
// Postgres schema (TSD §6.1) but are denormalised into a single `ListingRecord`
// that represents a search candidate (an `activity_occurrence` joined with its
// venue / series / primary category). The DB-backed repository (M1/M2) produces
// the same shape, so the search core here is a drop-in over live data later.

/** WGS84 point. Mirrors PostGIS `geography(Point,4326)`; [lng, lat] order matches GeoJSON/PostGIS. */
export interface GeoPoint {
  lng: number;
  lat: number;
}

/** cost_status enum (TSD §6.2, BR-11). Unknown/check_source is NEVER treated as free. */
export type CostStatus = 'known' | 'free' | 'unknown' | 'check_source';

/** status_state enum — all 16 launch states (TSD §6.2, Appendix C). */
export type StatusState =
  | 'confirmed'
  | 'bookable_open'
  | 'not_yet_bookable'
  | 'schedule_not_published'
  | 'inferred_recurring'
  | 'manual_candidate'
  | 'seasonal_out_of_season'
  | 'seasonal_preseason'
  | 'seasonal_active'
  | 'suspended'
  | 'stale'
  | 'cancelled'
  | 'postponed'
  | 'full'
  | 'waitlist'
  | 'needs_review';

/** Non-overlapping user age bands (TSD §6.1 age_band): lower-inclusive / upper-exclusive months. */
export type AgeBandKey = 'under2' | '2-4' | '5-9' | '10-14' | '15+';

/** Local day-part windows (America/Vancouver) for FR-09. */
export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Confidence label derived from authority tier × parse quality × freshness × volatility (BR-13). */
export type ConfidenceLabel = 'official_recent' | 'official' | 'editorial' | 'inferred' | 'stale';

/**
 * A single search candidate. Denormalised `activity_occurrence` (+ venue, series,
 * category, tags). All datetimes are UTC ISO-8601 strings (TSD cross-cutting canon).
 */
export interface ListingRecord {
  id: string;
  seriesId: string;

  // Text-index fields (TSD §5A.1 weighted tsvector): A=name, B=category/tags, C=venue/org, D=description.
  activityName: string; // weight A
  primaryCategoryKey: string; // weight B
  categoryTags: string[]; // weight B (secondary categories + tags)
  venueName: string; // weight C
  organisation: string | null; // weight C
  descriptionSnippet: string; // weight D

  // Suitability / status / context tags (occurrence_category_tag). e.g. 'indoor', 'outdoor', 'drop_in'.
  suitabilityTags: string[];

  // Time (occurrence). Open-hours attractions have no fixed times → nulls + openHours=true.
  startDatetimeUtc: string | null;
  endDatetimeUtc: string | null;
  openHours: boolean;
  /** For open-hours attractions: daily opening window in America/Vancouver minutes-past-midnight. */
  openHoursLocal: { startMin: number; endMin: number } | null;

  // Cost (BR-11).
  costStatus: CostStatus;
  costMinCad: number | null;
  costMaxCad: number | null;

  // Status / confidence (BR-12/BR-13).
  statusState: StatusState;
  confidenceLabel: ConfidenceLabel;
  lastCheckedAtUtc: string | null;

  // Age (BR-01..04): derived matching bands from numeric source range.
  ageBandMatches: AgeBandKey[];
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  /** Free-text age guidance from the source (occurrence_age.age_notes). Optional; surfaced verbatim by detail UX, not indexed. */
  ageNotes?: string | null;

  // Geo / region (venue).
  geo: GeoPoint | null; // null → un-geocoded; shown without distance (TSD §5B)
  municipalityId: string | null;
  neighbourhood: string | null;
  displayArea: string | null;

  /**
   * The venue's own published phone number (`venue.phone`), verbatim as the source renders
   * it — surfaced by UX, never indexed or matched on. Null for every source family that
   * publishes no facility number (today: everything except ActiveNet), so consumers MUST
   * treat absence as normal. See docs/source-register.md §6.3.6.
   */
  venuePhone: string | null;

  // Links (surfaced by UX, not indexed).
  sourceUrl: string | null;
  bookingUrl: string | null;
  locationUrl: string | null;
}

/** Sort controls (TSD §5A.3). Deterministic orderings over the SAME filtered set. */
export type SortKey = 'best_match' | 'distance' | 'soonest' | 'lowest_cost' | 'newest';

/**
 * Structured query produced by the parser (G-T16-1). The single source of truth
 * for what the user asked; every downstream stage reads from it.
 */
export interface SearchContext {
  raw: string;
  /** Free-text terms after intent extraction (fed to alias-expand + matcher). */
  terms: string[];

  // Temporal intent.
  date: DateIntent | null;
  timeOfDay: DayPart | null;

  // Age intent (user-selected bands to intersect with ageBandMatches).
  ageBands: AgeBandKey[];

  // Geo intent.
  radiusKm: number; // default 10 (TSD §5B)
  nearMe: boolean; // "near me" phrase present

  // Cost intent.
  costFree: boolean; // "free" requested
  includeUnknownCost: boolean; // explicit include unknown/check-source flag (FR-10)
  /**
   * Include registration-required courses/camps/lessons in results. Default FALSE: this product
   * answers "what can we do today", and multi-week registered programmes are not that, so they
   * are left out of the default result set entirely and a parent opts INTO them with a filter.
   * An inclusion widener like `includeUnknownCost`, not a narrowing chip — turning it on can only
   * ever ADD results, and every listing it adds is labelled as registration content on its card.
   */
  includeRegistration: boolean;
  /** Optional max-price ceiling in CAD (P1 cost range, G-T21-4). null → no ceiling. */
  costMaxCad: number | null;

  // Status intent (quick chips).
  bookableNow: boolean;
  rainyDay: boolean;
  /** Drop-in suitability chip (G-T21-3) — activities you can just show up to (no booking). */
  dropIn: boolean;

  // Sort.
  sort: SortKey;

  // --- Broadening hints (set by the empty-state ladder, G-T20; default false/absent) ---
  /** Widen text matching (category-only / relaxed) when the exact terms return nothing. */
  widenText?: boolean;
  /** Include expected/seasonal/evergreen listings in a separate section (ladder rung 5). */
  includeExpected?: boolean;
}

/** Resolved date intent. `kind` describes how it was expressed; `isoDate` is America/Vancouver local date (YYYY-MM-DD). */
export interface DateIntent {
  kind: 'today' | 'tomorrow' | 'weekend' | 'weekday' | 'explicit' | 'range';
  /**
   * For 'weekday'/'explicit': the local target date. For 'weekend': Saturday of the target
   * week. For 'range' (T26 / FR-04): the inclusive START date of the range.
   */
  isoDate: string | null;
  /**
   * For 'range' only: the inclusive END date (YYYY-MM-DD, America/Vancouver local). Absent /
   * null for all single-day kinds. A range with `endIsoDate` matches every day in
   * [isoDate, endIsoDate] and drives the "grouped by day" results view (FR-04).
   */
  endIsoDate?: string | null;
  /** Weekday 0=Sun..6=Sat when kind==='weekday'. */
  weekday: number | null;
}
