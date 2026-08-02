// lib/search/facets.ts — Live facet counts for the search filter UI (Round 31).
//
// WHAT THIS ANSWERS
// For every value of every filter group: "how many results would I have if I picked this,
// given everything I've already picked?" That number is what turns a wall of controls into
// a navigable one — a parent can see that "Under $20" leaves 12 results and "Morning" leaves
// 0 before spending a tap, and the UI can de-emphasise or disable the dead ends instead of
// showing all eleven groups at equal weight. Both the desktop filter rail and the mobile
// filter sheet are built on this.
//
// SEMANTICS: DROP-ONE (disjunctive faceting)
// A group's counts are computed with THAT GROUP'S OWN constraint removed and every other
// group still applied. This is the standard faceted-search rule, and it is what makes the
// numbers useful:
//   • single-select (When / Time of day / Max price / Radius) — "Afternoon 6" while Morning
//     is selected means switching gives you 6, not the (always empty) both-at-once set.
//   • multi-select (Ages / Areas)  — Ages is OR-within-group, so "10–14: 4" while 5–9 is
//     selected is the count for 10–14 under the OTHER groups, i.e. what adding it can reach.
//   • independent toggles (Quick filters) — each of the four is its own group of one, so
//     "Free 9" means "9 if you turn Free on, with the other three as they are now".
//   • category is a BREAKDOWN, not a facet: there is no category control in the rail today,
//     so its counts are simply the current result set split by primary category. When a
//     category control lands it becomes a drop-one group like the rest.
//
// COST
// Pure CPU over the candidate array the search already built — no query, no second matcher
// run. It is a small constant number of filter passes (one per drop-one base set, memoised),
// so it is safe to compute on every filter interaction. See tests/search/facets.perf.test.ts.

import type { AgeBandKey, DayPart, ListingRecord, SearchContext } from './types';
import type { ResolvedOrigin } from '../geo/origin';
import type { RegionHierarchy } from '../geo/region';
import { passesAllFilters, withContext, type FilterDeps, type FilterSelection } from './filters/predicate';
import { collapseKey } from './collapse';
import { parseQuery } from './parse';

export type FacetGroupKey =
  | 'when'
  | 'timeOfDay'
  | 'ages'
  | 'areas'
  | 'quick'
  | 'costMax'
  | 'radius'
  | 'registration'
  | 'category';

/**
 * How the group behaves when a value is picked — the UI needs this to render the right
 * control (radio-like pill row vs multi-select chips vs independent toggles).
 */
export type FacetSelectionKind = 'single' | 'multi' | 'toggle' | 'breakdown';

export interface FacetValueCount {
  /** Stable value key. Matches the value the /search URL carries for this control. */
  value: string;
  /**
   * Human label — supplied ONLY for data-driven values (areas, categories) whose names come
   * from the data, not from product copy. Fixed vocabularies (When / Ages / …) deliberately
   * carry no label: the UI owns that copy, and duplicating it here would let the two drift.
   */
  label?: string;
  /** Results this value would yield, with every OTHER group's current selection applied. */
  count: number;
  /**
   * Is this value part of the selection the counts are relative to? Note that when the
   * broadening ladder has fired, that is the RELAXED selection, not necessarily what the
   * page URL still carries — a UI rendering chip state should read the URL and treat this
   * as what the counts describe (`SearchResponse.broadening.applied` says whether the two
   * can differ).
   */
  selected: boolean;
}

export interface FacetGroupCounts {
  key: FacetGroupKey;
  selection: FacetSelectionKind;
  /** Every value, INCLUDING zero counts — a zero is information the UI needs, not noise. */
  values: FacetValueCount[];
}

export interface FacetCounts {
  /** Results for the selection exactly as applied. Always equals SearchResponse.total. */
  total: number;
  groups: FacetGroupCounts[];
}

/** The applied selection the counts are relative to. */
export interface FacetRequest {
  /** The parsed intent actually used for the displayed results (post-broadening). */
  ctx: SearchContext;
  origin: ResolvedOrigin | null;
  regionChipIds: string[];
  regions: RegionHierarchy;
  /** Reference instant for relative dates ("today" / "this weekend"). */
  now: Date;
}

// ── Vocabularies ─────────────────────────────────────────────────────────────────
// These mirror the rail's chip vocabulary (app/search/_lib/params.ts), which is the UI's
// source of truth for labels and URL params. tests/search/facets.test.ts asserts the two
// stay in step, so a chip can never appear without a count behind it.

/** When quick-picks, expressed as the parent-language phrase the parser resolves. */
const WHEN_VALUES: Array<{ value: string; phrase: string }> = [
  { value: 'today', phrase: 'today' },
  { value: 'tomorrow', phrase: 'tomorrow' },
  { value: 'weekend', phrase: 'this weekend' },
];
const WHEN_KINDS = new Set(WHEN_VALUES.map((v) => v.value));

const DAY_PART_VALUES: DayPart[] = ['morning', 'afternoon', 'evening'];

const AGE_BAND_VALUES: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14', '15+'];

/** Max-price ceilings in CAD (the "Any price" default is emitted separately). */
const COST_CEILINGS_CAD = [20, 50];

const RADIUS_VALUES_KM = [5, 10, 20];

/** The four independent quick-filter toggles, and the context flag each one sets. */
type BooleanContextField = 'bookableNow' | 'dropIn' | 'rainyDay' | 'costFree';
const QUICK_TOGGLES: Array<{ value: string; field: BooleanContextField }> = [
  { value: 'bookableNow', field: 'bookableNow' },
  { value: 'dropIn', field: 'dropIn' },
  { value: 'rainyDay', field: 'rainyDay' },
  { value: 'free', field: 'costFree' },
];

/** The key every group uses for its "no constraint from this group" value. */
const ANY = 'any';

/**
 * Count every facet value over an already-matched candidate set.
 *
 * `listings` must be the search's candidate set (text-matched, unfiltered) so the counts
 * describe the current query, not the whole catalogue. The function is pure: it opens no
 * connection and runs no matcher.
 */
export function computeFacetCounts(listings: ListingRecord[], request: FacetRequest): FacetCounts {
  const deps: FilterDeps = { regions: request.regions };
  const applied: FilterSelection = {
    ctx: request.ctx,
    origin: request.origin,
    regionChipIds: request.regionChipIds,
    // Facets describe the primary result list; the expected/seasonal section is a
    // broadening artefact, not something a filter chip narrows.
    mode: 'primary',
  };

  // One pass per drop-one base set, memoised on selection identity (every value in a group
  // shares its group's base object). Per-value counting then runs over that smaller set.
  const baseSets = new Map<FilterSelection, ListingRecord[]>();
  const ctx: CountContext = {
    applied,
    now: request.now,
    regions: request.regions,
    base(selection) {
      let set = baseSets.get(selection);
      if (!set) {
        set = listings.filter((listing) => passesAllFilters(listing, selection, deps));
        baseSets.set(selection, set);
      }
      return set;
    },
    count(set, selection) {
      return countCards(set.filter((listing) => passesAllFilters(listing, selection, deps)));
    },
  };

  const groups: FacetGroupCounts[] = [
    whenGroup(ctx),
    timeOfDayGroup(ctx),
    agesGroup(ctx),
    areasGroup(ctx),
    quickGroup(ctx),
    costMaxGroup(ctx),
    ...(applied.origin ? [radiusGroup(ctx)] : []),
    registrationGroup(ctx),
    categoryGroup(ctx),
  ];

  return { total: countCards(ctx.base(applied)), groups };
}

/**
 * How many CARDS a set of listings renders as — the unit the result list is in.
 *
 * Results are collapsed to one card per series per local day (lib/search/collapse.ts), so
 * counting raw occurrences would overstate every facet: on the staging catalogue 1000
 * occurrences render as 661 cards. A rail that said "Vancouver 47" above a list of 31 cards
 * would be exactly the kind of lie these counts exist to prevent. Listings that belong to no
 * single day (open-hours, undated) are never collapsed and each count as their own card.
 */
function countCards(listings: ListingRecord[]): number {
  let uncollapsable = 0;
  const keys = new Set<string>();
  for (const listing of listings) {
    const key = collapseKey(listing);
    if (key == null) uncollapsable += 1;
    else keys.add(key);
  }
  return keys.size + uncollapsable;
}

/** Look up one group's counts. Returns undefined for a group this selection doesn't expose. */
export function facetGroup(facets: FacetCounts, key: string): FacetGroupCounts | undefined {
  return facets.groups.find((g) => g.key === key);
}

/** Look up a single value's count. Null when the group or value isn't present. */
export function facetCount(facets: FacetCounts, group: string, value: string): number | null {
  return facetGroup(facets, group)?.values.find((v) => v.value === value)?.count ?? null;
}

// ── Group builders ───────────────────────────────────────────────────────────────

interface CountContext {
  applied: FilterSelection;
  now: Date;
  regions: RegionHierarchy;
  /** Filtered candidate set for a selection (memoised per selection object). */
  base(selection: FilterSelection): ListingRecord[];
  /** How many of `set` also survive `selection`. */
  count(set: ListingRecord[], selection: FilterSelection): number;
}

/** A selection with a different set of region chips (chips are structured, not parsed intent). */
function withChips(selection: FilterSelection, regionChipIds: string[]): FilterSelection {
  return { ...selection, regionChipIds };
}

function whenGroup(c: CountContext): FacetGroupCounts {
  const dropped = withContext(c.applied, { date: null });
  const set = c.base(dropped);
  const kind = c.applied.ctx.date?.kind;
  const values: FacetValueCount[] = [
    // A custom date range, an explicit date or a weekday all leave the quick-pick unset —
    // exactly how the /search URL reads them (params.ts).
    { value: ANY, count: countCards(set), selected: kind == null || !WHEN_KINDS.has(kind) },
  ];
  for (const { value, phrase } of WHEN_VALUES) {
    // Resolve the date through the real parser so a count can never disagree with what the
    // same phrase produces when the parent actually taps the chip.
    const date = parseQuery(phrase, { now: c.now }).date;
    values.push({
      value,
      count: c.count(set, withContext(dropped, { date })),
      selected: kind === value,
    });
  }
  return { key: 'when', selection: 'single', values };
}

function timeOfDayGroup(c: CountContext): FacetGroupCounts {
  const dropped = withContext(c.applied, { timeOfDay: null });
  const set = c.base(dropped);
  const current = c.applied.ctx.timeOfDay;
  const values: FacetValueCount[] = [{ value: ANY, count: countCards(set), selected: current == null }];
  for (const part of DAY_PART_VALUES) {
    values.push({
      value: part,
      count: c.count(set, withContext(dropped, { timeOfDay: part })),
      selected: current === part,
    });
  }
  return { key: 'timeOfDay', selection: 'single', values };
}

function agesGroup(c: CountContext): FacetGroupCounts {
  const dropped = withContext(c.applied, { ageBands: [] });
  const set = c.base(dropped);
  const current = c.applied.ctx.ageBands;
  const values: FacetValueCount[] = [{ value: ANY, count: countCards(set), selected: current.length === 0 }];
  for (const band of AGE_BAND_VALUES) {
    values.push({
      value: band,
      count: c.count(set, withContext(dropped, { ageBands: [band] })),
      selected: current.includes(band),
    });
  }
  return { key: 'ages', selection: 'multi', values };
}

function areasGroup(c: CountContext): FacetGroupCounts {
  const dropped = withChips(c.applied, []);
  const set = c.base(dropped);
  const current = c.applied.regionChipIds;
  const values: FacetValueCount[] = [{ value: ANY, count: countCards(set), selected: current.length === 0 }];
  // Data-driven from the region hierarchy rather than a hard-coded chip list, so the rail's
  // area options can finally be served by the backend (the follow-up params.ts flags) — which
  // also matters in database mode, where real region ids are UUIDs the UI's hard-coded
  // 'van'/'nvan' chips cannot match. Name-ordered by atLevel so chips never reshuffle.
  for (const region of c.regions.atLevel('municipality')) {
    values.push({
      value: region.id,
      label: region.name,
      // Each chip unions its own subtree (BR-08), so a municipality count includes its sub-areas.
      count: c.count(set, withChips(dropped, [region.id])),
      selected: current.includes(region.id),
    });
  }
  return { key: 'areas', selection: 'multi', values };
}

function quickGroup(c: CountContext): FacetGroupCounts {
  // Each toggle is its own drop-one group: its count ignores its own current state but
  // respects the other three.
  const values = QUICK_TOGGLES.map(({ value, field }) => {
    const dropped = withContext(c.applied, { [field]: false } as Partial<SearchContext>);
    return {
      value,
      count: c.count(c.base(dropped), withContext(dropped, { [field]: true } as Partial<SearchContext>)),
      selected: Boolean(c.applied.ctx[field]),
    };
  });
  return { key: 'quick', selection: 'toggle', values };
}

function costMaxGroup(c: CountContext): FacetGroupCounts {
  // Only the ceiling is dropped — the separate "Free" toggle and the include-unknown-cost
  // preference are other groups' constraints and stay applied.
  const dropped = withContext(c.applied, { costMaxCad: null });
  const set = c.base(dropped);
  const current = c.applied.ctx.costMaxCad;
  const values: FacetValueCount[] = [{ value: ANY, count: countCards(set), selected: current == null }];
  for (const ceiling of COST_CEILINGS_CAD) {
    values.push({
      value: String(ceiling),
      count: c.count(set, withContext(dropped, { costMaxCad: ceiling })),
      selected: current === ceiling,
    });
  }
  return { key: 'costMax', selection: 'single', values };
}

function radiusGroup(c: CountContext): FacetGroupCounts {
  // An infinite radius is the "no distance constraint" neutral. Un-geocoded venues are still
  // excluded by it, which matches the result list: with an origin set they never appear.
  const dropped = withContext(c.applied, { radiusKm: Number.POSITIVE_INFINITY });
  const set = c.base(dropped);
  const values = RADIUS_VALUES_KM.map((km) => ({
    value: String(km),
    count: c.count(set, withContext(dropped, { radiusKm: km })),
    selected: c.applied.ctx.radiusKm === km,
  }));
  return { key: 'radius', selection: 'single', values };
}

function registrationGroup(c: CountContext): FacetGroupCounts {
  // The "Courses" control (FilterRail): registration-required courses are excluded by default and
  // a parent opts in. Unlike every other group this one WIDENS — so `includeRegistration` is always
  // the larger number, and the gap between the two values is exactly "how much course content this
  // search is holding back". That gap is the honest way for the UI to decide whether the control is
  // worth showing at all: no gap, nothing to opt into.
  const dropped = withContext(c.applied, { includeRegistration: true });
  const set = c.base(dropped);
  return {
    key: 'registration',
    selection: 'single',
    values: [
      {
        value: 'dropInOnly',
        count: c.count(set, withContext(dropped, { includeRegistration: false })),
        selected: !c.applied.ctx.includeRegistration,
      },
      {
        value: 'includeRegistration',
        count: countCards(set),
        selected: c.applied.ctx.includeRegistration,
      },
    ],
  };
}

function categoryGroup(c: CountContext): FacetGroupCounts {
  // A breakdown of the CURRENT result set — nothing is dropped, because no category control
  // exists yet for a parent to have selected. Ordered biggest-first so a UI can show the
  // handful that actually carry the results and fold the tail away.
  const byCategory = new Map<string, ListingRecord[]>();
  for (const listing of c.base(c.applied)) {
    const bucket = byCategory.get(listing.primaryCategoryKey);
    if (bucket) bucket.push(listing);
    else byCategory.set(listing.primaryCategoryKey, [listing]);
  }
  const values = [...byCategory.entries()]
    .map(([value, bucket]) => ({ value, count: countCards(bucket), selected: false }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { key: 'category', selection: 'breakdown', values };
}
