// URL <-> search-state helpers for /search. Every control on the page is driven by
// URL search params (shareable, back-button-safe, works with JavaScript disabled).
// Only params the existing /api/search route actually accepts are used here — see
// app/api/search/route.ts `buildSearchRequest` (q, sort, includeUnknownCost, limit,
// minResults). Location/region/date controls are deliberately out of this first pass
// (documented follow-ups), so this stays a small, honest surface.

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

export interface SearchState {
  q: string;
  sort: SearchSort;
  includeUnknownCost: boolean;
}

export const DEFAULT_STATE: SearchState = {
  q: '',
  sort: 'best_match',
  includeUnknownCost: true,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Parse Next.js `searchParams` into a validated, defaulted search state. */
export function parseSearchState(sp: RawParams): SearchState {
  const q = (first(sp.q) ?? '').trim();
  const sortRaw = first(sp.sort);
  const sort = (VALID_SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as SearchSort) : DEFAULT_STATE.sort;
  const costRaw = (first(sp.includeUnknownCost) ?? '').toLowerCase();
  // Default ON (Blueprint filter group ③: "Include unknown cost default on"); only an
  // explicit off-signal turns it off, so a bare /search browses inclusively.
  const includeUnknownCost = costRaw === '' ? DEFAULT_STATE.includeUnknownCost : ['1', 'true', 'yes', 'on'].includes(costRaw);
  return { q, sort, includeUnknownCost };
}

/** Build a `/search?...` href from the current state plus overrides (for tap-to-change chips). */
export function hrefFor(state: SearchState, overrides: Partial<SearchState> = {}): string {
  const next = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.sort !== DEFAULT_STATE.sort) params.set('sort', next.sort);
  params.set('includeUnknownCost', next.includeUnknownCost ? '1' : '0');
  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}

/** Build the `/api/search` query string from the search state. */
export function apiQuery(state: SearchState): string {
  const params = new URLSearchParams();
  params.set('q', state.q);
  params.set('sort', state.sort);
  params.set('includeUnknownCost', state.includeUnknownCost ? '1' : '0');
  params.set('limit', '60');
  // With no query text, browse a full page of what's on; also nudges the engine's
  // broadening ladder to fill thin queries into the "expected" section.
  params.set('minResults', state.q ? '12' : '60');
  return params.toString();
}
