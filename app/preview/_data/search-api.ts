import { isInternalAgeMarker } from './format';
import type { ListingRecord } from '@/lib/search/types';
import type { FacetCounts } from '@/lib/search/facets';
import { isRegistrationShaped } from '@/lib/search/filters/registration';
import { readGroupAge } from '@/lib/search/filters/age';
import { readIndoorOutdoor } from '@/lib/search/indoor';
import { formatOpenHoursWindow } from './format';
import type { Activity, BookingType, Category, ConfidenceLabel, CostStatus, StatusState, TimeOfDay } from './types';

/**
 * A Google Maps search URL for an address. Used only as a FALLBACK — see the call site.
 *
 * A SEARCH, NOT A PIN. We have an address string, not coordinates, so this asks Maps to find it
 * rather than asserting a location we have not verified. A wrong pin looks authoritative; a search
 * that lands imprecisely visibly is a search.
 *
 * The venue name is included because addresses in this catalogue are municipal-format ("130 East
 * 23rd Street, North Vancouver, V7L 3E2") and the name disambiguates the several civic buildings
 * that share one. encodeURIComponent, not manual escaping: these strings contain commas, hashes
 * and the occasional ampersand.
 */
export function mapsUrlForAddress(address: string, venueName?: string | null): string {
  const query = venueName ? `${venueName}, ${address}` : address;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export interface ListingRecordDto {
  id: string;
  activityName: string;
  primaryCategoryKey: string;
  categoryTags?: string[];
  venueName: string;
  venueAddress?: string | null;
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
   * its OWN cost AND its OWN age bounds, so a collapsed card can state what the GROUP costs and who
   * the GROUP is for rather than what its representative costs and who its representative is for —
   * mirrors `OccurrenceSlot`, which is what the engine puts here.
   */
  slots?: {
    id: string;
    startDatetimeUtc: string | null;
    endDatetimeUtc: string | null;
    costStatus: ListingRecordDto['costStatus'];
    costMinCad: number | null;
    costMaxCad: number | null;
    ageMinMonths?: number | null;
    ageMaxMonths?: number | null;
  }[];
  /** Distinct local days those slots fall on, ascending (engine `slotDays`). */
  slotDays?: string[];
  /** End of the last slot, when the result covers several — absent when the card spans days. */
  slotSpanEndUtc?: string | null;
  /** Engine's registration classification; recomputed locally when absent (fixture/detail paths). */
  registrationRequired?: boolean;
}

export interface SearchResponseDto {
  results: SearchItemDto[];
  expected: SearchItemDto[];
  /**
   * Primary results whose age the source never stated, separated out under an active age filter
   * (lib/search/engine.ts `ageUnconfirmed`). Still results, still reachable — they simply do not
   * get to sit under a heading that claims they match the age that was asked for.
   *
   * OPTIONAL, like `total`/`facets`/`origin` above and for the same stated reason: this type
   * DESCRIBES a JSON payload fetched over HTTP, it does not verify one, so nothing here may be
   * assumed present. Fixtures and hand-built responses omit it and read as "no such section".
   */
  ageUnconfirmed?: SearchItemDto[];
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

/**
 * What a caller is asking `/api/search` for, in the two dimensions its consumers genuinely
 * differ on. Everything else about the request (a bare `q=''` browse) is shared.
 *
 * THIS IS PARAMETERISED RATHER THAN RE-TUNED because `searchApiUrl` had TWO consumers with
 * opposite needs, which is what made the home-strip defect (§9.1 X2/X3 of
 * docs/answer-before-search-design.md) un-fixable as a one-line edit here:
 *   • `/preview`'s ResultsShell fetches ONCE and then filters, sorts and sections the whole
 *     response as local state — it needs the full page of rows, and it renders the
 *     empty/broadening fork, so it wants the ladder armed.
 *   • the front door's `HomeTodayStrip` rendered three cards and hid itself otherwise. Fetching
 *     100 rows (165,596 bytes, measured 2026-08-18) to show three was waste, and arming the
 *     broadening ladder on a fixed teaser relaxed the parent's constraints for results nobody
 *     would see.
 * Editing the defaults in place would have silently capped /preview's browse at three rows and
 * disarmed its broadening fork — a regression in a surface neither fix was about.
 *
 * The second consumer is GONE as of Track A: `app/_components/ThreeThings.tsx` replaced the strip
 * and evaluates the search in process via `getServerSearchEngine()`, so it builds no URL here at
 * all. The parameterisation stays because it is what keeps /preview's own defaults stated rather
 * than assumed, and because a future second consumer will have its own needs too — but there is
 * only one caller today, and a reader should not go looking for a strip that no longer exists.
 */
export interface SearchApiRequest {
  /** Rows to ask for. Should never exceed what the caller will actually render. */
  limit?: number;
  /**
   * How thin a result set the engine may pad by relaxing the parent's own filters (its
   * broadening ladder — lib/search/engine.ts). `0` declines broadening outright.
   *
   * NOTE an omitted `minResults` is NOT the same as `0`: app/api/search/route.ts drops the
   * absent param and the engine falls back to its own default of 3 (engine.ts `req.minResults ?? 3`),
   * so a caller that wants no broadening has to say `0` out loud.
   */
  minResults?: number;
}

/** The /preview browse shell's request: a full page of rows, and broaden hard to fill it. */
const BROWSE_REQUEST: Required<SearchApiRequest> = { limit: 100, minResults: 100 };

export function searchApiUrl(request: SearchApiRequest = {}): string {
  const { limit, minResults } = { ...BROWSE_REQUEST, ...request };
  const params = new URLSearchParams({
    q: '',
    minResults: String(minResults),
    limit: String(limit),
  });
  return `/api/search?${params.toString()}`;
}

/**
 * Every listing a search response surfaced, in EVERY section, de-duplicated by id.
 *
 * Section order is the de-dupe priority: a listing that appears in two sections keeps the first
 * one. `ageUnconfirmed` sits between the two existing sections because it is a primary result
 * (it outranks `expected`) that has not earned the confirmed heading (so it loses to `results`).
 */
export function mapSearchResponseToActivities(response: SearchResponseDto): Activity[] {
  const seen = new Set<string>();
  return [...response.results, ...(response.ageUnconfirmed ?? []), ...response.expected]
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
  // ONE reading of "is there a usable source here", feeding BOTH the href and the label.
  // Two separate judgements is how the page came to render a live button next to the words
  // "fixture source": the href said yes and the label said no.
  //
  // Carried VERBATIM when it is usable, null when it is not — the same rule `startIso`,
  // `distanceKm` and `lastCheckedIso` in this same mapper already follow. `?? '#'` used to sit
  // here, and it is the same defect in a third place: a nullable column (source_url, migration
  // 0004) meeting a non-nullable type, so the boundary made a value up.
  const source = readSourceUrl(l.sourceUrl);
  const sourceUrl = source.href;
  const sourceName = source.label;
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
  // A collapsed card states the GROUP's age, so this reads every member's own bounds rather than
  // the representative's — the same defect, and the same fix, as `slotCosts` above. `readGroupAge`
  // takes the `agreed` arm for a single-slot card, so a card that never had the defect is
  // unchanged. See lib/search/filters/age.ts for why a disagreeing group prints no range at all.
  // A slot that OMITS age has not carried the fact, which is not the same as the source stating no
  // age — so it inherits the listing's own bounds and the group still reads `agreed`. Only a
  // producer that genuinely carries differing per-slot bounds (the engine, via `OccurrenceSlot`)
  // can reach `varies`, which keeps every fixture/detail path that builds slots without age
  // rendering exactly what it rendered before.
  const ageRead = readGroupAge(
    item.slots?.map((s) => ({
      ageMinMonths: s.ageMinMonths === undefined ? l.ageMinMonths : s.ageMinMonths,
      ageMaxMonths: s.ageMaxMonths === undefined ? l.ageMaxMonths : s.ageMaxMonths,
    })) ?? [l],
  );
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
    ageMin: ageRead.kind === 'agreed' ? monthsToMinYears(ageRead.ageMinMonths) : null,
    ageMax: ageRead.kind === 'agreed' ? monthsToMaxYears(ageRead.ageMaxMonths) : null,
    ...(ageRead.kind === 'varies' ? { agesVaryBySession: true } : {}),
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
    sourceName,
    sourceUrl,
    ...(l.bookingUrl ? { bookingUrl: l.bookingUrl } : {}),
    ...(l.venueAddress ? { address: l.venueAddress } : {}),
    // ═══ A MAP LINK FOR ALMOST EVERY LISTING, NOT 0.4% OF THEM ═══
    // Measured in production: of 11,294 live occurrences, 11,293 have a venue address and only 45
    // carry the source's own location_url. So 11,248 — 99.6% of everything a parent can land on —
    // had an address sitting in the database and no way to open a map.
    //
    // The source's URL WINS when present: it points at the venue's own page or a pinned location,
    // which is better than a text search we constructed. The derived link is a fallback, never an
    // override.
    ...(l.locationUrl
      ? { locationUrl: l.locationUrl }
      : l.venueAddress
        ? { locationUrl: mapsUrlForAddress(l.venueAddress, l.venueName) }
        : {}),
    ...(l.venuePhone ? { venuePhone: l.venuePhone } : {}),
    // Carried VERBATIM, null included — the same rule `startIso` above and `distanceKm` already
    // follow. `?? new Date().toISOString()` used to sit here, and it is the second half of the
    // freshness defect: a row with NO last_checked_at (nothing has ever ingested or re-checked
    // it) was stamped with the moment the page rendered, so the card told a parent we had
    // checked it today. That is a claim about our own diligence, invented at the boundary, for
    // exactly the listings we know the least about. `formatChecked` states the absence instead.
    lastCheckedIso: l.lastCheckedAtUtc,
    ...(slotCount > 1 ? { slotCount } : {}),
    // Only carried when the card really runs on several days: one day is the ordinary collapsed
    // card, which states a time span instead (see format.ts#formatSlotSummary).
    ...(slotCount > 1 && (item.slotDays?.length ?? 0) > 1 ? { slotDays: item.slotDays } : {}),
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
    // NO MANUFACTURED SNIPPET. This fallback fired on every one of 113 sampled listings, so the
    // Overview panel was always "{name} at {venue}." — the h1 and the venue beneath it, restated
    // (as of 2026-09-03 the activity name is the h1 and the venue is the line under it). The
    // panel is now guarded on this being non-empty, so an absent description shows nothing rather
    // than something that looks like source content and is not.
    descriptionSnippet: l.descriptionSnippet,
    // ═══ NO MANUFACTURED PARENT NOTES (Jon, 2026-09-03) ═══
    // This used to emit [`Source: …`, `Status: …`] for EVERY listing, so the "Parent notes" panel
    // was never empty and never once contained a parent note. Both strings restate the "Source &
    // freshness" panel immediately below it, so every activity page carried the same two facts
    // twice under a heading promising something else.
    //
    // FIXED HERE RATHER THAN FILTERED IN THE UI, deliberately. ActivityDetail already guards
    // `parentNotes.length > 0`; the panel was only ever showing because this line guaranteed the
    // array was non-empty. Filtering these two strings back out downstream would have left the
    // fiction in the data and made every future consumer re-implement the same exclusion.
    //
    // The field stays. It is a real feature — the preview fixtures carry genuine tips ("Stroller
    // parking inside", "Quiet room next door for meltdowns") — and the panel will render again the
    // day a source gives us one. It is empty now because we have none, which is the honest state.
    parentNotes: [],
    // ═══ AN INTERNAL MARKER NEVER LEAVES THE SERVER ═══
    // 36.8% of live listings carry age_notes beginning 'unresolved:' or 'audience:' — pipeline
    // markers from lib/llm/age-fallback.ts that were never meant to be read by anyone outside it.
    // At least 12 of them carry a full engineering changelog INCLUDING A GIT SHA, and /api/search
    // returned all of it to any unauthenticated caller. That is how both audits measured this
    // without credentials.
    //
    // DROPPED WHOLE, NOT STRIPPED OF ITS PREFIX. Stripping recovers the raw source wording on an
    // ordinary row — but on the changelog rows the prefix is the ONLY part that is not internal:
    // remove "unresolved:" from the worst example and what remains is still
    // "…code fix live in 9f95e31, worker release v24". A marked value is one the PIPELINE wrote,
    // not one a source did, so the whole value is treated as internal. Once the backfill runs,
    // these rows get real values and notes return on their own.
    ...(l.ageNotes && !isInternalAgeMarker(l.ageNotes) ? { ageNotes: l.ageNotes } : {}),
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

/**
 * Read `source_url` once: is this a link a parent can actually follow, and what do we call it?
 *
 * Returns the href VERBATIM (never the parsed URL's `.href`, which normalises — `new URL(
 * 'https://vancouver.ca').href` gains a trailing slash, and no listing that works today should
 * have its link rewritten by a bug fix). The label is derived from the parse.
 *
 * Three things are "no source", and they were each failing differently before:
 *
 *   • NULL. `source_url` is nullable (migration 0004) and the admin listing form writes null
 *     for a blank field. This used to become the literal `'#'` — a VALID href, so every
 *     truthiness guard downstream passed and it rendered as a live control: the hero's
 *     "View official source" button carries target="_blank", so a parent tapping it got a
 *     BLANK NEW TAB, and the sticky bar's primary CTA got no navigation at all.
 *
 *   • EMPTY / WHITESPACE. `??` never caught these, and `href=""` resolves to the CURRENT page,
 *     so target="_blank" opened a duplicate of the activity page in a new tab.
 *
 *   • NOT AN ABSOLUTE http(s) URL. The admin form stores this field as free text with no URL
 *     validation (app/admin/listings/_lib/vocab.ts — optText), so a typed "vancouver.ca" is
 *     stored as-is and renders as a RELATIVE href: tapping it navigated inside the app to
 *     /activity/vancouver.ca. Every real adapter emits https:// (asserted in
 *     tests/compliance/attribution.test.ts), so no working listing is affected by this arm.
 *
 * The label is null rather than a stand-in, and that is the whole point of this function's
 * second half. Its `catch` used to return the literal string 'fixture source', which is
 * internal test vocabulary, and it reached FOUR parent-facing surfaces: the detail page's
 * "Official source: …" line, the freshness chip on every card AND in the detail hero, the
 * results card's "View on … ↗" CTA, and — via detail-metadata.ts — the description a shared
 * or indexed link previews with. Callers now drop the claim instead of printing a fake one.
 */
function readSourceUrl(raw: string | null | undefined): { href: string | null; label: string | null } {
  const href = raw?.trim();
  if (!href) return { href: null, label: null };
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return { href: null, label: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { href: null, label: null };
  return { href, label: parsed.hostname.replace(/^www\./, '') };
}

// The local haversine that used to live here is GONE with its only caller. Distance is measured
// once, by the engine, against an origin the parent actually supplied (lib/geo/radius.ts —
// `distanceKm`/`distanceFromOrigin`); this mapper's job is to carry that answer, including when
// the answer is "we don't know". A second implementation here only ever existed to invent one.
