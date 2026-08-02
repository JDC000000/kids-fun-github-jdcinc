// tests/search/facets.test.ts — Live facet counts for the search filter rail (Round 31).
//
// The contract under test is the one a count-driven filter UI needs: for every value of
// every filter group, "how many results would I have if I picked this, given everything
// else I've already picked?" — standard drop-one (disjunctive) faceting.
//
// The load-bearing assertion in here is PARITY: a facet count must equal the number of
// results the engine actually returns when that value is really applied. Anything less
// and the rail lies to a parent. Every group is checked that way against a real search.

import { describe, it, expect } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';
import { computeFacetCounts, facetGroup, facetCount } from '../../lib/search/facets';
import type { FacetCounts } from '../../lib/search/facets';
import type { SearchRequest } from '../../lib/search/engine';
import {
  AGE_OPTIONS,
  COST_MAX_OPTIONS,
  RADIUS_OPTIONS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
} from '../../app/search/_lib/params';

const eastVan = { lat: 49.26, lng: -123.07 };
const { engine } = makeFixtureEngine();

/** A raw, un-broadened search (minResults 0 keeps the ladder out of the way). */
function search(req: Partial<SearchRequest> = {}) {
  return engine.search({ q: '', now: FIXTURE_NOW, minResults: 0, includeUnknownCost: true, ...req });
}

function facetsFor(req: Partial<SearchRequest> = {}): FacetCounts {
  const res = search({ ...req, facets: true });
  if (!res.facets) throw new Error('expected facets on the response');
  return res.facets;
}

describe('facet counts — shape + wiring', () => {
  it('are computed only when the request asks for them', () => {
    expect(search().facets).toBeUndefined();
    expect(search({ facets: true }).facets).toBeDefined();
  });

  it('report a total identical to the search total they describe', () => {
    const res = search({ q: 'gym', facets: true });
    expect(res.facets?.total).toBe(res.total);
  });

  it('expose every filter group the rail renders', () => {
    const keys = facetsFor().groups.map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(['when', 'timeOfDay', 'ages', 'areas', 'quick', 'costMax', 'category']));
  });

  it('keep zero-count values rather than dropping them, so the UI can disable instead of guess', () => {
    // Storytime is a morning-only, Vancouver-only, under-5s fixture set: several honest
    // dead ends, each of which the rail wants to render greyed rather than silently omit.
    const facets = facetsFor({ q: 'storytime' });
    expect(facetCount(facets, 'timeOfDay', 'afternoon')).toBe(0);
    expect(facetCount(facets, 'ages', '15+')).toBe(0);
    expect(facetCount(facets, 'areas', 'rmd')).toBe(0);
    // …and a zero is the truth, not a gap: applying it really does return nothing.
    expect(search({ q: 'storytime afternoon' }).total).toBe(0);
    // The value list is complete regardless of how narrow the search gets.
    expect(facetGroup(facets, 'timeOfDay')?.values.map((v) => v.value)).toEqual([
      'any',
      'morning',
      'afternoon',
      'evening',
    ]);
  });

  it('mark the currently-applied value of each group as selected', () => {
    const facets = facetsFor({ q: 'free morning kids', regionChipIds: ['van'] });
    expect(facetGroup(facets, 'timeOfDay')?.values.find((v) => v.selected)?.value).toBe('morning');
    expect(facetGroup(facets, 'ages')?.values.filter((v) => v.selected).map((v) => v.value)).toEqual(['5-9']);
    expect(facetGroup(facets, 'areas')?.values.filter((v) => v.selected).map((v) => v.value)).toEqual(['van']);
    expect(facetGroup(facets, 'quick')?.values.find((v) => v.value === 'free')?.selected).toBe(true);
    // Nothing picked → the group's "any" value is the selected one.
    const bare = facetsFor();
    expect(facetGroup(bare, 'when')?.values.find((v) => v.selected)?.value).toBe('any');
    expect(facetGroup(bare, 'ages')?.values.find((v) => v.selected)?.value).toBe('any');
  });
});

describe('facet counts — parity with a real search (the whole point)', () => {
  // Each case: the facet (group, value) and the request that genuinely applies it, exactly
  // as app/search/_lib/params.ts composes it today (phrases into `q`, regions structured).
  const cases: Array<{ group: string; value: string; applied: Partial<SearchRequest> }> = [
    { group: 'when', value: 'today', applied: { q: 'today' } },
    { group: 'when', value: 'tomorrow', applied: { q: 'tomorrow' } },
    { group: 'when', value: 'weekend', applied: { q: 'this weekend' } },
    { group: 'timeOfDay', value: 'morning', applied: { q: 'morning' } },
    { group: 'timeOfDay', value: 'afternoon', applied: { q: 'afternoon' } },
    { group: 'timeOfDay', value: 'evening', applied: { q: 'evening' } },
    { group: 'ages', value: 'under2', applied: { q: 'under 2' } },
    { group: 'ages', value: '2-4', applied: { q: 'preschool' } },
    { group: 'ages', value: '5-9', applied: { q: 'kids' } },
    { group: 'ages', value: '10-14', applied: { q: 'tween' } },
    { group: 'ages', value: '15+', applied: { q: 'teen' } },
    { group: 'areas', value: 'van', applied: { regionChipIds: ['van'] } },
    { group: 'areas', value: 'nvan', applied: { regionChipIds: ['nvan'] } },
    { group: 'areas', value: 'rmd', applied: { regionChipIds: ['rmd'] } },
    { group: 'quick', value: 'bookableNow', applied: { q: 'bookable now' } },
    { group: 'quick', value: 'dropIn', applied: { q: 'drop-in' } },
    { group: 'quick', value: 'rainyDay', applied: { q: 'rainy day' } },
    { group: 'quick', value: 'free', applied: { q: 'free' } },
    { group: 'costMax', value: '20', applied: { q: 'under $20' } },
    { group: 'costMax', value: '50', applied: { q: 'under $50' } },
  ];

  it.each(cases)('$group=$value counts exactly what applying it returns', ({ group, value, applied }) => {
    const facets = facetsFor();
    expect(facetCount(facets, group, value)).toBe(search(applied).total);
  });

  it('holds when another group is already narrowing the search (drop-one, not drop-all)', () => {
    // Already in Vancouver; the age counts must be Vancouver-only counts.
    const facets = facetsFor({ regionChipIds: ['van'] });
    for (const band of ['under2', '2-4', '5-9', '10-14', '15+']) {
      const phrase = { under2: 'under 2', '2-4': 'preschool', '5-9': 'kids', '10-14': 'tween', '15+': 'teen' }[band]!;
      expect(facetCount(facets, 'ages', band)).toBe(search({ q: phrase, regionChipIds: ['van'] }).total);
    }
  });

  it('counts a group\'s OWN values as if that group were unset (so you can switch, not just narrow)', () => {
    // Time-of-day is single-select: while "morning" is applied, "afternoon" must still show
    // what switching to afternoon would give — NOT zero (nothing is both at once).
    const facets = facetsFor({ q: 'morning' });
    expect(facetCount(facets, 'timeOfDay', 'afternoon')).toBe(search({ q: 'afternoon' }).total);
    expect(facetCount(facets, 'timeOfDay', 'afternoon')).toBeGreaterThan(0);
  });

  it('counts a multi-select group\'s unpicked values under the OTHER groups only', () => {
    // Ages is multi-select (OR within the group): with 5-9 picked, "10-14" shows the count
    // for 10-14 on its own, not the (empty) intersection of the two bands.
    const facets = facetsFor({ q: 'kids' });
    expect(facetCount(facets, 'ages', '10-14')).toBe(search({ q: 'tween' }).total);
  });

  it('reflects cross-group narrowing — a free-only search shrinks the age counts', () => {
    const open = facetCount(facetsFor(), 'ages', '5-9')!;
    const free = facetCount(facetsFor({ q: 'free' }), 'ages', '5-9')!;
    expect(free).toBeLessThan(open);
    expect(free).toBe(search({ q: 'free kids' }).total);
  });

  it('is scoped by the text query — counts describe the current result set, not the catalogue', () => {
    const all = facetCount(facetsFor(), 'areas', 'van')!;
    const swim = facetCount(facetsFor({ q: 'swim' }), 'areas', 'van')!;
    expect(swim).toBeLessThan(all);
    expect(swim).toBe(search({ q: 'swim', regionChipIds: ['van'] }).total);
  });

  it('describes the BROADENED search when the ladder fired, so counts match what is on screen', () => {
    // A deliberately over-constrained query the ladder has to relax; the facet total must
    // still equal the total actually rendered.
    const res = engine.search({
      q: 'tobogganing today free under $20',
      now: FIXTURE_NOW,
      origin: { mode: 'near_me', coords: eastVan },
      facets: true,
      minResults: 3,
    });
    expect(res.broadening.applied.length).toBeGreaterThan(0);
    expect(res.facets?.total).toBe(res.total);
  });
});

describe('facet counts — group-specific behaviour', () => {
  it('serves areas from the region hierarchy (not a hard-coded UI list) with their names', () => {
    const areas = facetGroup(facetsFor(), 'areas')!;
    // Municipality level only (sub-areas roll up into their parent chip), name-ordered so
    // the chip order can't shuffle between requests. Labels come from the data.
    expect(areas.values.map((v) => v.value)).toEqual(['any', 'bby', 'nvan', 'rmd', 'van', 'wvan']);
    expect(areas.values.find((v) => v.value === 'nvan')?.label).toBe('North Vancouver');
  });

  it('counts an area chip hierarchically — a municipality includes its sub-areas (BR-08)', () => {
    // l-opengym-van is tagged displayArea 'van-east', a child of 'van'.
    const facets = facetsFor({ q: 'open gym' });
    expect(facetCount(facets, 'areas', 'van')).toBe(search({ q: 'open gym', regionChipIds: ['van'] }).total);
    expect(facetCount(facets, 'areas', 'van')).toBeGreaterThan(0);
  });

  it('omits the radius group with no origin and includes it, monotonically, with one', () => {
    expect(facetGroup(facetsFor(), 'radius')).toBeUndefined();

    const facets = facetsFor({ origin: { mode: 'near_me', coords: eastVan } });
    const radius = facetGroup(facets, 'radius')!;
    expect(radius.values.map((v) => v.value)).toEqual(['5', '10', '20']);
    const [five, ten, twenty] = radius.values.map((v) => v.count);
    expect(five).toBeLessThanOrEqual(ten);
    expect(ten).toBeLessThanOrEqual(twenty);
    // Richmond (~11km out) only appears once the radius reaches 20km.
    expect(twenty).toBeGreaterThan(ten);
    expect(ten).toBe(search({ origin: { mode: 'near_me', coords: eastVan }, q: '10 km' }).total);
  });

  it('breaks the current result set down by category, ordered by size and summing to the total', () => {
    const facets = facetsFor();
    const category = facetGroup(facets, 'category')!;
    expect(category.selection).toBe('breakdown');
    const counts = category.values.map((v) => v.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(facets.total);
    expect(facetCount(facets, 'category', 'open_gym')).toBeGreaterThan(0);
  });

  it('counts each quick filter independently of the other three', () => {
    // Drop-in is already on; the "free" count must be free-AND-drop-in, and the "drop-in"
    // count must still be the drop-in count (its own toggle is dropped, not doubled).
    const facets = facetsFor({ q: 'drop-in' });
    expect(facetCount(facets, 'quick', 'free')).toBe(search({ q: 'drop-in free' }).total);
    expect(facetCount(facets, 'quick', 'dropIn')).toBe(search({ q: 'drop-in' }).total);
  });

  it('never counts hidden statuses (cancelled/suspended/needs_review) into any facet', () => {
    // l-cancelled-gym is a free, drop-in, Vancouver open_gym — it would inflate several
    // facets if the hidden-status gate were skipped.
    const facets = facetsFor({ q: 'open gym' });
    const total = search({ q: 'open gym' }).total;
    expect(facetCount(facets, 'areas', 'any')).toBe(total);
    expect(facetCount(facets, 'category', 'open_gym')).toBe(total);
  });

  it('counts the primary result list only — the expected/seasonal section is not folded in', () => {
    const res = engine.search({ q: '', now: FIXTURE_NOW, minResults: 0, includeUnknownCost: true, facets: true });
    expect(res.expected.length).toBeGreaterThanOrEqual(0);
    expect(res.facets?.total).toBe(res.results.length);
  });
});

describe('facet vocabulary parity with the filter UI', () => {
  // The rail's chip vocabulary (app/search/_lib/params.ts) and the facet vocabulary must
  // not drift: a chip with no facet renders no count, a facet with no chip is dead weight.
  const facets = facetsFor({ origin: { mode: 'near_me', coords: eastVan } });
  const valuesOf = (group: string) => facetGroup(facets, group)!.values.map((v) => v.value);

  it('covers every When quick-pick', () => {
    expect(valuesOf('when')).toEqual(WHEN_OPTIONS.map((o) => o.key));
  });

  it('covers every Time-of-day option', () => {
    expect(valuesOf('timeOfDay')).toEqual(TIME_OF_DAY_OPTIONS.map((o) => o.key));
  });

  it('covers every age band', () => {
    expect(valuesOf('ages')).toEqual(['any', ...AGE_OPTIONS.map((o) => o.key)]);
  });

  it('covers every max-price band', () => {
    expect(valuesOf('costMax')).toEqual(COST_MAX_OPTIONS.map((o) => o.key));
  });

  it('covers every radius option', () => {
    expect(valuesOf('radius')).toEqual(RADIUS_OPTIONS.map(String));
  });
});

describe('facet counts — cost', () => {
  it('computes counts over the candidate set it is handed, with no repository access', () => {
    // computeFacetCounts is a pure function of (listings, selection): it issues no query
    // and re-runs no matcher, which is what keeps it cheap enough for every keystroke.
    const res = search({ q: 'gym', facets: true });
    const listings = res.results.map((r) => r.listing);
    const direct = computeFacetCounts(listings, {
      ctx: res.context,
      origin: res.origin,
      regionChipIds: [],
      regions: makeFixtureEngine().regionHierarchy,
      now: FIXTURE_NOW,
    });
    expect(direct.total).toBe(listings.length);
  });
});
