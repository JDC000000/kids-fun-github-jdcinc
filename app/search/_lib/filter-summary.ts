import {
  AGE_OPTIONS,
  DEFAULT_RADIUS,
  REGION_CHIPS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
  ageSelectionPatch,
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
 * ── The applied query, as one plain-language list ────────────────────────────────
 *
 * Every constraint the search is actually running under, each with the state patch that
 * REMOVES just that one. This is the derivation behind two surfaces:
 *   • the mobile sticky bar's summary text (`otherFilterChips`, unchanged output), and
 *   • the desktop query summary line ("swim · Saturday · Ages 5-9 · North Van"), where
 *     each token is a removable chip and the line doubles as the applied-filter row.
 *
 * One derivation, deliberately: the summary line was designed for the phone (it is the
 * only place a parent can see their whole query once the groups are behind a sheet) and
 * ADOPTED by desktop. Two implementations of the same idea would drift on the first copy
 * change, and the phone one would lose — it is the surface nobody looks at on a laptop.
 *
 * `clear` is a state patch, not a URL: this module stays pure display logic and never
 * builds hrefs. The caller pairs it with `hrefFor(state, token.clear)`.
 */
export interface AppliedFilterToken {
  /** Stable identity for React keys and tests. */
  key: string;
  /** What a parent reads, e.g. "Ages 5-9". */
  label: string;
  /** Which rail group this came from — `otherFilterChips` shows only the 'other' ones. */
  scope: 'when' | 'where' | 'other';
  /** State override that removes exactly this constraint and nothing else. */
  clear: Partial<SearchState>;
}

/**
 * Applied constraints in reading order: date intent, then place, then everything else.
 *
 * The order inside 'other' is the rail's own group order, so the summary reads as an
 * index of the filter rail rather than an arbitrary list.
 */
export function appliedFilterTokens(state: SearchState, savedLocation: SummaryLocation | null): AppliedFilterToken[] {
  const tokens: AppliedFilterToken[] = [];

  // Date intent — the quick-pick and the custom range are one constraint to a parent, and
  // clearing either has to clear both halves or the URL keeps filtering by the other.
  if (hasDateRange(state) && state.dateFrom && state.dateTo) {
    tokens.push({
      key: 'dates',
      label: formatRangeLabel(state.dateFrom, state.dateTo),
      scope: 'when',
      clear: { dateFrom: null, dateTo: null },
    });
  } else if (state.when !== 'any') {
    tokens.push({
      key: 'when',
      label: WHEN_OPTIONS.find((w) => w.key === state.when)?.label ?? state.when,
      scope: 'when',
      clear: { when: 'any', dateFrom: null, dateTo: null },
    });
  }

  // Place. An origin carries the radius (meaningless without it), so they clear together.
  if (hasNearMeCoords(state)) {
    tokens.push({
      key: 'origin',
      label: `Near you · ${state.radiusKm} km`,
      scope: 'where',
      clear: { lat: null, lng: null, radiusKm: DEFAULT_RADIUS },
    });
  } else if (state.useSavedLocation && savedLocation) {
    tokens.push({
      key: 'origin',
      label: `${savedLocation.areaLabel} · ${state.radiusKm} km`,
      scope: 'where',
      clear: { useSavedLocation: false, radiusKm: DEFAULT_RADIUS },
    });
  }
  // Areas are a multi-select union: each chip is its own removable token, so a parent can
  // drop "Richmond" without losing "Vancouver".
  for (const id of state.regions) {
    tokens.push({
      key: `area:${id}`,
      label: REGION_CHIPS.find((r) => r.id === id)?.label ?? id,
      scope: 'where',
      clear: { regions: state.regions.filter((r) => r !== id) },
    });
  }

  if (state.timeOfDay !== 'any') {
    tokens.push({
      key: 'timeOfDay',
      label: TIME_OF_DAY_OPTIONS.find((t) => t.key === state.timeOfDay)?.label ?? state.timeOfDay,
      scope: 'other',
      clear: { timeOfDay: 'any' },
    });
  }
  if (state.ages.length > 0) {
    // Ages read as ONE phrase ("Ages 5-9 & 10-14") rather than one token per band: the
    // bands are an either-or set a parent picked as a single "who is this for" answer.
    //
    // The `clear` patch goes through `ageSelectionPatch`, exactly as the rail's chips do. This
    // "×" is the THIRD control that can empty the age group (the "Any age" chip and toggling
    // off the last band are the other two), and all three have to spell the result the same
    // way — `age=any`, not a bare URL. Fixing two of three would leave one path silently
    // producing a landing-page URL, which is the defect params.ts's "Any age" note describes.
    const labels = state.ages.map((band) => AGE_OPTIONS.find((a) => a.key === band)?.label ?? band);
    tokens.push({
      key: 'ages',
      label: `Ages ${labels.join(' & ')}`,
      scope: 'other',
      clear: ageSelectionPatch([]),
    });
  }
  if (state.bookableNow) {
    tokens.push({ key: 'bookableNow', label: 'Bookable now', scope: 'other', clear: { bookableNow: false } });
  }
  if (state.dropIn) tokens.push({ key: 'dropIn', label: 'Drop-in', scope: 'other', clear: { dropIn: false } });
  // The one token here that is NOT a counted constraint (activeFilterCount excludes it, and
  // must: it widens the result set rather than narrowing it). It is stated anyway because it
  // changes what KIND of thing the list contains — a parent who opted courses in should never
  // have to wonder why 12-week programmes appeared, or hunt for the control that removes them.
  if (state.includeRegistration) {
    tokens.push({
      key: 'includeRegistration',
      label: 'Including registration courses',
      scope: 'other',
      clear: { includeRegistration: false },
    });
  }
  if (state.rainyDay) tokens.push({ key: 'rainyDay', label: 'Rainy-day', scope: 'other', clear: { rainyDay: false } });
  if (state.free) tokens.push({ key: 'free', label: 'Free', scope: 'other', clear: { free: false } });

  return tokens;
}

/**
 * Short, parent-readable chips for everything the two named controls above do NOT cover,
 * so the sticky bar can show the rest of the applied state instead of only counting it.
 * Order mirrors the sheet's group order, so the bar reads as an index of the sheet.
 *
 * A projection of `appliedFilterTokens`, not a second derivation — the phone bar and the
 * desktop summary line must never be able to disagree about what is applied.
 */
export function otherFilterChips(state: SearchState): string[] {
  return appliedFilterTokens(state, null)
    .filter((token) => token.scope === 'other')
    .map((token) => token.label);
}
