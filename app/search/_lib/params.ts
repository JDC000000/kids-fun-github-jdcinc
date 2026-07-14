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

import type { AgeBandKey } from '@/lib/search/types';

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
  /** Bookable-Now quick filter (composed into `q`). */
  bookableNow: boolean;
  /** Rainy-day / indoor quick filter (composed into `q`). */
  rainyDay: boolean;
  /** Free-only quick filter (composed into `q`). */
  free: boolean;
  /** Selected age bands (composed into `q`). */
  ages: AgeBandKey[];
  /** Near-me origin coords (structured lat/lng). Radius search is active iff both set. */
  lat: number | null;
  lng: number | null;
  /** Travel radius; only meaningful (and only sent) when a near-me origin is set. */
  radiusKm: RadiusKm;
}

/** Filter fields reset to defaults, preserving the text query + sort/cost preferences. */
export const CLEARED_FILTERS: Partial<SearchState> = {
  regions: [],
  when: 'any',
  bookableNow: false,
  rainyDay: false,
  free: false,
  ages: [],
  lat: null,
  lng: null,
  radiusKm: DEFAULT_RADIUS,
};

export const DEFAULT_STATE: SearchState = {
  q: '',
  sort: 'best_match',
  includeUnknownCost: true,
  regions: [],
  when: 'any',
  bookableNow: false,
  rainyDay: false,
  free: false,
  ages: [],
  lat: null,
  lng: null,
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

/** True when the near-me origin is fully resolved (both coords present). */
export function hasOrigin(state: SearchState): boolean {
  return state.lat != null && state.lng != null;
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

  const lat = parseCoord(first(sp.lat));
  const lng = parseCoord(first(sp.lng));
  const bothCoords = lat != null && lng != null;

  return {
    q,
    sort,
    includeUnknownCost,
    regions: parseOrderedCsv(first(sp.region), REGION_ORDER),
    when,
    bookableNow: parseBool(first(sp.bookable)),
    rainyDay: parseBool(first(sp.rainy)),
    free: parseBool(first(sp.free)),
    ages: parseOrderedCsv(first(sp.age), AGE_ORDER as AgeBandKey[]),
    lat: bothCoords ? lat : null,
    lng: bothCoords ? lng : null,
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
  if (state.bookableNow) p.set('bookable', '1');
  if (state.rainyDay) p.set('rainy', '1');
  if (state.free) p.set('free', '1');
  if (state.ages.length) p.set('age', state.ages.join(','));
  if (hasOrigin(state)) {
    p.set('lat', String(state.lat));
    p.set('lng', String(state.lng));
    if (state.radiusKm !== DEFAULT_RADIUS) p.set('radius', String(state.radiusKm));
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

/** Does the state carry any structured/intent filter beyond a plain text query? */
export function hasActiveFilters(state: SearchState): boolean {
  return (
    state.regions.length > 0 ||
    state.when !== 'any' ||
    state.bookableNow ||
    state.rainyDay ||
    state.free ||
    state.ages.length > 0 ||
    hasOrigin(state)
  );
}

/** The intent phrases the current filters compose into the free-text `q` (parser reads these). */
export function intentPhrases(state: SearchState): string[] {
  const phrases: string[] = [];
  const whenPhrase = WHEN_OPTIONS.find((w) => w.key === state.when)?.phrase;
  if (whenPhrase) phrases.push(whenPhrase);
  if (state.bookableNow) phrases.push('bookable now');
  if (state.rainyDay) phrases.push('rainy day');
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
  if (state.bookableNow) tokens.push('bookable_now');
  if (state.rainyDay) tokens.push('rainy_day');
  if (state.free) tokens.push('free');
  for (const band of state.ages) tokens.push(`age:${band}`);
  if (hasOrigin(state)) tokens.push('near_me');
  return tokens;
}

/** Build the `/api/search` query string from the search state. */
export function apiQuery(state: SearchState): string {
  const q = [state.q, ...intentPhrases(state)].filter(Boolean).join(' ').trim();

  const params = new URLSearchParams();
  params.set('q', q);
  params.set('sort', state.sort);
  params.set('includeUnknownCost', state.includeUnknownCost ? '1' : '0');
  if (state.regions.length) params.set('region', state.regions.join(','));
  if (hasOrigin(state)) {
    params.set('lat', String(state.lat));
    params.set('lng', String(state.lng));
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
