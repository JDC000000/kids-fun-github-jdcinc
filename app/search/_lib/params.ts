// URL <-> search-state helpers for /search. Every control on the page is driven by
// URL search params (shareable, back-button-safe, works with JavaScript disabled).
//
// Two kinds of param flow to the backend, and they are NOT the same:
//   1. STRUCTURED params the /api/search route reads directly (app/api/search/route.ts
//      `buildSearchRequest`): q, sort, limit, minResults, region (csv region-chip ids),
//      lat/lng (near-me origin), and from/to (a custom date RANGE, T26 / FR-04).
//   2. INTENT the route only understands as parent-language text inside `q`: the query
//      parser (lib/search/parse.ts) extracts date / status / cost / age / radius from
//      the free-text query and STRIPS those phrases so they never pollute text relevance.
//      The route accepts no structured param for those, so the date-quick-pick/quick-filter/
//      age/radius chips compose their phrases into `q` at the API-call boundary (`apiQuery`).
//
// The custom date RANGE is deliberately in group (1), not (2): an ISO date can't survive the
// text pipeline — normalize() replaces every non-alphanumeric run with a space, so
// "2026-07-20" tokenises to "2026 07 20" and the parser's date regex never fires. So a range
// is passed structurally (from/to), read directly by the route, and OVERRIDES any text date.
//
// This keeps the page URL clean and structured (e.g. ?when=weekend&bookable=1&age=5-9)
// while the backend still receives exactly what it already supports today — no backend
// change, no invented params.

import type { AgeBandKey, DayPart } from '@/lib/search/types';

/**
 * Sort keys the /search PAGE offers.
 *
 * This is deliberately a SUBSET of the engine's `SortKey` union and of route.ts's own
 * VALID_SORTS: `newest` ("Recently added") was removed from the parent-facing nav on Jon's
 * beta feedback. The engine still implements it (lib/search/sort.ts) — nothing was ripped
 * out of the ranking layer — it simply is not offered here any more.
 *
 * Because this list is ALSO the parse vocabulary (`parseSearchState` accepts exactly these),
 * a stale/shared `?sort=newest` link degrades to the default sort rather than 404-ing or
 * resurrecting a control the page no longer renders. That is the deliberate direction: an
 * unrecognised value is a no-op, never an error and never a hidden state.
 */
export const VALID_SORTS = ['best_match', 'distance', 'soonest', 'lowest_cost'] as const;
export type SearchSort = (typeof VALID_SORTS)[number];

/** Transparent sort (D6): each ordering is explainable, never a black box. */
export const SORT_OPTIONS: { key: SearchSort; label: string; sentence: string }[] = [
  { key: 'best_match', label: 'Best match', sentence: 'confirmed first, then closest and soonest for your kids' },
  { key: 'distance', label: 'Closest', sentence: 'nearest first by travel distance' },
  { key: 'soonest', label: 'Soonest', sentence: 'earliest start time first' },
  { key: 'lowest_cost', label: 'Lowest cost', sentence: 'free and low-cost first; unknown cost last' },
];

// ── Region filter chips (FR-06/07, BR-07/08) ─────────────────────────────────────
// Additive, multi-select municipalities. `region=` is a structured param the route
// resolves against the region hierarchy (each chip unions its subtree). Ids match the
// hierarchy the current (fixture-default) backend resolves; once live region data lands
// these options should be served by the backend rather than hard-coded (see follow-ups).
/**
 * `regionName` is the region's REAL name as the data carries it, which is not always the
 * chip's copy ("North Van" on a 200px rail, "North Vancouver" in the region hierarchy).
 *
 * It exists for ONE job: matching a facet count back to its chip. The facet payload is
 * data-driven for this group alone — in fixture mode its values are these chip ids, but in
 * database mode they are region UUIDs carrying a `label`, so an id-only lookup silently
 * finds nothing and the Areas group renders bare in production while every local test
 * passes. See FilterRail's `countFor`.
 *
 * It is display/lookup metadata only. `id` remains the sole URL vocabulary — parseSearchState
 * still accepts exactly these five ids and nothing else, and no facet value is ever placed
 * in a `region=` param (a UUID would be silently dropped by that fixed-vocabulary parser).
 */
export const REGION_CHIPS: { id: string; label: string; regionName: string }[] = [
  { id: 'van', label: 'Vancouver', regionName: 'Vancouver' },
  { id: 'nvan', label: 'North Van', regionName: 'North Vancouver' },
  { id: 'wvan', label: 'West Van', regionName: 'West Vancouver' },
  { id: 'bby', label: 'Burnaby', regionName: 'Burnaby' },
  { id: 'rmd', label: 'Richmond', regionName: 'Richmond' },
];
const REGION_ORDER = REGION_CHIPS.map((r) => r.id);

// ── Date quick-pick (FR-09 date intent) ──────────────────────────────────────────
// Maps to parent-language phrases the query parser resolves against America/Vancouver
// local dates. 'any' adds nothing.
export type WhenKey = 'any' | 'today' | 'tomorrow' | 'weekend';
export const WHEN_OPTIONS: { key: WhenKey; label: string; phrase: string }[] = [
  { key: 'any', label: 'Any day', phrase: '' },
  { key: 'today', label: 'Today', phrase: 'today' },
  { key: 'tomorrow', label: 'Tomorrow', phrase: 'tomorrow' },
  { key: 'weekend', label: 'This weekend', phrase: 'this weekend' },
];
const WHEN_KEYS = new Set(WHEN_OPTIONS.map((w) => w.key));

// ── Custom date range (FR-04, T26 / G-T26-1) ─────────────────────────────────────
// A start + end date (America/Vancouver local YYYY-MM-DD) that the WHEN quick-picks can't
// express. Unlike the rest of the rail, the range is a STRUCTURED param pair (`from`/`to`)
// the /api/search route reads directly — an ISO date can't round-trip through the free-text
// pipeline (normalize() strips the hyphens). A range is "active" only when BOTH ends are set
// and from<=to; when active it filters to that inclusive interval AND groups the results by
// day (see app/search/_lib/day-groups.ts). The range and the WHEN quick-pick are mutually
// exclusive in the UI (picking one clears the other).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string, or null if the raw value is absent/malformed. */
function parseIsoDate(raw: string | undefined): string | null {
  return raw && ISO_DATE_RE.test(raw) ? raw : null;
}

/** True when a full, correctly-ordered custom date range is in play (drives filter + day grouping). */
export function hasDateRange(state: SearchState): boolean {
  return state.dateFrom != null && state.dateTo != null && state.dateFrom <= state.dateTo;
}

// ── Age bands (BR-01..04) ────────────────────────────────────────────────────────
// Multi-select. Each band maps to a SINGLE-band parent phrase so a selection resolves
// to exactly that band (avoids e.g. "toddler" which the parser expands to two bands).
/**
 * One chip per band of the `AgeBandKey` data taxonomy (lib/search/types.ts), youngest first.
 *
 * `15+` SPENT A PERIOD OFF THIS LIST AND IS BACK. It was removed from the parent-facing rail on
 * Jon's beta feedback (a teen band read as noise on the searches he was running) while staying
 * everywhere else — the `AgeBandKey` union, `AGE_BAND_ORDER`, the facet counts, the seeded
 * `age_band` table (`180 months → NULL`, open-ended), and the PRD, which specified the band
 * throughout. The rail was the only layer that did not offer it, so a parent with a 15-year-old
 * had no way to ask for the teen listings the index already held and already counted. Jon
 * reinstated the band on 2026-08-18 ("Let's add for 15 plus kids as well"), and reinstating it
 * is exactly this entry: the chip returns, nothing underneath it moves, and no other band's
 * behaviour changes — an added chip is a new way to NARROW, so it can only ever be reachable
 * state a parent opts into, never a listing that stops being shown.
 *
 * WHY THERE IS NO SEPARATE "OPEN-ENDED BAND" HANDLING ANYWHERE. `15+` has no upper bound, but
 * that fact lives in the taxonomy (`age_band.upper_months_exclusive = NULL`) and is resolved by
 * worker/core/age.ts's `computeAgeBandMatches`, which reads the band rows from the database
 * rather than a hard-coded list. Every consumer here is likewise driven off this array or off
 * `AGE_BAND_ORDER`, so the band needed adding in ONE place and no membership logic had to learn
 * about it. If you find yourself special-casing `15+` in a consumer, that consumer has stopped
 * being data-driven and that is the bug to fix.
 *
 * ORDER IS LOAD-BEARING. `AGE_ORDER` is derived from this list and is the canonical order a
 * selection is sorted into (`parseOrderedCsv`, `toggleInList`), so it must stay youngest-first
 * and agree with `AGE_BAND_ORDER` (lib/search/filters/age.ts), whose adjacency rung reads each
 * band's neighbours off exactly that ordering — `15+` sits after `10-14` so the two are
 * neighbours, which is what makes the broadening ladder's `adjacent_age` rung correct for it.
 *
 * `teen` is the phrase, on the same single-band rule as the rest of the group: parse.ts resolves
 * it to `['15+']` and nothing else. It is NOT `tween`, which is a different token and belongs to
 * `10-14`; the two regexes cannot match each other's word (see lib/search/parse.ts AGE_PHRASES).
 */
export const AGE_OPTIONS: { key: AgeBandKey; label: string; phrase: string }[] = [
  { key: 'under2', label: 'Under 2', phrase: 'under 2' },
  { key: '2-4', label: '2–4', phrase: 'preschool' },
  { key: '5-9', label: '5–9', phrase: 'kids' },
  { key: '10-14', label: '10–14', phrase: 'tween' },
  { key: '15+', label: '15+', phrase: 'teen' },
];
/** Exported so callers validating a typed `age=` param (app/api/search/route.ts, Stage 2a)
 *  share this exact vocabulary rather than re-deriving/duplicating it. */
export const AGE_ORDER: AgeBandKey[] = AGE_OPTIONS.map((a) => a.key);

// ── Time of day (FR-09 day-part windows) ─────────────────────────────────────────
// Radio-like single-select. Each option maps to the backend `DayPart` the query parser
// already resolves (morning/afternoon/evening — lib/search/filters/time.ts), composed as
// a parent-language phrase into `q`. 'any' adds nothing. (G-T21-4.)
export type TimeOfDayKey = 'any' | DayPart;
export const TIME_OF_DAY_OPTIONS: { key: TimeOfDayKey; label: string; phrase: string }[] = [
  { key: 'any', label: 'Any time', phrase: '' },
  { key: 'morning', label: 'Morning', phrase: 'morning' },
  { key: 'afternoon', label: 'Afternoon', phrase: 'afternoon' },
  // "& night" is the LABEL only — the key, the URL param and the composed phrase stay `evening`,
  // so every shared link and saved search keeps working. The chip's window was widened to run to
  // 05:00 (lib/search/filters/time.ts); a chip that still read plain "Evening" would be the one
  // control a parent searching at 22:35 has no reason to tap, which is how this defect was
  // reported in the first place.
  { key: 'evening', label: 'Evening & night', phrase: 'evening' },
];
const TIME_OF_DAY_KEYS = new Set<string>(TIME_OF_DAY_OPTIONS.map((t) => t.key));

// ── Max price / cost ceiling — REMOVED FROM THE PRODUCT (Jon's beta feedback) ─────
//
// There used to be a "Max price" preset group here (Any price / Under $20 / Under $50) that
// composed an "under $N" phrase into `q`, which the parser resolved to `ctx.costMaxCad` and
// filters/cost.ts turned into a price ceiling.
//
// REMOVING THE CONTROL WOULD NOT HAVE BEEN ENOUGH, and that is the whole point. `cost=20` is
// a URL param: a shared link, a browser back-forward entry, a saved search or an /account row
// written before this change all still carry it. Had `parseSearchState` gone on honouring
// `cost=`, the ceiling would have kept applying with NO control left anywhere to see or clear
// it — a filter suppressing listings invisibly. So the state field, the parse, the URL
// serialization, the intent phrase and the analytics token are ALL gone: `cost=` is now an
// unrecognised param, and `parseSearchState` ignores unrecognised params. No price ceiling can
// reach the engine from any URL.
//
// THE FREE-TEXT PATH IS GONE TOO, AND THAT QUESTION IS NOW CLOSED (Jon, 2026-08-11).
// This note used to end by flagging one thing for Jon rather than deciding it silently: the
// URL path was dead, but a parent who literally TYPED "under $20" still got a ceiling
// (lib/search/parse.ts), on the argument that a stated intent in their own words is not the
// same as a control quietly managing what they can see. Jon ruled against it — remove the
// price ceiling from search, full stop, "it can be found on the original source site" — and
// the typed path was removed with the same completeness as the URL path: `costMaxCad` is gone
// from SearchContext and `maxCad` from CostFilter, so nothing anywhere can compute a ceiling.
//
// LEAVING THE FLAG OPEN IN THIS COMMENT WOULD HAVE BEEN ITS OWN VERSION OF THE BUG. Keeping
// exactly one half of a removal live is what silently emptied weekly digest emails; a comment
// that still describes the dead half as deliberately alive is the same defect in prose, and a
// future reader would reason from it. What survives is the "Free" quick filter, and only that.

// ── "Include unknown cost" — REMOVED FROM THE PRODUCT (Jon's beta feedback) ───────
//
// There used to be an `includeUnknownCost` state field, a `?includeUnknownCost=` param and a
// toggle chip in the search nav. Unknown/check-source-cost listings are now ALWAYS included.
//
// READ THIS BEFORE ADDING ANY INCLUSION FLAG BACK. The old design had the UI layer and the
// API layer disagreeing about what an ABSENT param meant: `parseSearchState` treated absent as
// TRUE (include) while `app/api/search/route.ts`'s `isOn()` treated absent as FALSE (exclude).
// Deleting the toggle and letting the param simply stop being sent would therefore have made
// the engine start EXCLUDING unknown-cost listings — the exact opposite of the ask — with no
// control left to fix it, and with every existing test still green.
//
// The fix is therefore NOT "stop sending the param". The param, the state field and the whole
// `includeUnknown` concept are gone from the filter itself: lib/search/filters/cost.ts no
// longer has a switch to get wrong. There is now one behaviour, in one place, and no absent
// value for two layers to disagree about. tests/search/cost-always-includes-unknown.test.ts
// is the guard, and it is mutation-checked rather than merely green.

// ── Distance / radius (BR-06, TSD §5B) ───────────────────────────────────────────
export const RADIUS_OPTIONS = [5, 10, 20] as const;
export type RadiusKm = (typeof RADIUS_OPTIONS)[number];
export const DEFAULT_RADIUS: RadiusKm = 10;

export interface SearchState {
  q: string;
  sort: SearchSort;
  /**
   * Show registration-required courses/camps/lessons (structured `reg=` param, off by default).
   *
   * An inclusion WIDENER, deliberately not one of the narrowing quick filters: results exclude
   * registered programmes unless a parent asks for them, and turning it on can only ever add
   * cards — each labelled "Registration required". Structured rather than composed into `q`
   * because it states a policy the caller chose, so it must not be inferrable from words the
   * parent happened to type.
   */
  includeRegistration: boolean;
  /** Additive region-chip ids (structured `region=` param). */
  regions: string[];
  /** Date quick-pick (composed into `q`). Mutually exclusive with a custom date range. */
  when: WhenKey;
  /** Custom date-range start (America/Vancouver local YYYY-MM-DD); null → no range start. Structured `from=`. */
  dateFrom: string | null;
  /** Custom date-range end (America/Vancouver local YYYY-MM-DD); null → no range end. Structured `to=`. */
  dateTo: string | null;
  /** Time-of-day quick-pick (composed into `q`; radio-like, one at a time). */
  timeOfDay: TimeOfDayKey;
  /** Bookable-Now quick filter (composed into `q`). */
  bookableNow: boolean;
  /** Rainy-day / indoor quick filter (composed into `q`). */
  rainyDay: boolean;
  /** Drop-in quick filter (composed into `q`). */
  dropIn: boolean;
  /** Free-only quick filter (composed into `q`). */
  free: boolean;
  /** Selected age bands (composed into `q`). */
  ages: AgeBandKey[];
  /** Near-me origin coords (structured lat/lng). Radius search is active iff both set. */
  lat: number | null;
  lng: number | null;
  /**
   * "Near my saved location" intent (signed-in only, `home=1`). We carry only the intent
   * flag in the shareable page URL, never the postal itself — the page resolves the
   * signed-in user's saved postal server-side and forwards it to /api/search. Mutually
   * exclusive with lat/lng (near-me coords win if both are somehow present).
   */
  useSavedLocation: boolean;
  /** Travel radius; only meaningful (and only sent) when an origin is set. */
  radiusKm: RadiusKm;
}

/**
 * Filter fields reset to defaults, preserving the text query + sort/cost preferences.
 * `includeRegistration` IS reset: "Clear filters" should return a parent to the default
 * drop-in-only view, not silently leave course content switched on.
 */
export const CLEARED_FILTERS: Partial<SearchState> = {
  includeRegistration: false,
  regions: [],
  when: 'any',
  dateFrom: null,
  dateTo: null,
  timeOfDay: 'any',
  bookableNow: false,
  rainyDay: false,
  dropIn: false,
  free: false,
  ages: [],
  lat: null,
  lng: null,
  useSavedLocation: false,
  radiusKm: DEFAULT_RADIUS,
};

export const DEFAULT_STATE: SearchState = {
  q: '',
  sort: 'best_match',
  includeRegistration: false,
  regions: [],
  when: 'any',
  dateFrom: null,
  dateTo: null,
  timeOfDay: 'any',
  bookableNow: false,
  rainyDay: false,
  dropIn: false,
  free: false,
  ages: [],
  lat: null,
  lng: null,
  useSavedLocation: false,
  radiusKm: DEFAULT_RADIUS,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseBool(raw: string | undefined, fallback = false): boolean {
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * Parse a MULTI-SELECT param, keep only allowed values, and return them in a canonical order.
 *
 * Accepts both spellings of the same selection: `region=van,bby` (what every rail link emits) and
 * `region=van&region=bby` (the ordinary REST spelling, and what a hand-written or shared URL tends
 * to carry). It used to be read through `first()`, which keeps only the FIRST occurrence — so the
 * repeated form silently narrowed a two-municipality search to one, with no error and a result set
 * indistinguishable from a real answer. Nothing about the csv form's meaning changes; the repeated
 * form simply stops losing values.
 */
function parseOrderedCsv<T extends string>(raw: string | string[] | undefined, order: T[]): T[] {
  if (raw == null) return [];
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(',')).map((s) => s.trim());
  const set = new Set(values);
  return order.filter((v) => set.has(v));
}

function parseCoord(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseRadius(raw: string | undefined): RadiusKm {
  const n = Number(raw);
  return (RADIUS_OPTIONS as readonly number[]).includes(n) ? (n as RadiusKm) : DEFAULT_RADIUS;
}

/** True when the near-me (browser geolocation) origin is fully resolved (both coords present). */
export function hasNearMeCoords(state: SearchState): boolean {
  return state.lat != null && state.lng != null;
}

/**
 * True when ANY origin is in play — browser near-me coords OR the signed-in saved-location
 * intent. Drives whether a radius is meaningful (composed into `q`) and the "within X km"
 * summary. The saved-location intent only becomes a real API origin once the page resolves
 * the user's saved postal; when it can't, the search simply runs with no radius origin.
 */
export function hasOrigin(state: SearchState): boolean {
  return hasNearMeCoords(state) || state.useSavedLocation;
}

/** Parse Next.js `searchParams` into a validated, defaulted search state. */
export function parseSearchState(sp: RawParams): SearchState {
  const q = (first(sp.q) ?? '').trim();
  const sortRaw = first(sp.sort);
  const sort = (VALID_SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as SearchSort) : DEFAULT_STATE.sort;

  const whenRaw = first(sp.when) as WhenKey | undefined;
  const whenPick = whenRaw && WHEN_KEYS.has(whenRaw) ? whenRaw : 'any';

  // Custom date range (T26 / FR-04). Canonicalise a reversed range so dateFrom<=dateTo always
  // holds (mirrors the engine, which also orders from/to) — keeps URL, filter, and day grouping
  // consistent. A complete range and a WHEN quick-pick both express date intent; the range wins,
  // so a valid range clears the quick-pick (mutually exclusive by construction).
  let dateFrom = parseIsoDate(first(sp.from));
  let dateTo = parseIsoDate(first(sp.to));
  if (dateFrom != null && dateTo != null && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }
  const when = dateFrom != null && dateTo != null ? 'any' : whenPick;

  const timeRaw = first(sp.time);
  const timeOfDay = (timeRaw && TIME_OF_DAY_KEYS.has(timeRaw) ? timeRaw : 'any') as TimeOfDayKey;

  const lat = parseCoord(first(sp.lat));
  const lng = parseCoord(first(sp.lng));
  const bothCoords = lat != null && lng != null;
  // Near-me coords take precedence over the saved-location intent if both are present.
  const useSavedLocation = !bothCoords && parseBool(first(sp.home));

  return {
    q,
    sort,
    // Absent/malformed → OFF. The default view is drop-in only; only an explicit opt-in turns
    // registration content on, so a hand-edited or truncated URL can never quietly re-enable it.
    includeRegistration: parseBool(first(sp.reg)),
    // Multi-select params take the WHOLE value (csv and/or repeated), never just the first
    // occurrence — see parseOrderedCsv.
    regions: parseOrderedCsv(sp.region, REGION_ORDER),
    when,
    dateFrom,
    dateTo,
    timeOfDay,
    bookableNow: parseBool(first(sp.bookable)),
    rainyDay: parseBool(first(sp.rainy)),
    dropIn: parseBool(first(sp.dropin)),
    free: parseBool(first(sp.free)),
    ages: parseOrderedCsv(sp.age, AGE_ORDER as AgeBandKey[]),
    lat: bothCoords ? lat : null,
    lng: bothCoords ? lng : null,
    useSavedLocation,
    radiusKm: parseRadius(first(sp.radius)),
  };
}

/** Toggle a value in a multi-select list, returning a new list in canonical order. */
export function toggleInList<T extends string>(list: T[], value: T, order: T[]): T[] {
  const set = new Set(list);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return order.filter((v) => set.has(v));
}

export function toggleRegion(state: SearchState, id: string): string[] {
  return toggleInList(state.regions, id, REGION_ORDER);
}

export function toggleAge(state: SearchState, band: AgeBandKey): AgeBandKey[] {
  return toggleInList(state.ages, band, AGE_ORDER as AgeBandKey[]);
}

/** Serialize a state to URLSearchParams for the /search PAGE (clean, structured, non-default only). */
function pageParams(state: SearchState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.sort !== DEFAULT_STATE.sort) p.set('sort', state.sort);
  // Registration is default-OFF, so it is written only when on — a bare /search URL stays clean
  // and, more importantly, unambiguously means "drop-in only".
  if (state.includeRegistration) p.set('reg', '1');
  if (state.regions.length) p.set('region', state.regions.join(','));
  if (state.when !== 'any') p.set('when', state.when);
  // Custom date range (T26 / FR-04) — a structured `from`/`to` pair, emitted only when the
  // range is complete and ordered (parseSearchState guarantees dateFrom<=dateTo when both set).
  if (state.dateFrom != null && state.dateTo != null && state.dateFrom <= state.dateTo) {
    p.set('from', state.dateFrom);
    p.set('to', state.dateTo);
  }
  if (state.timeOfDay !== 'any') p.set('time', state.timeOfDay);
  if (state.bookableNow) p.set('bookable', '1');
  if (state.rainyDay) p.set('rainy', '1');
  if (state.dropIn) p.set('dropin', '1');
  if (state.free) p.set('free', '1');
  if (state.ages.length) p.set('age', state.ages.join(','));
  // Origin: near-me coords OR the saved-location intent flag (never the postal itself).
  if (hasNearMeCoords(state)) {
    p.set('lat', String(state.lat));
    p.set('lng', String(state.lng));
  } else if (state.useSavedLocation) {
    p.set('home', '1');
  }
  if (hasOrigin(state) && state.radiusKm !== DEFAULT_RADIUS) {
    p.set('radius', String(state.radiusKm));
  }
  return p;
}

/** Build a `/search?...` href from the current state plus overrides (for tap-to-change chips). */
export function hrefFor(state: SearchState, overrides: Partial<SearchState> = {}): string {
  const qs = pageParams({ ...state, ...overrides }).toString();
  return qs ? `/search?${qs}` : '/search';
}

/**
 * Hidden form fields that preserve the current filter state when the text `<form>` is
 * submitted with a new query. Excludes `q` (that is the visible text input).
 */
export function hiddenStateFields(state: SearchState): { name: string; value: string }[] {
  const p = pageParams(state);
  p.delete('q');
  return [...p.entries()].map(([name, value]) => ({ name, value }));
}

/**
 * Hidden fields for the custom date-range GET `<form>` (T26 / FR-04). Carries every current
 * param EXCEPT the range itself (`from`/`to` — the two date inputs supply those) and the WHEN
 * quick-pick (`when` — submitting a custom range clears it; they're mutually exclusive). Keeps
 * `q` and every other filter so applying dates never drops the rest of the search. Unlike
 * `hiddenStateFields` (the text form, where `q` is the visible input), `q` IS kept here.
 */
export function dateRangeFormFields(state: SearchState): { name: string; value: string }[] {
  const p = pageParams(state);
  p.delete('from');
  p.delete('to');
  p.delete('when');
  return [...p.entries()].map(([name, value]) => ({ name, value }));
}

/**
 * Serialize a search state into the minimal param map persisted as a saved
 * search's `params` envelope field (Task B, the "save this search" button).
 *
 * Same structured, non-default-only shape as the /search page URL (`pageParams`),
 * with one deliberate omission so a saved search stays privacy-safe:
 *   - Raw near-me coordinates (lat/lng, and their now-origin-less radius) are
 *      NEVER persisted into a durable DB row — parity with the analytics layer,
 *      which likewise refuses to store a precise location. The saved-location
 *      *intent* (`home=1`) carries no coordinates and IS kept; a near-me search
 *      simply re-runs without a radius origin until the parent taps "Near me"
 *      again. All values are strings, so the map round-trips cleanly through
 *      JSON and back into URLSearchParams / parseSearchState.
 */
export function serializeStateToParams(state: SearchState): Record<string, string> {
  const p = pageParams(state);
  if (p.has('lat') || p.has('lng')) {
    p.delete('lat');
    p.delete('lng');
    // Home intent (if somehow present) keeps its radius; a bare near-me origin does not.
    if (!p.has('home')) p.delete('radius');
  }
  return Object.fromEntries(p.entries());
}

/**
 * A canonical, order-independent key for a saved search's `params`, used to
 * detect "already saved" without a server dedupe (the API intentionally has
 * none). String values (the shape `serializeStateToParams` produces) compare
 * directly; any non-string value (e.g. a params object saved via the /account
 * form) is JSON-encoded so the key is still stable.
 */
export function savedSearchKey(params: Record<string, unknown>): string {
  return Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      // Escape BOTH sides so a value containing '&' or '=' cannot collide with a
      // different key/value split (e.g. q='a&region=van' vs {q:'a',region:'van'}).
      // Transparent for alphanumerics, so keys stay stable/readable. (QA F2.)
      return `${encodeURIComponent(k)}=${encodeURIComponent(raw)}`;
    })
    .join('&');
}

/**
 * Rebuild a `/search?…` href from a saved search's stored `params` so a saved
 * search is re-runnable (the /account list "Open in search" link). Unknown keys
 * are harmless — parseSearchState ignores anything it doesn't recognise. Null /
 * undefined values are skipped; non-string values are coerced defensively.
 */
export function hrefForParams(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    usp.set(k, typeof v === 'string' ? v : String(v));
  }
  const qs = usp.toString();
  return qs ? `/search?${qs}` : '/search';
}

/**
 * Does the state carry any NARROWING structured/intent filter beyond a plain text query?
 *
 * Deliberately excludes `includeRegistration`: it only ever ADDS results. This predicate's job
 * is to decide how hard the engine should broaden (`apiQuery` minResults), and a widener being
 * on is not a reason to stop filling a thin browse.
 * For "is there anything the parent might want to clear?", use `hasClearableFilters`.
 */
export function hasActiveFilters(state: SearchState): boolean {
  return (
    state.regions.length > 0 ||
    state.when !== 'any' ||
    hasDateRange(state) ||
    state.timeOfDay !== 'any' ||
    state.bookableNow ||
    state.rainyDay ||
    state.dropIn ||
    state.free ||
    state.ages.length > 0 ||
    hasOrigin(state)
  );
}

/**
 * Is any non-default filter state in play that a parent might want to undo? Everything
 * `hasActiveFilters` covers, plus the registration widener — so "Clear filters" is offered (and
 * actually resets) when the only thing switched on is course content.
 */
export function hasClearableFilters(state: SearchState): boolean {
  return hasActiveFilters(state) || state.includeRegistration;
}

/** The intent phrases the current filters compose into the free-text `q` (parser reads these). */
export function intentPhrases(state: SearchState): string[] {
  const phrases: string[] = [];
  const whenPhrase = WHEN_OPTIONS.find((w) => w.key === state.when)?.phrase;
  if (whenPhrase) phrases.push(whenPhrase);
  const timePhrase = TIME_OF_DAY_OPTIONS.find((t) => t.key === state.timeOfDay)?.phrase;
  if (timePhrase) phrases.push(timePhrase);
  if (state.bookableNow) phrases.push('bookable now');
  if (state.rainyDay) phrases.push('rainy day');
  if (state.dropIn) phrases.push('drop-in');
  if (state.free) phrases.push('free');
  for (const band of state.ages) {
    const phrase = AGE_OPTIONS.find((a) => a.key === band)?.phrase;
    if (phrase) phrases.push(phrase);
  }
  // Radius only bites when there is an origin to measure from.
  if (hasOrigin(state)) phrases.push(`${state.radiusKm} km`);
  return phrases;
}

/**
 * Stable, non-PII filter tokens for a `search_performed` analytics event. Excludes
 * the free-text query (captured separately) and the near-me ORIGIN COORDINATES
 * (location is identifying) — only the boolean `near_me` intent is recorded here.
 * Regions are captured on their own array, so they are intentionally NOT included.
 * Tokens are namespaced (`when:`, `age:`) or flat snake_case so the admin dashboard
 * can frequency-count them directly.
 */
export function analyticsFilterTokens(state: SearchState): string[] {
  const tokens: string[] = [];
  if (state.when !== 'any') tokens.push(`when:${state.when}`);
  // Flat, non-PII token: records THAT a custom range was used, never the specific dates.
  if (hasDateRange(state)) tokens.push('date_range');
  if (state.timeOfDay !== 'any') tokens.push(`time:${state.timeOfDay}`);
  if (state.bookableNow) tokens.push('bookable_now');
  if (state.rainyDay) tokens.push('rainy_day');
  if (state.dropIn) tokens.push('drop_in');
  // Records that a parent explicitly asked to see registration courses — the demand signal that
  // tells us whether the separate "browse courses" mode is worth building.
  if (state.includeRegistration) tokens.push('include_registration');
  if (state.free) tokens.push('free');
  for (const band of state.ages) tokens.push(`age:${band}`);
  if (hasNearMeCoords(state)) tokens.push('near_me');
  else if (state.useSavedLocation) tokens.push('saved_home');
  return tokens;
}

/** The signed-in user's saved-location origin, resolved server-side by the /search page. */
export interface SavedOrigin {
  /** The user's saved home postal code (never placed in the shareable page URL). */
  postal: string;
}

/**
 * Build the `/api/search` query string from the search state. When the user chose "near my
 * saved location" and the page resolved their saved postal (`savedOrigin`), forward it as
 * the saved-home origin (`postal` + `signedIn=1`). Near-me coords always take precedence.
 */
export function apiQuery(
  state: SearchState,
  savedOrigin?: SavedOrigin | null,
  options?: {
    /**
     * Ask for per-filter-value result counts (`&facets=1`, lib/search/facets.ts). Free to
     * request — the counts are computed from the candidate set this same search already
     * loaded and matched, so there is no extra query behind them. Off by default so no
     * caller pays for a payload it does not render.
     */
    facets?: boolean;
  },
): string {
  const q = [state.q, ...intentPhrases(state)].filter(Boolean).join(' ').trim();

  const params = new URLSearchParams();
  params.set('q', q);
  if (options?.facets) params.set('facets', '1');
  params.set('sort', state.sort);
  // NB: there is deliberately no `includeUnknownCost` param any more. Unknown/check-source
  // cost listings are now ALWAYS included, and that is enforced in lib/search/filters/cost.ts —
  // the layer that actually filters — not by a param this page remembers to send. See the note
  // on the removed toggle below.
  // Structured, never composed into `q` — the route reads it directly (route.ts buildSearchRequest).
  params.set('includeRegistration', state.includeRegistration ? '1' : '0');
  if (state.regions.length) params.set('region', state.regions.join(','));
  // Custom date range (T26 / FR-04): forwarded as structured `from`/`to`, NOT composed into `q`
  // — an ISO date can't survive normalize() (its hyphens become spaces). Only when complete.
  if (state.dateFrom != null && state.dateTo != null && state.dateFrom <= state.dateTo) {
    params.set('from', state.dateFrom);
    params.set('to', state.dateTo);
  }
  if (hasNearMeCoords(state)) {
    params.set('lat', String(state.lat));
    params.set('lng', String(state.lng));
  } else if (state.useSavedLocation && savedOrigin?.postal) {
    params.set('postal', savedOrigin.postal);
    params.set('signedIn', '1');
  }
  // Stage 2a (roadmap initiative 2, first half) — send the SAME chip state as typed,
  // structured params too, in ADDITION to the intentPhrases() text composed into `q` above.
  // Additive only: nothing above this block changes, `q` still carries every phrase it always
  // has. The engine (lib/search/engine.ts) applies each of these as a post-parse override on
  // whatever parseQuery() resolved from `q`, so the structured value always wins — see the
  // engine's own header for why this stays "send both" rather than "send only one" for now
  // (Stage 2b, later, retires the text half once this is independently verified). Same
  // non-default-only shape as `pageParams()` above, and the same param names it already
  // reserves, so a value here can never collide with what the page URL means by that key.
  if (state.ages.length) params.set('age', state.ages.join(','));
  if (state.when !== 'any') params.set('when', state.when);
  if (state.timeOfDay !== 'any') params.set('time', state.timeOfDay);
  if (state.bookableNow) params.set('bookable', '1');
  if (state.rainyDay) params.set('rainy', '1');
  if (state.dropIn) params.set('dropin', '1');
  if (state.free) params.set('free', '1');
  if (hasOrigin(state) && state.radiusKm !== DEFAULT_RADIUS) params.set('radius', String(state.radiusKm));
  params.set('limit', '60');
  // Broadening policy (respect explicit choices, still help thin browses):
  // - Structured/intent filters active → minResults 3: show the real filtered set;
  //   the engine only broadens (and explains) on genuinely thin (<3) results.
  // - Free-text query only → 12: fill thin queries into the expected section.
  // - Bare browse → 60: fill a full page of what's on.
  const minResults = hasActiveFilters(state) ? '3' : state.q ? '12' : '60';
  params.set('minResults', minResults);
  return params.toString();
}
