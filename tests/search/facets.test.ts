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
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { RegionHierarchy } from '../../lib/geo/region';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { computeFacetCounts, facetGroup, facetCount } from '../../lib/search/facets';
import type { FacetCounts } from '../../lib/search/facets';
import { SearchEngine, type SearchRequest } from '../../lib/search/engine';
import {
  AGE_OPTIONS,
  RADIUS_OPTIONS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
} from '../../app/search/_lib/params';

const eastVan = { lat: 49.26, lng: -123.07 };
const { engine } = makeFixtureEngine();

/** A raw, un-broadened search (minResults 0 keeps the ladder out of the way). */
function search(req: Partial<SearchRequest> = {}) {
  return engine.search({ q: '', now: FIXTURE_NOW, minResults: 0, ...req });
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
    const res = engine.search({ q: '', now: FIXTURE_NOW, minResults: 0, facets: true });
    expect(res.expected.length).toBeGreaterThanOrEqual(0);
    expect(res.facets?.total).toBe(res.results.length);
  });
});

describe('facet counts are in CARDS, like the list they sit next to', () => {
  // Results are collapsed to one card per series per local day (lib/search/collapse.ts). Counting
  // raw occurrences would overstate every facet — on staging, 1000 occurrences render as 661
  // cards, so a rail would sit "Vancouver 47" on top of a list of 31.
  //
  // NOTE this needs its own catalogue: no listing in FIXTURE_LISTINGS shares a seriesId with
  // another, so nothing there ever collapses and the parity suite above would pass either way.
  // The bug is only reachable with genuine repeats, so the fixture has to contain them.
  const HOUR = 3_600_000;
  const slotAt = (hoursAfter9am: number) =>
    new Date(Date.UTC(2026, 6, 13, 16, 0, 0) + hoursAfter9am * HOUR).toISOString();

  const REPEATED_SERIES = 'series-forte-piano';
  const catalogue = [
    // One series, four slots, ONE day, one venue → one card.
    ...[0, 1, 2, 3].map((i) =>
      makeListing({
        id: `slot-${i}`,
        seriesId: REPEATED_SERIES,
        activityName: 'Forte Piano Open Play',
        primaryCategoryKey: 'indoor_play',
        venueName: 'Killarney',
        startDatetimeUtc: slotAt(i),
        endDatetimeUtc: slotAt(i + 1),
        costStatus: 'free',
        statusState: 'confirmed',
        ageBandMatches: ['5-9'],
        municipalityId: 'van',
      }),
    ),
    // Same series, NEXT day → a second, separate card (a day boundary is never collapsed across).
    makeListing({
      id: 'slot-nextday',
      seriesId: REPEATED_SERIES,
      activityName: 'Forte Piano Open Play',
      primaryCategoryKey: 'indoor_play',
      venueName: 'Killarney',
      startDatetimeUtc: slotAt(24),
      endDatetimeUtc: slotAt(25),
      costStatus: 'free',
      statusState: 'confirmed',
      ageBandMatches: ['5-9'],
      municipalityId: 'van',
    }),
    // An unrelated single-slot listing in another municipality → its own card.
    makeListing({
      id: 'solo-bby',
      activityName: 'Open Gym Drop-In',
      primaryCategoryKey: 'open_gym',
      venueName: 'Burnaby Centre',
      startDatetimeUtc: slotAt(2),
      endDatetimeUtc: slotAt(3),
      costStatus: 'free',
      statusState: 'confirmed',
      ageBandMatches: ['5-9'],
      municipalityId: 'bby',
    }),
  ];

  const collapsingEngine = new SearchEngine({
    repository: new InMemoryListingRepository(catalogue),
    aliasResolver: new FixtureAliasResolver(),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });

  const run = (req: Partial<SearchRequest> = {}) =>
    collapsingEngine.search({ q: '', now: FIXTURE_NOW, minResults: 0, ...req });

  it('counts a repeated series as one card per day, not one per time slot', () => {
    const res = run({ facets: true });
    // 6 occurrences → 3 cards: the 4-slot day, the next day, and the solo listing.
    expect(catalogue.length).toBe(6);
    expect(res.total).toBe(3);
    expect(res.facets?.total).toBe(3);
  });

  it('counts every individual facet value in cards too, not just the total', () => {
    const facets = run({ facets: true }).facets!;
    // Vancouver holds 5 occurrences but only 2 cards.
    expect(facetCount(facets, 'areas', 'van')).toBe(2);
    expect(facetCount(facets, 'areas', 'bby')).toBe(1);
    expect(facetCount(facets, 'ages', '5-9')).toBe(3);
    // The 4 collapsed slots are all in the morning; they are still ONE card.
    expect(facetCount(facets, 'category', 'indoor_play')).toBe(2);
    expect(facetCount(facets, 'quick', 'free')).toBe(3);
  });

  it('keeps every facet value equal to what applying it actually returns', () => {
    // The same parity guarantee as the main suite, but over a catalogue that really collapses.
    const facets = run({ facets: true }).facets!;
    expect(facetCount(facets, 'areas', 'van')).toBe(run({ regionChipIds: ['van'] }).total);
    expect(facetCount(facets, 'areas', 'bby')).toBe(run({ regionChipIds: ['bby'] }).total);
    expect(facetCount(facets, 'quick', 'free')).toBe(run({ q: 'free' }).total);
    expect(facetCount(facets, 'ages', '5-9')).toBe(run({ q: 'kids' }).total);
  });
});

describe('facet counts — category breakdown is in CARDS (F4)', () => {
  // The catalogue above collapses, but every slot of its repeated series carries the same
  // primaryCategoryKey, so the breakdown can never disagree with the total there. This bug needs
  // BOTH conditions at once: a card that collapses AND whose slots carry different categories.
  //
  // That is reachable because primary_category_id lives on activity_occurrence, not
  // activity_series (lib/search/postgres-repository.ts) — categorisation is per-occurrence, so
  // two slots of one series on one day can legitimately land in different categories.
  const HOUR = 3_600_000;
  const slotAt = (hoursAfter9am: number) =>
    new Date(Date.UTC(2026, 6, 13, 16, 0, 0) + hoursAfter9am * HOUR).toISOString();

  /** One series, one day, several slots — but the slots disagree about their category. */
  const MIXED_SERIES = 'series-mixed-category';
  const catalogue = [
    ...[
      { i: 0, category: 'indoor_play' },
      { i: 1, category: 'open_gym' },
      { i: 2, category: 'public_swim' },
      { i: 3, category: 'public_swim' },
    ].map(({ i, category }) =>
      makeListing({
        id: `mixed-slot-${i}`,
        seriesId: MIXED_SERIES,
        activityName: 'Community Centre Open Time',
        primaryCategoryKey: category,
        venueName: 'Killarney',
        startDatetimeUtc: slotAt(i),
        endDatetimeUtc: slotAt(i + 1),
        costStatus: 'free',
        statusState: 'confirmed',
        ageBandMatches: ['5-9'],
        municipalityId: 'van',
      }),
    ),
  ];

  const mixedCategoryEngine = new SearchEngine({
    repository: new InMemoryListingRepository(catalogue),
    aliasResolver: new FixtureAliasResolver(),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });

  const run = (req: Partial<SearchRequest> = {}) =>
    mixedCategoryEngine.search({ q: '', now: FIXTURE_NOW, minResults: 0, ...req });

  it('collapses four mixed-category slots of one series on one day into ONE card', () => {
    const res = run({ facets: true });
    expect(catalogue.length).toBe(4);
    expect(res.total).toBe(1);
    expect(res.facets?.total).toBe(1);
  });

  it('does not count that one card once per category it happens to touch', () => {
    const facets = run({ facets: true }).facets!;
    const category = facetGroup(facets, 'category')!;
    const sum = category.values.reduce((acc, v) => acc + v.count, 0);

    // The existing "sums to the total" guarantee, on a catalogue that can actually break it.
    // Pre-fix this is 3 (indoor_play:1 open_gym:1 public_swim:1) against a total of 1.
    expect(sum).toBe(facets.total);

    // And no single value may exceed the whole result set.
    for (const value of category.values) {
      expect(value.count).toBeLessThanOrEqual(facets.total);
    }
  });

  it('keeps the other groups card-counted, so the bug is scoped to the breakdown', () => {
    const facets = run({ facets: true }).facets!;
    const ages = facetGroup(facets, 'ages')!;
    const areas = facetGroup(facets, 'areas')!;
    expect(ages.values.find((v) => v.value === 'any')!.count).toBe(1);
    expect(areas.values.find((v) => v.value === 'van')!.count).toBe(1);
  });
});

describe('registration ("Courses") facet', () => {
  it('reports what opting into course content would add, and what the default holds back', () => {
    const facets = facetsFor();
    const group = facetGroup(facets, 'registration')!;
    expect(group.values.map((v) => v.value)).toEqual(['dropInOnly', 'includeRegistration']);
    // Default is drop-in only, and it is the selected value.
    expect(group.values.find((v) => v.value === 'dropInOnly')?.selected).toBe(true);
    // Opting in can only ever ADD, never remove — it is a widener, not a narrowing chip.
    const dropInOnly = facetCount(facets, 'registration', 'dropInOnly')!;
    const included = facetCount(facets, 'registration', 'includeRegistration')!;
    expect(included).toBeGreaterThanOrEqual(dropInOnly);
    // Both counts match what actually applying that choice returns.
    expect(dropInOnly).toBe(search().total);
    expect(included).toBe(search({ includeRegistration: true }).total);
  });

  it('shows a real gap when the catalogue is holding course content back', () => {
    const catalogue = [
      makeListing({
        id: 'course-1',
        activityName: 'Learn to Skate — Level 2',
        primaryCategoryKey: 'skate',
        startDatetimeUtc: '2026-07-13T18:00:00Z',
        endDatetimeUtc: '2026-07-13T19:00:00Z',
        statusState: 'confirmed',
        costStatus: 'free',
        municipalityId: 'van',
      }),
      makeListing({
        id: 'dropin-1',
        activityName: 'Public Skate',
        primaryCategoryKey: 'skate',
        startDatetimeUtc: '2026-07-13T18:00:00Z',
        endDatetimeUtc: '2026-07-13T19:00:00Z',
        statusState: 'confirmed',
        costStatus: 'free',
        municipalityId: 'van',
      }),
    ];
    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(catalogue),
      aliasResolver: new FixtureAliasResolver(),
      regionHierarchy: new RegionHierarchy(REGIONS),
      fixtureBacked: false,
    });
    const res = engine.search({ q: '', now: FIXTURE_NOW, minResults: 0, facets: true });
    expect(res.total).toBe(1); // the course is excluded by default
    expect(facetCount(res.facets!, 'registration', 'dropInOnly')).toBe(1);
    expect(facetCount(res.facets!, 'registration', 'includeRegistration')).toBe(2);
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

  it('counts the FULL age-band taxonomy, which is deliberately wider than the rail offers', () => {
    // The facet group counts the data vocabulary (lib/search/types AgeBandKey, the age_bands
    // seed). The rail's chip vocabulary (AGE_OPTIONS) is a strict SUBSET of it — '15+' was
    // retired from the chips on Jon's beta feedback without touching the taxonomy underneath.
    // Asserting them equal, as this test used to, would silently couple a product decision
    // about chips to a schema-level list; asserting the SUBSET relation states the real rule.
    const ages = valuesOf('ages');
    expect(ages[0]).toBe('any');
    for (const opt of AGE_OPTIONS) expect(ages).toContain(opt.key);
    expect(ages).toContain('15+');
    expect(AGE_OPTIONS.map((o) => o.key)).not.toContain('15+');
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
