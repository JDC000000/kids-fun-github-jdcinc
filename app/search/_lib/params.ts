// URL <-> search-state helpers for /search. Every control on the page is driven by
// URL search params (shareable, back-button-safe, works with JavaScript disabled).
//
// Two kinds of param flow to the backend, and they are NOT the same:
//   1. STRUCTURED params the /api/search route reads directly (app/api/search/route.ts
//      `buildSearchRequest`): q, sort, includeUnknownCost, limit, minResults, region
//      (csv region-chip ids), lat/lng (near-me origin).
//   2. INTENT the route only understands as parent-language text inside `q`: the query
//      parser (lib/search/parse.ts) extracts date / status / cost / age / radius from
//      the free-text query and STRIPS those phrases so they never pollute text relevance.
//      The route accepts no structured param for those, so the date/quick-filter/age/
//      radius chips compose their phrases into `q` at the API-call boundary (`apiQuery`).
//
// This keeps the page URL clean and structured (e.g. ?when=weekend&bookable=1&age=5-9)
// while the backend still receives exactly what it already supports today — no backend
// change, no invented params.

import type { AgeBandKey, DayPart } from '@/lib/search/types';

/** Sort keys the search API validates (route.ts VALID_SORTS). */
export const VALID_SORTS = ['best_match', 'distance', 'soonest', 'lowest_cost', 'newest'] as const;
export type SearchSort = (typeof VALID_SORTS)[number];

/** Transparent sort (D6): each ordering is explainable, never a black box. */
export const SORT_OPTIONS: { key: SearchSort; label: string; sentence: string }[] = [
  { key: 'best_match', label: 'Best match', sentence: 'confirmed first, then closest and soonest for your kids' },
  { key: 'distance', label: 'Closest', sentence: 'nearest first by travel distance' },
  { key: 'soonest', label: 'Soonest', sentence: 'earliest start time first' },
  { key: 'lowest_cost', label: 'Lowest cost', sentence: 'free and low-cost first; unknown cost last' },
  { key: 'newest', label: 'Recently added', sentence: 'most recently added listings first' },
];

// ── Region filter chips (FR-06/07, BR-07/08) ─────────────────────────────────────
// Additive, multi-select municipalities. `region=` is a structured param the route
// resolves against the region hierarchy (each chip unions its subtree). Ids match the
// hierarchy the current (fixture-default) backend resolves; once live region data lands
// these options should be served by the backend rather than hard-coded (see follow-ups).
export const REGION_CHIPS: { id: string; label: string }[] = [
  { id: 'van', label: 'Vancouver' },
  { id: 'nvan', label: 'North Van' },
  { id: 'wvan', label: 'West Van' },
  { id: 'bby', label: 'Burnaby' },
  { id: 'rmd', label: 'Richmond' },
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

// ── Age bands (BR-01..04) ────────────────────────────────────────────────────────
// Multi-select. Each band maps to a SINGLE-band parent phrase so a selection resolves
// to exactly that band (avoids e.g. "toddler" which the parser expands to two bands).
export const AGE_OPTIONS: { key: AgeBandKey; label: string; phrase: string }[] = [
  { key: 'under2', label: 'Under 2', phrase: 'under 2' },
  { key: '2-4', label: '2–4', phrase: 'preschool' },
  { key: '5-9', label: '5–9', phrase: 'kids' },
  { key: '10-14', label: '10–14', phrase: 'tween' },
  { key: '15+', label: '15+', phrase: 'teen' },
];
const AGE_ORDER = AGE_OPTIONS.map((a) => a.key);

// ── Time of day (FR-09 day-part windows) ─────────────────────────────────────────
// Radio-like single-select. Each option maps to the backend `DayPart` the query parser
// already resolves (morning/afternoon/evening — lib/search/filters/time.ts), composed as
// a parent-language phrase into `q`. 'any' adds nothing. (G-T21-4.)
export type TimeOfDayKey = 'any' | DayPart;
export const TIME_OF_DAY_OPTIONS: { key: TimeOfDayKey; label: string; phrase: string }[] = [
  { key: 'any', label: 'Any time', phrase: '' },
  { key: 'morning', label: 'Morning', phrase: 'morning' },
  { key: 'afternoon', label: 'Afternoon', phrase: 'afternoon' },
  { key: 'evening', label: 'Evening', phrase: 'evening' },
];
const TIME_OF_DAY_KEYS = new Set<string>(TIME_OF_DAY_OPTIONS.map((t) => t.key));

// ── Max price / cost ceiling (P1 cost range, G-T21-4) ────────────────────────────
// Radio-like single-select preset bands mapping to a max-price ceiling in CAD. Composed
// into `q` as an "under $N" phrase the parser resolves to ctx.costMaxCad (lib/search/parse.ts
// + filters/cost.ts `maxCad`). The binary "Free" quick-filter (costFree) is kept separate —
// these bands are the ">$0 but capped" story that, together with Free, expose "cost range/free"
// (G-T21-4). A preset-chip control (not a slider) keeps the whole rail one consistent, 44px /
// AA-contrast Chip vocabulary. `costMaxCad` is the single source of truth (null → no ceiling).
export const COST_MAX_OPTIONS: { key: string; label: string; maxCad: number | null }[] = [
  { key: 'any', label: 'Any price', maxCad: null },
  { key: '20', label: 'Under $20', maxCad: 20 },
  { key: '50', label: 'Under $50', maxCad: 50 },
];
const COST_MAX_VALUES = new Set<number>(
  COST_MAX_OPTIONS.map((c) => c.maxCad).filter((v): v is number => v != null),
);

// ── Distance / radius (BR-06, TSD §5B) ───────────────────────────────────────────
export const RADIUS_OPTIONS = [5, 10, 20] as const;
export type RadiusKm = (typeof RADIUS_OPTIONS)[number];
export const DEFAULT_RADIUS: RadiusKm = 10;

export interface SearchState {
  q: string;
  sort: SearchSort;
  includeUnknownCost: boolean;
  /** Additive region-chip ids (structured `region=` param). */
  regions: string[];
  /** Date quick-pick (composed into `q`). */
  when: WhenKey;
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
  /** Max-price ceiling in CAD (composed into `q` as "under $N"); null → no ceiling. */
  costMaxCad: number | null;
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

/** Filter fields reset to defaults, preserving the text query + sort/cost preferences. */
export const CLEARED_FILTERS: Partial<SearchState> = {
  regions: [],
  when: 'any',
  timeOfDay: 'any',
  bookableNow: false,
  rainyDay: false,
  dropIn: false,
  free: false,
  costMaxCad: null,
  ages: [],
  lat: null,
  lng: null,
  useSavedLocation: false,
  radiusKm: DEFAULT_RADIUS,
};

export const DEFAULT_STATE: SearchState = {
  q: '',
  sort: 'best_match',
  includeUnknownCost: true,
  regions: [],
  when: 'any',
  timeOfDay: 'any',
  bookableNow: false,
  rainyDay: false,
  dropIn: false,
  free: false,
  costMaxCad: null,
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

/** Parse a csv param, keep only allowed values, and return them in a canonical order. */
function parseOrderedCsv<T extends string>(raw: string | undefined, order: T[]): T[] {
  if (!raw) return [];
  const set = new Set(raw.split(',').map((s) => s.trim()));
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
  const costRaw = (first(sp.includeUnknownCost) ?? '').toLowerCase();
  // Default ON (Blueprint filter group ③: "Include unknown cost default on"); only an
  // explicit off-signal turns it off, so a bare /search browses inclusively.
  const includeUnknownCost = costRaw === '' ? DEFAULT_STATE.includeUnknownCost : parseBool(costRaw);

  const whenRaw = first(sp.when) as WhenKey | undefined;
  const when = whenRaw && WHEN_KEYS.has(whenRaw) ? whenRaw : 'any';

  const timeRaw = first(sp.time);
  const timeOfDay = (timeRaw && TIME_OF_DAY_KEYS.has(timeRaw) ? timeRaw : 'any') as TimeOfDayKey;

  const costMaxRaw = Number(first(sp.cost));
  const costMaxCad = COST_MAX_VALUES.has(costMaxRaw) ? costMaxRaw : null;

  const lat = parseCoord(first(sp.lat));
  const lng = parseCoord(first(sp.lng));
  const bothCoords = lat != null && lng != null;
  // Near-me coords take precedence over the saved-location intent if both are present.
  const useSavedLocation = !bothCoords && parseBool(first(sp.home));

  return {
    q,
    sort,
    includeUnknownCost,
    regions: parseOrderedCsv(first(sp.region), REGION_ORDER),
    when,
    timeOfDay,
    bookableNow: parseBool(first(sp.bookable)),
    rainyDay: parseBool(first(sp.rainy)),
    dropIn: parseBool(first(sp.dropin)),
    free: parseBool(first(sp.free)),
    costMaxCad,
    ages: parseOrderedCsv(first(sp.age), AGE_ORDER as AgeBandKey[]),
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
  // Cost is written explicitly (default-on / explicit-off), matching the toggle semantics.
  p.set('includeUnknownCost', state.includeUnknownCost ? '1' : '0');
  if (state.regions.length) p.set('region', state.regions.join(','));
  if (state.when !== 'any') p.set('when', state.when);
  if (state.timeOfDay !== 'any') p.set('time', state.timeOfDay);
  if (state.bookableNow) p.set('bookable', '1');
  if (state.rainyDay) p.set('rainy', '1');
  if (state.dropIn) p.set('dropin', '1');
  if (state.free) p.set('free', '1');
  if (state.costMaxCad != null) p.set('cost', String(state.costMaxCad));
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
 * Serialize a search state into the minimal param map persisted as a saved
 * search's `params` envelope field (Task B, the "save this search" button).
 *
 * Same structured, non-default-only shape as the /search page URL (`pageParams`),
 * with two deliberate omissions so a saved search stays compact AND privacy-safe:
 *   1. `includeUnknownCost` at its default (on) is dropped — parseSearchState
 *      restores that default when the key is absent, so the search re-runs
 *      identically.
 *   2. Raw near-me coordinates (lat/lng, and their now-origin-less radius) are
 *      NEVER persisted into a durable DB row — parity with the analytics layer,
 *      which likewise refuses to store a precise location. The saved-location
 *      *intent* (`home=1`) carries no coordinates and IS kept; a near-me search
 *      simply re-runs without a radius origin until the parent taps "Near me"
 *      again. All values are strings, so the map round-trips cleanly through
 *      JSON and back into URLSearchParams / parseSearchState.
 */
export function serializeStateToParams(state: SearchState): Record<string, string> {
  const p = pageParams(state);
  if (state.includeUnknownCost) p.delete('includeUnknownCost');
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

/** Does the state carry any structured/intent filter beyond a plain text query? */
export function hasActiveFilters(state: SearchState): boolean {
  return (
    state.regions.length > 0 ||
    state.when !== 'any' ||
    state.timeOfDay !== 'any' ||
    state.bookableNow ||
    state.rainyDay ||
    state.dropIn ||
    state.free ||
    state.costMaxCad != null ||
    state.ages.length > 0 ||
    hasOrigin(state)
  );
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
  // "under $N" — the parser strips the "$" (normalize) and reads N as the cost ceiling.
  if (state.costMaxCad != null) phrases.push(`under $${state.costMaxCad}`);
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
  if (state.timeOfDay !== 'any') tokens.push(`time:${state.timeOfDay}`);
  if (state.bookableNow) tokens.push('bookable_now');
  if (state.rainyDay) tokens.push('rainy_day');
  if (state.dropIn) tokens.push('drop_in');
  if (state.free) tokens.push('free');
  if (state.costMaxCad != null) tokens.push(`cost_max:${state.costMaxCad}`);
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
export function apiQuery(state: SearchState, savedOrigin?: SavedOrigin | null): string {
  const q = [state.q, ...intentPhrases(state)].filter(Boolean).join(' ').trim();

  const params = new URLSearchParams();
  params.set('q', q);
  params.set('sort', state.sort);
  params.set('includeUnknownCost', state.includeUnknownCost ? '1' : '0');
  if (state.regions.length) params.set('region', state.regions.join(','));
  if (hasNearMeCoords(state)) {
    params.set('lat', String(state.lat));
    params.set('lng', String(state.lng));
  } else if (state.useSavedLocation && savedOrigin?.postal) {
    params.set('postal', savedOrigin.postal);
    params.set('signedIn', '1');
  }
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
