// Pure filtering + sectioning logic for the results shell. No React — unit-tested.
// Chips map to parent intent (UXR-03): Bookable now, Drop-in, Rainy-day, Free,
// Indoors, Toddler, plus time-of-day and a travel radius.

import { nullsLast } from '@/lib/search/sort';
import { statusMeta } from './format';
import type { Activity, TimeOfDay } from './types';

export interface FilterState {
  bookableNow: boolean;
  dropIn: boolean;
  rainyDay: boolean;
  free: boolean;
  indoors: boolean;
  toddler: boolean; // band reaches toddlers (ageMin <= 3)
  timeOfDay: TimeOfDay | 'any';
  radiusKm: 5 | 10 | 20;
}

export const DEFAULT_FILTERS: FilterState = {
  bookableNow: false,
  dropIn: false,
  rainyDay: false,
  free: false,
  indoors: false,
  toddler: false,
  timeOfDay: 'any',
  radiusKm: 20,
};

/** Boolean chip keys (everything except time-of-day and radius). */
export type BoolChipKey = 'bookableNow' | 'dropIn' | 'rainyDay' | 'free' | 'indoors' | 'toddler';

export const BOOL_CHIPS: { key: BoolChipKey; label: string }[] = [
  { key: 'bookableNow', label: 'Bookable now' },
  { key: 'dropIn', label: 'Drop-in' },
  { key: 'rainyDay', label: 'Rainy-day' },
  { key: 'free', label: 'Free' },
  { key: 'indoors', label: 'Indoors' },
  { key: 'toddler', label: 'Toddler' },
];

export const TIME_OF_DAY_OPTIONS: { key: TimeOfDay | 'any'; label: string }[] = [
  { key: 'any', label: 'Any time' },
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
];

export const RADIUS_OPTIONS: FilterState['radiusKm'][] = [5, 10, 20];

/** AND across groups; a card must satisfy every active filter. */
export function applyFilters(activities: Activity[], state: FilterState): Activity[] {
  return activities.filter((a) => {
    // A radius can only exclude a card whose distance we actually measured. With no origin
    // there is no distance for ANY card (distanceKm === null), so a null-excluding radius
    // would empty the list on a default browse — and "we don't know how far this is" is not
    // evidence that it is far. Mirrors the server-side rule, which applies the radius only
    // when an origin exists (lib/search/filters/predicate.ts: `if (origin && !withinRadius…)`).
    if (a.distanceKm != null && a.distanceKm > state.radiusKm) return false;
    if (state.bookableNow && a.booking !== 'bookable_now') return false;
    if (state.dropIn && a.booking !== 'drop_in' && !a.dropIn) return false;
    if (state.rainyDay && !a.rainyDay) return false;
    if (state.free && a.costStatus !== 'free') return false;
    if (state.indoors && !a.indoor) return false;
    // `ageMin === null` is "the source stated no age", not "age 0" — so it is not a POSITIVE
    // toddler match, but it is not grounds for hiding either. Same rule the search-side band
    // filter applies (lib/search/filters/age.ts: empty matches → don't hide): we only ever
    // exclude on an age the source actually gave us.
    if (state.toddler && a.ageMin !== null && a.ageMin > 3) return false;
    if (state.timeOfDay !== 'any' && a.timeOfDay !== state.timeOfDay) return false;
    return true;
  });
}

/** Split into the two honesty sections (D7 / BR-12): confirmed-first, expected below. */
export function partitionSections(activities: Activity[]): {
  confirmed: Activity[];
  expected: Activity[];
} {
  const confirmed: Activity[] = [];
  const expected: Activity[] = [];
  for (const a of activities) {
    if (statusMeta(a.status).section === 'confirmed') confirmed.push(a);
    else expected.push(a);
  }
  return { confirmed, expected };
}

export function activeFilterCount(state: FilterState): number {
  let n = 0;
  for (const { key } of BOOL_CHIPS) if (state[key]) n += 1;
  if (state.timeOfDay !== 'any') n += 1;
  if (state.radiusKm !== DEFAULT_FILTERS.radiusKm) n += 1;
  return n;
}

// ── Sorting ──────────────────────────────────────────────────────────────────
// Deterministic alternate orderings over the same filtered set (TSD §7 / D6);
// each is transparent and explainable — never a black-box "magic" ranking.

export type SortKey = 'best_match' | 'distance' | 'soonest' | 'lowest_cost' | 'recently_checked';

export const SORT_OPTIONS: { key: SortKey; label: string; sentence: string }[] = [
  { key: 'best_match', label: 'Best match', sentence: 'confirmed first, then closest & soonest for your kids' },
  { key: 'distance', label: 'Closest', sentence: 'nearest first by travel distance' },
  { key: 'soonest', label: 'Soonest', sentence: 'earliest start time first' },
  { key: 'lowest_cost', label: 'Lowest cost', sentence: 'free and low-cost first; unknown cost last' },
  { key: 'recently_checked', label: 'Recently checked', sentence: 'most recently verified first' },
];

/**
 * Distance comparator: nearest first, unknown distance LAST — never first.
 *
 * Same rule the engine's own distance sort uses (lib/search/sort.ts), shared rather than
 * restated so "Closest" cannot mean two different things on two surfaces. Returns 0 for a
 * pair that is equally unknown, leaving the caller's tiebreak in charge.
 */
function byDistance(a: Activity, b: Activity): number {
  return nullsLast(a.distanceKm, b.distanceKm) ?? a.distanceKm! - b.distanceKm!;
}

/** Effective cost for ordering: free = 0, unknown sorts last. */
function effectiveCost(a: Activity): number {
  if (a.costStatus === 'free') return 0;
  if (a.costStatus === 'unknown') return Number.POSITIVE_INFINITY;
  return a.costMinCad ?? 0;
}

/**
 * Soonest-first ordering. A listing with no fixed date sorts LAST rather than first — the same
 * choice lib/search/sort.ts makes for the live engine. Comparing `startIso` directly would have
 * put every open-hours listing at the head of a "soonest" list once the field became nullable.
 */
function compareSoonest(a: Activity, b: Activity): number {
  if (!a.startIso && !b.startIso) return 0;
  if (!a.startIso) return 1;
  if (!b.startIso) return -1;
  return a.startIso.localeCompare(b.startIso);
}

/** Stable sort within an already-sectioned list. Best-match = closest then soonest. */
export function sortActivities(activities: Activity[], key: SortKey): Activity[] {
  const copy = [...activities];
  copy.sort((a, b) => {
    switch (key) {
      case 'distance':
        return byDistance(a, b);
      case 'soonest':
        return compareSoonest(a, b);
      case 'lowest_cost':
        return effectiveCost(a) - effectiveCost(b);
      case 'recently_checked':
        return b.lastCheckedIso.localeCompare(a.lastCheckedIso);
      case 'best_match':
      default:
        return byDistance(a, b) || compareSoonest(a, b);
    }
  });
  return copy;
}

export function sortSentence(key: SortKey): string {
  return SORT_OPTIONS.find((o) => o.key === key)?.sentence ?? '';
}
