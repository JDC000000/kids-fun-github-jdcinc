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
  /**
   * `activity_occurrence.open_hours_state` verbatim — the venue's OWN published standing-hours
   * sentence, e.g. "Daily 10:00 AM–5:00 PM". Optional/null for every dated occurrence.
   *
   * Carried because it is the only true answer to "when is this on?" for a record that has no
   * date. Without it the UI has a listing it must describe and nothing truthful to describe it
   * with, which is exactly how a dateless row ends up wearing an invented timestamp.
   */
  openHoursLabel?: string | null;

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

  /**
   * `activity_occurrence.registration_required` — the SOURCE's own answer to "must you book
   * in advance?", when it gave one. TRI-STATE and the null matters:
   *   true  → the source says yes.   false → the source says no (a positive drop-in claim).
   *   null  → the source said nothing; fall back to the title heuristic.
   * Sparse: only the library (BiblioCommons) and perfectmind families populate it, so
   * consumers MUST treat null as normal. See supabase/migrations/0027.
   */
  registrationRequired: boolean | null;

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
  /**
   * The parent typed something and the parser could read NONE of it: no free-text terms
   * survived AND no intent phrase matched. Set by `parseQuery` (see its own note for the
   * exact three conditions); always false for a blank query.
   *
   * WHY THIS FIELD EXISTS. Downstream, "no terms" was the ONLY signal, and it means two
   * opposite things. A bare browse produces no terms and should return the catalogue —
   * lib/search/match.ts's `browseMode` is right to do that. A query in a script
   * `normalize()` cannot represent (中文, русский) ALSO produces no terms, and there
   * `browseMode` handed a parent ~50 unrelated activities under the heading of their own
   * search, with `broadening.applied` empty because nothing had been widened: the page said,
   * in every way it knows how, "these are your results". Nothing in the pipeline below the
   * parser could tell the two apart, because the fact that distinguishes them — whether the
   * raw text had content the parser failed to read — is destroyed by the time `terms` is
   * computed. So it is recorded here, at the only place that still knows it.
   *
   * It is the same rule the rest of this product runs on (AGE_NOT_STATED, `originError`,
   * server-engine.ts returning null rather than an empty engine): "we could not answer" and
   * "the answer is nothing" are different statements, and we never quietly substitute a
   * third thing for either. The engine short-circuits to an honest zero-state on this flag —
   * see lib/search/engine.ts.
   */
  unparsedQuery: boolean;

  // Temporal intent.
  date: DateIntent | null;
  timeOfDay: DayPart | null;

  // Age intent (user-selected bands to intersect with ageBandMatches).
  ageBands: AgeBandKey[];

  // Geo intent.
  radiusKm: number; // default 10 (TSD §5B)
  nearMe: boolean; // "near me" phrase present

  // Cost intent.
  // NB: there is no include-unknown-cost flag. Unknown/check-source listings are ALWAYS
  // included — see lib/search/filters/cost.ts for why that is the absence of a switch rather
  // than a switch defaulted to true.
  costFree: boolean; // "free" requested
  /**
   * Include registration-required courses/camps/lessons in results. Default FALSE: this product
   * answers "what can we do today", and multi-week registered programmes are not that, so they
   * are left out of the default result set entirely and a parent opts INTO them with a filter.
   * An inclusion widener, not a narrowing chip — turning it on can only ever ADD results, and
   * every listing it adds is labelled as registration content on its card.
   */
  includeRegistration: boolean;

  // NOTE: there is deliberately no `costMaxCad` here any more. The max-price ceiling was
  // removed from the product on Jon's ruling (2026-08-11) — see lib/search/parse.ts. Removing
  // the FIELD rather than leaving it permanently null is the point: with no field, the compiler
  // enumerates the consumers for us and no future reader can mistake a null that never changes
  // for a ceiling that works. If you are about to add it back, read lib/search/filters/cost.ts.

  // Status intent (quick chips).
  bookableNow: boolean;
  rainyDay: boolean;
  /** Drop-in suitability chip (G-T21-3) — activities you can just show up to (no booking). */
  dropIn: boolean;

  // Sort.
  sort: SortKey;

  // --- Broadening hints (set by the empty-state ladder, G-T20; default false/absent) ---
  /**
   * UNIMPLEMENTED — nothing reads this flag. Stated here rather than deleted because the
   * synonym/category widen is a spec'd ladder rung (TSD §5A.5, pinned by the T-11 PRD
   * scenario), so removing it is a product decision, not a cleanup.
   *
   * Note what the rung would have to ADD, because it is less than it sounds: alias/synonym
   * expansion is already unconditional — SearchEngine.match() runs `aliases.expand(ctx.terms)`
   * on every query, broadened or not. What is missing is a genuine relevance-threshold
   * relaxation, and lib/search/match.ts's constants are measured against the live corpus and
   * carry explicit "tested, not assumed" warnings, so widening there needs measurement rather
   * than a guess. Until then the rung is INERT — which is why the /search broadening notice
   * lists only rungs that actually changed the query (app/search/_lib/broadening-notice.ts):
   * an inert rung must never tell a parent their search was widened when it was not.
   */
  widenText?: boolean;
  /**
   * Accept the day-parts ADJACENT to `timeOfDay` as well as `timeOfDay` itself — the bounded
   * relaxation the ladder's `adjacent_time` rung applies (lib/search/filters/time.ts
   * ADJACENT_DAY_PARTS). Never widens morning into evening; that is not an adjacent time.
   */
  timeOfDayAdjacent?: boolean;
  /** Include expected/seasonal/evergreen listings in a separate section (ladder rung 5). */
  includeExpected?: boolean;
}

/** Resolved date intent. `kind` describes how it was expressed; `isoDate` is America/Vancouver local date (YYYY-MM-DD). */
export interface DateIntent {
  kind: 'today' | 'tomorrow' | 'weekend' | 'weekday' | 'explicit' | 'range';
  /**
   * For 'weekday'/'explicit': the local target date. For 'weekend': the SATURDAY of the nearest
   * Saturday+Sunday pair (see lib/search/parse.ts — on a Sunday that Saturday is yesterday).
   * For 'range' (T26 / FR-04): the inclusive START date of the range.
   */
  isoDate: string | null;
  /**
   * The inclusive END date (YYYY-MM-DD, America/Vancouver local) of a MULTI-DAY intent. Set by
   * 'range' (T26 / FR-04) and by 'weekend' (always `isoDate` + 1 — a weekend is Saturday AND
   * Sunday, never one of them). Absent / null for every single-day kind.
   *
   * `matchesDate` keys the requested window off THIS FIELD rather than off `kind`, so any
   * multi-day kind is matched across its whole span by construction. The "grouped by day"
   * results view (FR-04) is a separate, narrower decision: it is driven by the UI's explicit
   * from/to range control (`hasDateRange` in app/search/_lib/params.ts), NOT by this field, so a
   * two-day 'weekend' stays one flat Confirmed list.
   */
  endIsoDate?: string | null;
  /** Weekday 0=Sun..6=Sat of `isoDate` — set for kind==='weekday', and 6 (Sat) for 'weekend'. */
  weekday: number | null;
}
