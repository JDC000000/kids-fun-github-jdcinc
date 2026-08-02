import {
  AGE_OPTIONS,
  COST_MAX_OPTIONS,
  REGION_CHIPS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
  hasDateRange,
  hasNearMeCoords,
  hasOrigin,
  type SearchState,
} from './params';
import { formatRangeLabel } from './day-groups';

/**
 * Sticky-bar summary derivations (mobile, Visual Blueprint v0.2 §04 "Sticky date + area
 * control": `[ Today ▾ ] [ East Van · 10 km ▾ ]`).
 *
 * On a phone the 11 filter groups now live behind a bottom sheet, so the only thing a
 * parent can see about their own filter state is this summary. That makes it load-bearing
 * rather than decorative: if it under-reports, the parent is filtering blind and reads a
 * short result list as "there is nothing on" instead of "I have four filters applied".
 * The derivation is therefore pure and unit-pinned (filter-summary.test.ts) rather than
 * assembled inline in the component.
 *
 * These are DISPLAY derivations only. They read `SearchState` and never write it — every
 * filter mutation stays exactly where it was, in the URL-driven <Link> chips inside the
 * sheet (see FilterRail.tsx / Chip.tsx on why that architecture is deliberate).
 */

/** The signed-in user's resolved saved-location area (null when there isn't one). */
export interface SummaryLocation {
  areaLabel: string;
}

/**
 * How many filter CONSTRAINTS are applied — the "⚙ N" badge on the sticky bar.
 *
 * Counts by group, not by chip: picking three age bands is one age constraint to a parent,
 * not three. The four quick filters are counted individually because they are orthogonal
 * facets rather than one group's options. The free-text query, the sort order and the
 * include-unknown-cost preference are excluded — none of them is a facet the sheet owns.
 *
 * INVARIANT (pinned in the tests): `activeFilterCount(s) > 0` ⟺ `hasActiveFilters(s)`.
 * A badge showing 0 while the results are filtered would be a lie about the parent's own
 * state, so the two must never drift apart.
 */
export function activeFilterCount(state: SearchState): number {
  let n = 0;
  // One date intent: the quick-pick and the custom range are mutually exclusive in the UI,
  // and even a hand-written URL carrying both is still one "when" to the parent.
  if (state.when !== 'any' || hasDateRange(state)) n += 1;
  if (state.timeOfDay !== 'any') n += 1;
  if (state.ages.length > 0) n += 1;
  if (state.regions.length > 0) n += 1;
  if (state.bookableNow) n += 1;
  if (state.dropIn) n += 1;
  if (state.rainyDay) n += 1;
  if (state.free) n += 1;
  if (state.costMaxCad != null) n += 1;
  // The radius is not a filter on its own — it only bites once there is an origin to
  // measure from, which is why origin+radius count as one constraint together.
  if (hasOrigin(state)) n += 1;
  return n;
}

/** The `[ When ▾ ]` control's value. A custom range wins: it is what actually filters. */
export function whenChipLabel(state: SearchState): string {
  if (hasDateRange(state) && state.dateFrom && state.dateTo) {
    return formatRangeLabel(state.dateFrom, state.dateTo);
  }
  return WHEN_OPTIONS.find((w) => w.key === state.when)?.label ?? 'Any day';
}

/**
 * The `[ Where ▾ ]` control's value. Origin first (it carries the radius, which is
 * meaningless without it), then areas, then the honest "Any area" default.
 *
 * A `home=1` intent with no resolvable saved postal is NOT an origin — page.tsx degrades
 * it to a null `savedLocation` and runs the search with no radius, so the bar must not
 * claim a location the search is not actually using.
 */
export function whereChipLabel(state: SearchState, savedLocation: SummaryLocation | null): string {
  if (hasNearMeCoords(state)) return `Near you · ${state.radiusKm} km`;
  if (state.useSavedLocation && savedLocation) return `${savedLocation.areaLabel} · ${state.radiusKm} km`;
  if (state.regions.length > 0) {
    const first = REGION_CHIPS.find((r) => r.id === state.regions[0])?.label ?? state.regions[0];
    return state.regions.length === 1 ? first : `${first} +${state.regions.length - 1}`;
  }
  return 'Any area';
}

/**
 * Short, parent-readable chips for everything the two named controls above do NOT cover,
 * so the sticky bar can show the rest of the applied state instead of only counting it.
 * Order mirrors the sheet's group order, so the bar reads as an index of the sheet.
 */
export function otherFilterChips(state: SearchState): string[] {
  const chips: string[] = [];
  if (state.timeOfDay !== 'any') {
    chips.push(TIME_OF_DAY_OPTIONS.find((t) => t.key === state.timeOfDay)?.label ?? '');
  }
  if (state.ages.length > 0) {
    const labels = state.ages.map((band) => AGE_OPTIONS.find((a) => a.key === band)?.label ?? band);
    chips.push(`Ages ${labels.join(' & ')}`);
  }
  if (state.bookableNow) chips.push('Bookable now');
  if (state.dropIn) chips.push('Drop-in');
  if (state.rainyDay) chips.push('Rainy-day');
  if (state.free) chips.push('Free');
  if (state.costMaxCad != null) {
    chips.push(COST_MAX_OPTIONS.find((c) => c.maxCad === state.costMaxCad)?.label ?? `Under $${state.costMaxCad}`);
  }
  return chips.filter(Boolean);
}
