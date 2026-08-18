import type { ListingRecord } from '@/lib/search/types';
import type { FacetCounts } from '@/lib/search/facets';
import { isRegistrationShaped } from '@/lib/search/filters/registration';
import { readIndoorOutdoor } from '@/lib/search/indoor';
import { formatOpenHoursWindow } from './format';
import type { Activity, BookingType, Category, ConfidenceLabel, CostStatus, StatusState, TimeOfDay } from './types';

export interface ListingRecordDto {
  id: string;
  activityName: string;
  primaryCategoryKey: string;
  categoryTags?: string[];
  venueName: string;
  organisation: string | null;
  descriptionSnippet: string;
  suitabilityTags?: string[];
  startDatetimeUtc: string | null;
  endDatetimeUtc: string | null;
  /** `open_hours_state` verbatim — the standing-hours sentence a dateless listing has INSTEAD
   *  of a start time. Optional/absent for every dated occurrence. */
  openHoursLabel?: string | null;
  /** True when this is a standing open-hours record rather than a dated occurrence. */
  openHours?: boolean;
  /** Parsed daily opening window in America/Vancouver minutes-past-midnight, when one is held. */
  openHoursLocal?: { startMin: number; endMin: number } | null;
  costStatus: 'known' | 'free' | 'unknown' | 'check_source';
  costMinCad: number | null;
  costMaxCad: number | null;
  statusState: string;
  confidenceLabel: string;
  lastCheckedAtUtc: string | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes?: string | null;
  geo: { lat: number; lng: number } | null;
  displayArea: string | null;
  neighbourhood: string | null;
  municipalityId: string | null;
  /** venue.phone, verbatim. Optional here because most source families never populate it. */
  venuePhone?: string | null;
  /** activity_occurrence.registration_required — the source's own answer, when it gave one.
   *  Optional AND nullable: absent/null both mean "the source said nothing" and leave the
   *  title heuristic in charge. See supabase/migrations/0027. */
  registrationRequired?: boolean | null;
  sourceUrl: string | null;
  bookingUrl: string | null;
  locationUrl: string | null;
}

export interface SearchItemDto {
  listing: ListingRecordDto;
  distanceKm: number | null;
  /**
   * Same-series-same-day occurrences this result stands for (lib/search/collapse.ts). Each carries
   * its OWN cost, so a collapsed card can state what the GROUP costs rather than what its
   * representative costs — mirrors `OccurrenceSlot`, which is what the engine puts here.
   */
  slots?: {
    id: string;
    startDatetimeUtc: string | null;
    endDatetimeUtc: string | null;
    costStatus: ListingRecordDto['costStatus'];
    costMinCad: number | null;
    costMaxCad: number | null;
  }[];
  /** End of the last slot, when the result covers several. */
  slotSpanEndUtc?: string | null;
  /** Engine's registration classification; recomputed locally when absent (fixture/detail paths). */
  registrationRequired?: boolean;
}

export interface SearchResponseDto {
  results: SearchItemDto[];
  expected: SearchItemDto[];
  /** Total matching results BEFORE `limit` — what the facet counts are measured against. */
  total?: number;
  /**
   * Per-filter-value result counts, returned only when the request asked for them
   * (`&facets=1`). This is what a count-driven filter rail/sheet renders its numbers from;
   * see lib/search/facets.ts for the drop-one semantics.
   */
  facets?: FacetCounts;
  /**
   * The origin the engine actually RESOLVED for this request (lib/geo/origin.ts), or null when
   * it had none to work from. This is the AUTHORITATIVE answer, not "did the caller send
   * coordinates": a request that asks for an origin it cannot resolve (a saved postal that
   * won't geocode, an unknown area chip, saved-home while signed out) lands here as `null` with
   * `originError` set, and its results are measured from nothing just like a bare browse.
   *
   * It is what makes "why is there no distance?" answerable. `distanceKm` is null on every
   * result iff this is null — see app/search/_lib/distance-note.ts for the proof and the
   * consequences. Optional because responses assembled by hand in fixtures/tests omit it.
   */
  origin?: { geo: { lat: number; lng: number }; mode: 'near_me' | 'saved_home' | 'area_chip'; label: string } | null;
  /** Why origin resolution failed, when the request asked for one and it could not be given. */
  originError?: string | null;
  meta: { fixtureBacked: boolean; sort: string; backend?: 'fixture' | 'database'; fallbackReason?: string };
}

export function searchApiUrl(): string {
  const params = new URLSearchParams({
    q: '',
    minResults: '100',
    limit: '100',
  });
  return `/api/search?${params.toString()}`;
}

export function mapSearchResponseToActivities(response: SearchResponseDto): Activity[] {
  const seen = new Set<string>();
  return [...response.results, ...response.expected]
    .filter((item) => {
      if (seen.has(item.listing.id)) return false;
      seen.add(item.listing.id);
      return true;
    })
    .map(mapSearchItemToActivity);
}

export function mapListingRecordToActivity(listing: ListingRecord, distanceKm: number | null = null): Activity {
  return mapSearchItemToActivity({ listing, distanceKm });
}

export function mapSearchItemToActivity(item: SearchItemDto): Activity {
  const l = item.listing;
  // Carried VERBATIM, nulls included. A standing open-hours listing has no start instant, and
  // substituting one (this used to be `?? new Date().toISOString()`) is how the H.R. MacMillan
  // Space Centre's general admission came to render as a zero-length event at page-load time,
  // and how the same null read through a bare `new Date()` elsewhere came out as 1969-12-31.
  // `formatWhen` prints the venue's published hours for this case; nothing needs a stand-in.
  const startIso = l.startDatetimeUtc;
  const endIso = l.endDatetimeUtc ?? l.startDatetimeUtc;
  // What a dateless listing says instead of a date. Two shapes hold the same fact — the live read
  // model carries the venue's own sentence, a parsed record carries a numeric window — so both are
  // collapsed here into the one string the when-line prints.
  const openHoursLabel =
    l.openHoursLabel?.trim() ||
    (l.openHoursLocal ? formatOpenHoursWindow(l.openHoursLocal) : undefined);
  // THE ENGINE'S ANSWER, PASSED THROUGH — never a stand-in for it.
  //
  // `item.distanceKm` is null exactly when nothing honest can be measured: no origin (the
  // parent gave no near-me coordinates and has no saved location — the DEFAULT for an
  // anonymous search) or an un-geocoded venue. lib/search/rank.ts already draws that line.
  //
  // This line used to fill the null in: `?? (l.geo ? distance(EAST_VAN, l.geo) : 0)` measured
  // from a hardcoded Clark & Broadway coordinate, and fell back to a flat 0 when even the
  // venue had no geo. Both were fabrications rendered with full confidence — "2.1 km", "0.0 km"
  // — on every card and detail page, for every parent, wherever they actually live. A distance
  // is only true relative to an origin we were given, so with no origin there is no number.
  const distanceKm = item.distanceKm;
  const tags = new Set([...(l.suitabilityTags ?? []), ...(l.categoryTags ?? [])]);
  const indoorReading = readIndoorOutdoor({
    primaryCategoryKey: l.primaryCategoryKey,
    tags,
    activityName: l.activityName,
    descriptionSnippet: l.descriptionSnippet,
  });
  const sourceUrl = l.sourceUrl ?? '#';
  const slotCount = item.slots?.length ?? 1;
  // A collapsed card states the GROUP's cost, so the card formatter needs every member's own three
  // cost fields and not just the representative's (app/preview/_data/format.ts#formatCost). Carried
  // ONLY when the card really stands for several slots: a single-slot card's Activity keeps exactly
  // the shape — and therefore exactly the cost label — it had before this field existed.
  const slotCosts =
    slotCount > 1
      ? item.slots?.map((slot) => ({
          costStatus: mapCost(slot.costStatus),
          ...(slot.costMinCad != null ? { costMinCad: slot.costMinCad } : {}),
          ...(slot.costMaxCad != null ? { costMaxCad: slot.costMaxCad } : {}),
        }))
      : undefined;
  // The engine classifies once and sends the answer; the fallback covers the paths that build an
  // Activity without going through search (the detail loader, fixtures) so a course is labelled
  // as one wherever it is rendered. Same pure predicate either way — one definition, two callers.
  const registrationRequired = item.registrationRequired ?? isRegistrationShaped({
    activityName: l.activityName,
    suitabilityTags: l.suitabilityTags,
    categoryTags: l.categoryTags,
    // The persisted source fact, when the row has one — so the fixture/detail paths that
    // recompute locally reach the SAME verdict the engine does instead of falling back to
    // the title heuristic and disagreeing with the list the card was clicked from.
    registrationRequired: l.registrationRequired,
  });
  return {
    id: l.id,
    activityName: l.activityName,
    venue: l.venueName,
    area: labelArea(l),
    // Derived from the distance, so it inherits the distance's honesty: no measured distance,
    // no drive time. (The 15 km/h constant behind `km * 4` is crude, but it is at least crude
    // about a real number.)
    driveMinutes: distanceKm == null ? null : Math.max(4, Math.round(distanceKm * 4)),
    distanceKm,
    category: mapCategory(l.primaryCategoryKey),
    ageMin: monthsToMinYears(l.ageMinMonths),
    ageMax: monthsToMaxYears(l.ageMaxMonths),
    startIso,
    endIso,
    timeOfDay: startIso ? timeOfDay(startIso) : null,
    ...(openHoursLabel ? { openHoursLabel } : {}),
    costStatus: mapCost(l.costStatus),
    ...(l.costMinCad != null ? { costMinCad: l.costMinCad } : {}),
    ...(l.costMaxCad != null ? { costMaxCad: l.costMaxCad } : {}),
    status: mapStatus(l.statusState),
    booking: mapBooking(l.statusState, l.bookingUrl, tags),
    confidence: mapConfidence(l.confidenceLabel),
    sourceName: hostLabel(sourceUrl),
    sourceUrl,
    ...(l.bookingUrl ? { bookingUrl: l.bookingUrl } : {}),
    ...(l.locationUrl ? { locationUrl: l.locationUrl } : {}),
    ...(l.venuePhone ? { venuePhone: l.venuePhone } : {}),
    lastCheckedIso: l.lastCheckedAtUtc ?? new Date().toISOString(),
    ...(slotCount > 1 ? { slotCount } : {}),
    ...(slotCount > 1 && item.slotSpanEndUtc ? { slotEndIso: item.slotSpanEndUtc } : {}),
    ...(slotCosts ? { slotCosts } : {}),
    ...(registrationRequired ? { registrationRequired } : {}),
    // ONE reading, shared with the DB read model (lib/search/indoor.ts) — `true` indoors,
    // `false` outdoors, `null` when the source never said. The inline category list this
    // replaces could only ever answer true/false, so "we don't know" arrived at the detail
    // page as `false` and `practicalFacts` printed a confident **"Outdoor"** for it. Both
    // halves of that were wrong at once on the reported listings: the old `indoor` inference
    // said "Indoor" for outdoor soccer, and its absence would have said "Outdoor" for the
    // thousands of listings whose sources say nothing either way.
    indoor: indoorReading === 'unknown' ? null : indoorReading === 'indoor',
    // Only a positive indoor reading earns "Rainy-day friendly". `false` here does not claim
    // the listing is unsuitable in rain — it claims only that we have no basis to recommend it
    // for one, which is why it renders as the absence of a badge rather than a warning.
    rainyDay: indoorReading === 'indoor',
    dropIn: tags.has('drop_in'),
    descriptionSnippet: l.descriptionSnippet || `${l.activityName} at ${l.venueName}.`,
    parentNotes: [`Source: ${hostLabel(sourceUrl)}`, `Status: ${mapStatus(l.statusState).replaceAll('_', ' ')}`],
    ...(l.ageNotes ? { ageNotes: l.ageNotes } : {}),
  };
}

function labelArea(l: ListingRecordDto): string {
  // BUG-008: never fall back to the raw municipalityId — it is an opaque UUID, not a
  // human area name. When neighbourhood and displayArea are both absent, go straight
  // to the generic 'Metro Vancouver' rather than rendering a database id on the card.
  return l.neighbourhood ?? l.displayArea ?? 'Metro Vancouver';
}

function mapCategory(key: string): Category {
  if (key === 'public_swim') return 'swim';
  if (key === 'skate') return 'skate';
  if (key === 'open_gym') return 'open_gym';
  if (key === 'storytime') return 'storytime';
  if (key === 'indoor_play') return 'indoor_play';
  if (key === 'nature') return 'nature';
  if (key === 'festival') return 'festival';
  return 'museum_arts';
}

function mapCost(status: ListingRecordDto['costStatus']): CostStatus {
  if (status === 'free') return 'free';
  if (status === 'known') return 'known';
  return 'unknown';
}

/** The 16 canonical BR-12 status_state values (TSD §6.2), kept in sync with StatusState. */
const CANONICAL_STATUS: ReadonlySet<StatusState> = new Set<StatusState>([
  'confirmed',
  'bookable_open',
  'not_yet_bookable',
  'schedule_not_published',
  'inferred_recurring',
  'manual_candidate',
  'seasonal_out_of_season',
  'seasonal_preseason',
  'seasonal_active',
  'suspended',
  'stale',
  'cancelled',
  'postponed',
  'full',
  'waitlist',
  'needs_review',
]);

/**
 * Pass a canonical status through verbatim so the UI can render its true, honest copy
 * (see statusMeta). Previously this COLLAPSED distinct states into approximations —
 * full/waitlist → "Opens soon", seasonal_active/preseason → "Usually weekly",
 * manual_candidate → "Not posted yet" — which overstated availability and violated the
 * confirmed/expected honesty rule (UXR-06 / T-07). Any unexpected string degrades to
 * `needs_review` ("Unverified — check the source"), never to a confirmed-looking state.
 */
function mapStatus(status: string): StatusState {
  return CANONICAL_STATUS.has(status as StatusState) ? (status as StatusState) : 'needs_review';
}

/**
 * Statuses that must never present a book / register / drop-in affordance, because the
 * spot is not actually open (full, waitlist, suspended, cancelled, postponed) or the
 * listing itself is unverified/out of season. The source CTA still remains the authority
 * on the detail page (Appendix C) — this only suppresses the misleading card chip.
 */
const NON_BOOKABLE_STATUSES: ReadonlySet<StatusState> = new Set<StatusState>([
  'full',
  'waitlist',
  'suspended',
  'cancelled',
  'postponed',
  'seasonal_out_of_season',
  'seasonal_preseason',
  'manual_candidate',
  'needs_review',
]);

function mapBooking(status: string, bookingUrl: string | null, tags: Set<string>): BookingType {
  if (status === 'bookable_open') return 'bookable_now';
  if (NON_BOOKABLE_STATUSES.has(mapStatus(status))) return 'none';
  if (tags.has('drop_in')) return 'drop_in';
  if (bookingUrl) return 'registration';
  return 'none';
}

function mapConfidence(confidence: string): ConfidenceLabel {
  if (confidence === 'official_recent') return 'confirmed';
  if (confidence === 'official') return 'official';
  if (confidence === 'editorial') return 'editorial';
  return 'candidate';
}

/**
 * Months → whole years for display, PRESERVING the difference between "the source told us
 * nothing" and "the source said no upper bound".
 *
 * THE FABRICATED RANGE THAT USED TO LIVE HERE. `monthsToMinYears` returned 0 and
 * `monthsToMaxYears` returned 18 for a null, so an occurrence_age row of (null, null) — which
 * worker/core/age.ts writes, correctly and deliberately, for wording it could not resolve —
 * arrived at the card as the concrete range 0–18 and rendered as **"All ages"**. Measured
 * 2026-08-16 against the live API: of 100 sampled listings, 41 held (null, null) and every one
 * of them was published to parents as "All ages".
 *
 * That is the single most misleading string the product can put on a listing it knows nothing
 * about, and it is not what the data said. The data was honest; this boundary invented a claim
 * for it. Nulls now pass through as nulls and `formatAges` states the absence in words.
 *
 * NOTE THE ASYMMETRY, which is the reason these are two functions and not one. A null MINIMUM
 * only ever means unknown. A null MAXIMUM means unknown when the minimum is also null, and
 * OPEN-ENDED ("5 and up", "all ages") when it is not — a distinction the old sentinel 18
 * flattened away and that `formatAges` needs in order to keep saying "All ages" for the 24
 * sampled listings whose sources genuinely do say so.
 */
function monthsToMinYears(months: number | null): number | null {
  if (months == null) return null;
  return Math.max(0, Math.floor(months / 12));
}

function monthsToMaxYears(months: number | null): number | null {
  if (months == null) return null;
  return Math.max(0, Math.floor(Math.max(0, months - 1) / 12));
}

function timeOfDay(iso: string): TimeOfDay {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hour12: false }).format(new Date(iso)));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'fixture source';
  }
}

// The local haversine that used to live here is GONE with its only caller. Distance is measured
// once, by the engine, against an origin the parent actually supplied (lib/geo/radius.ts —
// `distanceKm`/`distanceFromOrigin`); this mapper's job is to carry that answer, including when
// the answer is "we don't know". A second implementation here only ever existed to invent one.
