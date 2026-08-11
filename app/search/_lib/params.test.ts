import { describe, expect, it } from 'vitest';
import {
  AGE_OPTIONS,
  DEFAULT_STATE,
  SORT_OPTIONS,
  analyticsFilterTokens,
  apiQuery,
  dateRangeFormFields,
  hasActiveFilters,
  hasDateRange,
  hasNearMeCoords,
  hasOrigin,
  hiddenStateFields,
  hrefFor,
  intentPhrases,
  parseSearchState,
  toggleAge,
  toggleRegion,
  type SearchState,
} from './params';
import { parseQuery } from '@/lib/search/parse';

/** Build a state from partial overrides on top of the defaults. */
function st(overrides: Partial<SearchState> = {}): SearchState {
  return { ...DEFAULT_STATE, ...overrides };
}

/** Parse an /api/search query string back into a param map for assertions. */
function apiParams(state: SearchState, savedOrigin?: { postal: string } | null): URLSearchParams {
  return new URLSearchParams(apiQuery(state, savedOrigin));
}

describe('parseSearchState', () => {
  it('returns defaults for empty params', () => {
    expect(parseSearchState({})).toEqual(DEFAULT_STATE);
  });

  it('keeps only valid sort / when values', () => {
    expect(parseSearchState({ sort: 'distance' }).sort).toBe('distance');
    expect(parseSearchState({ sort: 'nonsense' }).sort).toBe('best_match');
    expect(parseSearchState({ when: 'weekend' }).when).toBe('weekend');
    expect(parseSearchState({ when: 'someday' }).when).toBe('any');
  });

  it('no longer carries an includeUnknownCost state at all — the key is inert', () => {
    // The toggle was removed and unknown-cost listings are always included. What matters here
    // is that an explicit OFF signal in a stale/shared URL cannot resurrect the suppression:
    // the key is not parsed, so the state it produces is byte-identical to a bare /search.
    expect(parseSearchState({ includeUnknownCost: '0' })).toEqual(parseSearchState({}));
    expect('includeUnknownCost' in parseSearchState({ includeUnknownCost: '0' })).toBe(false);
  });

  it('ignores a stale `cost=` ceiling — no URL can reapply a control that is gone', () => {
    // Same shape of guard as above, for the removed Max price group. `cost=20` used to parse
    // into costMaxCad and compose "under $20" into the query; a shared link or a saved search
    // written before the removal must now be a no-op, not an invisible price ceiling.
    expect(parseSearchState({ cost: '20' })).toEqual(parseSearchState({}));
    expect(intentPhrases(parseSearchState({ cost: '20' }))).toEqual([]);
  });

  it('ignores a stale `sort=newest` — "Recently added" degrades to the default sort', () => {
    expect(parseSearchState({ sort: 'newest' }).sort).toBe(DEFAULT_STATE.sort);
    expect(SORT_OPTIONS.map((o) => o.key)).not.toContain('newest');
  });

  it('drops a stale `age=15+` — the retired band cannot be reapplied from a URL', () => {
    expect(parseSearchState({ age: '15+' }).ages).toEqual([]);
    expect(parseSearchState({ age: '15+,5-9' }).ages).toEqual(['5-9']);
    expect(AGE_OPTIONS.map((o) => o.key)).not.toContain('15+');
  });

  it('parses region csv, drops unknown ids, canonicalises order', () => {
    expect(parseSearchState({ region: 'bby,van,notreal' }).regions).toEqual(['van', 'bby']);
  });

  it('parses age csv into canonical band order', () => {
    expect(parseSearchState({ age: 'under2,5-9,10-14' }).ages).toEqual(['under2', '5-9', '10-14']);
  });

  it('parses boolean quick filters', () => {
    const s = parseSearchState({ bookable: '1', rainy: 'true', free: 'on' });
    expect([s.bookableNow, s.rainyDay, s.free]).toEqual([true, true, true]);
  });

  it('requires BOTH coords for a near-me origin, and validates radius', () => {
    expect(parseSearchState({ lat: '49.26', lng: '-123.07', radius: '5' })).toMatchObject({ lat: 49.26, lng: -123.07, radiusKm: 5 });
    expect(hasOrigin(parseSearchState({ lat: '49.26' }))).toBe(false); // lng missing
    expect(parseSearchState({ lat: '49.26', lng: '-123.07', radius: '7' }).radiusKm).toBe(10); // invalid radius → default
  });
});

describe('toggle helpers', () => {
  it('toggleRegion adds/removes and stays in canonical order', () => {
    const base = st({ regions: ['van'] });
    expect(toggleRegion(base, 'bby')).toEqual(['van', 'bby']);
    expect(toggleRegion(st({ regions: ['van', 'bby'] }), 'van')).toEqual(['bby']);
  });

  it('toggleAge adds/removes bands', () => {
    expect(toggleAge(st({ ages: ['5-9'] }), '2-4')).toEqual(['2-4', '5-9']);
    expect(toggleAge(st({ ages: ['2-4', '5-9'] }), '5-9')).toEqual(['2-4']);
  });
});

describe('hasActiveFilters', () => {
  it('is false for a plain text query, true once a filter is set', () => {
    expect(hasActiveFilters(st({ q: 'swim' }))).toBe(false);
    expect(hasActiveFilters(st({ bookableNow: true }))).toBe(true);
    expect(hasActiveFilters(st({ regions: ['van'] }))).toBe(true);
    expect(hasActiveFilters(st({ lat: 49.2, lng: -123 }))).toBe(true);
  });
});

describe('intentPhrases', () => {
  it('composes parent-language phrases the query parser understands', () => {
    const phrases = intentPhrases(st({ when: 'weekend', bookableNow: true, rainyDay: true, free: true, ages: ['5-9', '10-14'] }));
    expect(phrases).toEqual(['this weekend', 'bookable now', 'rainy day', 'free', 'kids', 'tween']);
  });

  it('adds a radius phrase only when an origin is present', () => {
    expect(intentPhrases(st({ radiusKm: 5 }))).not.toContain('5 km');
    expect(intentPhrases(st({ lat: 49.26, lng: -123.07, radiusKm: 5 }))).toContain('5 km');
  });
});

describe('apiQuery', () => {
  it('folds the intent phrases into q and passes region/coords as structured params', () => {
    const p = apiParams(st({ q: 'open gym', when: 'today', bookableNow: true, ages: ['under2'], regions: ['van', 'bby'], lat: 49.26, lng: -123.07, radiusKm: 5 }));
    expect(p.get('q')).toBe('open gym today bookable now under 2 5 km');
    expect(p.get('region')).toBe('van,bby');
    expect(p.get('lat')).toBe('49.26');
    expect(p.get('lng')).toBe('-123.07');
  });

  it('minResults respects the broadening policy', () => {
    expect(apiParams(st()).get('minResults')).toBe('60'); // bare browse
    expect(apiParams(st({ q: 'swim' })).get('minResults')).toBe('12'); // text only
    expect(apiParams(st({ q: 'swim', rainyDay: true })).get('minResults')).toBe('3'); // filters active
    expect(apiParams(st({ regions: ['van'] })).get('minResults')).toBe('3');
  });

  it('omits coords when the origin is incomplete', () => {
    expect(apiParams(st({ lat: 49.26 })).has('lat')).toBe(false);
  });
});

describe('custom date range (T26 / G-T26-1, FR-04)', () => {
  it('parses a complete from/to range and reports it active', () => {
    const s = parseSearchState({ from: '2026-07-18', to: '2026-07-20' });
    expect(s.dateFrom).toBe('2026-07-18');
    expect(s.dateTo).toBe('2026-07-20');
    expect(hasDateRange(s)).toBe(true);
  });

  it('canonicalises a reversed range so dateFrom<=dateTo', () => {
    const s = parseSearchState({ from: '2026-07-20', to: '2026-07-18' });
    expect(s.dateFrom).toBe('2026-07-18');
    expect(s.dateTo).toBe('2026-07-20');
  });

  it('rejects malformed dates and treats a partial range as inactive', () => {
    expect(parseSearchState({ from: 'nope', to: '2026-07-20' }).dateFrom).toBeNull();
    const partial = parseSearchState({ from: '2026-07-18' });
    expect(partial.dateFrom).toBe('2026-07-18');
    expect(partial.dateTo).toBeNull();
    expect(hasDateRange(partial)).toBe(false);
  });

  it('a complete range clears the WHEN quick-pick (mutually exclusive date intent)', () => {
    const s = parseSearchState({ when: 'weekend', from: '2026-07-18', to: '2026-07-20' });
    expect(s.when).toBe('any');
    expect(hasDateRange(s)).toBe(true);
  });

  it('forwards from/to to the API as STRUCTURED params, never composed into q', () => {
    const p = apiParams(st({ q: 'swim', dateFrom: '2026-07-18', dateTo: '2026-07-20' }));
    expect(p.get('from')).toBe('2026-07-18');
    expect(p.get('to')).toBe('2026-07-20');
    expect(p.get('q')).toBe('swim'); // the ISO dates never leak into the free-text query
  });

  it('serialises from/to into the shareable page URL and counts as an active filter', () => {
    const href = hrefFor(st({ dateFrom: '2026-07-18', dateTo: '2026-07-20' }));
    const p = new URLSearchParams(href.split('?')[1]);
    expect(p.get('from')).toBe('2026-07-18');
    expect(p.get('to')).toBe('2026-07-20');
    expect(hasActiveFilters(st({ dateFrom: '2026-07-18', dateTo: '2026-07-20' }))).toBe(true);
    expect(analyticsFilterTokens(st({ dateFrom: '2026-07-18', dateTo: '2026-07-20' }))).toContain('date_range');
  });

  it('date-form hidden fields carry the rest of the search but omit from/to/when', () => {
    const fields = dateRangeFormFields(
      st({ q: 'swim', when: 'weekend', regions: ['van'], dateFrom: '2026-07-18', dateTo: '2026-07-20' }),
    );
    const names = fields.map((f) => f.name);
    expect(names).toContain('q');
    expect(names).toContain('region');
    expect(names).not.toContain('from');
    expect(names).not.toContain('to');
    expect(names).not.toContain('when');
  });
});

describe('hrefFor', () => {
  it('serialises only non-default params and keeps them shareable', () => {
    expect(hrefFor(st())).toBe('/search');
    const href = hrefFor(st({ q: 'swim', when: 'weekend', ages: ['5-9'], regions: ['van'], bookableNow: true }));
    const p = new URLSearchParams(href.split('?')[1]);
    expect(p.get('q')).toBe('swim');
    expect(p.get('when')).toBe('weekend');
    expect(p.get('age')).toBe('5-9');
    expect(p.get('region')).toBe('van');
    expect(p.get('bookable')).toBe('1');
  });

  it('applies overrides (tap-to-change) over the current state', () => {
    const p = new URLSearchParams(hrefFor(st({ when: 'today' }), { when: 'weekend' }).split('?')[1]);
    expect(p.get('when')).toBe('weekend');
  });

  it('includes radius only alongside a near-me origin', () => {
    expect(hrefFor(st({ radiusKm: 5 }))).not.toContain('radius=');
    expect(hrefFor(st({ lat: 49.26, lng: -123.07, radiusKm: 5 }))).toContain('radius=5');
  });
});

describe('hiddenStateFields', () => {
  it('carries filter state but never the visible q input', () => {
    const fields = hiddenStateFields(st({ q: 'swim', when: 'weekend', bookableNow: true }));
    const names = fields.map((f) => f.name);
    expect(names).not.toContain('q');
    expect(names).toContain('when');
    expect(names).toContain('bookable');
    expect(names).not.toContain('includeUnknownCost');
  });
});

describe('analyticsFilterTokens', () => {
  it('is empty for a bare state (no filters)', () => {
    expect(analyticsFilterTokens(DEFAULT_STATE)).toEqual([]);
  });

  it('namespaces date and age tokens and flattens the quick toggles', () => {
    const tokens = analyticsFilterTokens(
      st({ when: 'weekend', bookableNow: true, rainyDay: true, free: true, ages: ['5-9', 'under2'] })
    );
    expect(tokens).toContain('when:weekend');
    expect(tokens).toContain('bookable_now');
    expect(tokens).toContain('rainy_day');
    expect(tokens).toContain('free');
    expect(tokens).toContain('age:5-9');
    expect(tokens).toContain('age:under2');
  });

  it('records near_me intent WITHOUT the origin coordinates (non-PII)', () => {
    const tokens = analyticsFilterTokens(st({ lat: 49.26, lng: -123.07, radiusKm: 5 }));
    expect(tokens).toContain('near_me');
    // No token leaks the actual latitude/longitude.
    expect(tokens.join(' ')).not.toContain('49.26');
    expect(tokens.join(' ')).not.toContain('-123.07');
  });

  it('omits near_me when only one coordinate is present (no real origin)', () => {
    expect(analyticsFilterTokens(st({ lat: 49.26, lng: null }))).not.toContain('near_me');
  });

  it('never includes regions (captured on their own array)', () => {
    const tokens = analyticsFilterTokens(st({ regions: ['van', 'rmd'], free: true }));
    expect(tokens).toEqual(['free']);
  });

  it('records saved_home (not near_me) for the saved-location intent', () => {
    const tokens = analyticsFilterTokens(st({ useSavedLocation: true }));
    expect(tokens).toContain('saved_home');
    expect(tokens).not.toContain('near_me');
  });
});

describe('saved-location origin (Task 29)', () => {
  it('parses ?home=1 into the saved-location intent', () => {
    expect(parseSearchState({ home: '1' }).useSavedLocation).toBe(true);
    expect(parseSearchState({}).useSavedLocation).toBe(false);
  });

  it('near-me coords take precedence over the saved-location intent', () => {
    const s = parseSearchState({ home: '1', lat: '49.26', lng: '-123.07' });
    expect(s.useSavedLocation).toBe(false);
    expect(hasNearMeCoords(s)).toBe(true);
  });

  it('hasOrigin is true for either origin; hasNearMeCoords only for coords', () => {
    const saved = st({ useSavedLocation: true });
    expect(hasOrigin(saved)).toBe(true);
    expect(hasNearMeCoords(saved)).toBe(false);
    expect(hasActiveFilters(saved)).toBe(true);
  });

  it('serialises only the home flag (never the postal) and keeps radius shareable', () => {
    const href = hrefFor(st({ useSavedLocation: true, radiusKm: 5 }));
    const p = new URLSearchParams(href.split('?')[1]);
    expect(p.get('home')).toBe('1');
    expect(p.get('radius')).toBe('5');
    expect(p.has('postal')).toBe(false);
    expect(p.has('lat')).toBe(false);
  });

  it('composes a radius phrase for a saved-location origin', () => {
    expect(intentPhrases(st({ useSavedLocation: true, radiusKm: 20 }))).toContain('20 km');
  });

  it('forwards the resolved postal + signedIn to /api/search only when chosen', () => {
    const chosen = apiParams(st({ q: 'swim', useSavedLocation: true }), { postal: 'V6K 1A1' });
    expect(chosen.get('postal')).toBe('V6K 1A1');
    expect(chosen.get('signedIn')).toBe('1');
    // Without a resolved saved origin, nothing is forwarded.
    const noOrigin = apiParams(st({ q: 'swim', useSavedLocation: true }), null);
    expect(noOrigin.has('postal')).toBe(false);
    expect(noOrigin.has('signedIn')).toBe(false);
  });

  it('near-me coords win over the saved postal at the API boundary', () => {
    const p = apiParams(st({ useSavedLocation: true, lat: 49.26, lng: -123.07 }), { postal: 'V6K 1A1' });
    expect(p.get('lat')).toBe('49.26');
    expect(p.has('postal')).toBe(false);
  });
});

describe('Round 30 — an unset filter group means "no filter / show everything"', () => {
  // Jon's hands-on feedback + an independent UX-review follow-up: every filter group must
  // clearly signal that leaving it unset shows everything. Ages / Areas / Max price / When /
  // Time do this with a checkmarked "Any X" default pill (see FilterRail); Quick filters
  // (independent, non-exclusive toggles with no single "Any" chip) does it with a quiet
  // "· optional" label. Whatever the visual, the underlying promise is identical: an untouched
  // group composes NO filter. These lock that promise against a future hidden default.
  it('AGES: a bare state selects no band and composes no age phrase (results span every age)', () => {
    expect(parseSearchState({}).ages).toEqual([]);
    expect(DEFAULT_STATE.ages).toEqual([]);
    const phrases = intentPhrases(DEFAULT_STATE);
    for (const opt of AGE_OPTIONS) {
      if (opt.phrase) expect(phrases).not.toContain(opt.phrase);
    }
  });

  it('AREAS: a bare state selects no region (results span everywhere in Metro Vancouver)', () => {
    expect(parseSearchState({}).regions).toEqual([]);
    expect(DEFAULT_STATE.regions).toEqual([]);
  });

  it('QUICK FILTERS: all four default OFF and compose no status/suitability/cost phrase', () => {
    const s = parseSearchState({});
    expect([s.bookableNow, s.dropIn, s.rainyDay, s.free]).toEqual([false, false, false, false]);
    const phrases = intentPhrases(DEFAULT_STATE);
    expect(phrases).not.toContain('bookable now');
    expect(phrases).not.toContain('drop-in');
    expect(phrases).not.toContain('rainy day');
    expect(phrases).not.toContain('free');
  });

  it('MAX PRICE: no ceiling exists in the state at all, from any params', () => {
    // Stronger than the old "defaults to null": the field is gone, so there is no default to
    // get wrong and no params combination that produces an "under $N" phrase.
    expect(intentPhrases(DEFAULT_STATE).some((p) => p.startsWith('under $'))).toBe(false);
    expect(intentPhrases(parseSearchState({ cost: '20' })).some((p) => p.startsWith('under $'))).toBe(false);
    expect(intentPhrases(parseSearchState({ cost: '50' })).some((p) => p.startsWith('under $'))).toBe(false);
  });

  it('all groups unset together ⇒ zero filter tokens, empty q, and a full bare browse (minResults 60)', () => {
    expect(analyticsFilterTokens(DEFAULT_STATE)).toEqual([]);
    const api = new URLSearchParams(apiQuery(DEFAULT_STATE));
    // Nothing about age / area / status / cost reaches the backend query string.
    expect(api.get('q')).toBe('');
    expect(api.has('region')).toBe(false);
    expect(api.get('minResults')).toBe('60');
  });

  it('the "Any X" reset links clear ONLY their own group (the href the Any-age/Any-area pills use)', () => {
    // "Any age" pill → hrefFor(state, { ages: [] }); clears ages, leaves areas intact.
    const ap = new URLSearchParams(hrefFor(st({ ages: ['5-9', '10-14'], regions: ['van'] }), { ages: [] }).split('?')[1] ?? '');
    expect(ap.has('age')).toBe(false);
    expect(ap.get('region')).toBe('van');
    // "Any area" pill → hrefFor(state, { regions: [] }); clears areas, leaves ages intact.
    const rp = new URLSearchParams(hrefFor(st({ ages: ['5-9'], regions: ['van', 'bby'] }), { regions: [] }).split('?')[1] ?? '');
    expect(rp.has('region')).toBe(false);
    expect(rp.get('age')).toBe('5-9');
  });
});

describe('time-of-day and drop-in filters (Round 17 / T21 — G-T21-3/4)', () => {
  // The max-price half of this group was removed on Jon's beta feedback. What remains here is
  // the time-of-day / drop-in wiring, plus explicit proof that the price ceiling is gone from
  // EVERY layer of the URL contract rather than just from the rail markup.
  it('parses ?time / ?dropin and rejects invalid values', () => {
    expect(parseSearchState({ time: 'morning' }).timeOfDay).toBe('morning');
    expect(parseSearchState({ time: 'midnight' }).timeOfDay).toBe('any');
    expect(parseSearchState({ dropin: '1' }).dropIn).toBe(true);
  });

  it('serialises only non-default values into the shareable page URL, and never a `cost=`', () => {
    const p = new URLSearchParams(hrefFor(st({ timeOfDay: 'evening', dropIn: true })).split('?')[1]);
    expect(p.get('time')).toBe('evening');
    expect(p.get('dropin')).toBe('1');
    expect(p.has('cost')).toBe(false);
    const bare = new URLSearchParams(hrefFor(st({})).split('?')[1] ?? '');
    expect(bare.has('time')).toBe(false);
    expect(bare.has('cost')).toBe(false);
    expect(bare.has('dropin')).toBe(false);
  });

  it('a page URL round-trips through serialise → parse identically', () => {
    const state = st({ timeOfDay: 'afternoon', dropIn: true });
    const parsed = parseSearchState(Object.fromEntries(new URLSearchParams(hrefFor(state).split('?')[1])));
    expect(parsed.timeOfDay).toBe('afternoon');
    expect(parsed.dropIn).toBe(true);
  });

  it('counts each as an active filter, and a stale `cost=` counts as nothing', () => {
    expect(hasActiveFilters(st({ timeOfDay: 'morning' }))).toBe(true);
    expect(hasActiveFilters(st({ dropIn: true }))).toBe(true);
    expect(hasActiveFilters(parseSearchState({ cost: '20' }))).toBe(false);
  });

  it('emits stable, non-PII analytics tokens, and no cost_max token', () => {
    const tokens = analyticsFilterTokens(st({ timeOfDay: 'evening', dropIn: true }));
    expect(tokens).toEqual(expect.arrayContaining(['time:evening', 'drop_in']));
    expect(analyticsFilterTokens(parseSearchState({ cost: '50' }))).toEqual([]);
  });

  it('DECISIVE: neither a stale `cost=` NOR a TYPED "under $20" reaches the backend as a ceiling', () => {
    // The end-to-end check that matters, now covering BOTH halves. Previously `?cost=20`
    // composed "under $20" into `q`, which parseQuery turned into ctx.costMaxCad=20 and
    // filters/cost.ts turned into a price ceiling. The beta round closed the URL half and
    // deliberately left the typed half open, flagging it for Jon; he ruled on 2026-08-11 that
    // the ceiling goes entirely. Asserting only the URL half is what let that asymmetry live.
    const stale = parseSearchState({ q: 'swim', cost: '20', time: 'morning', dropin: '1' });
    const q = new URLSearchParams(apiQuery(stale)).get('q') ?? '';
    const ctx = parseQuery(q);
    // No ceiling anywhere in the parsed context. Asserted structurally because the field is
    // gone from SearchContext — a `ctx.costMaxCad` read would no longer compile, and a guard
    // deleted to make the file compile is a guard that stopped guarding.
    expect(Object.keys(ctx)).not.toContain('costMaxCad');
    expect(ctx.timeOfDay).toBe('morning');
    expect(ctx.dropIn).toBe(true);
    expect(ctx.terms).toContain('swim');

    // The typed half: the phrase is still STRIPPED (it is cost intent, not content, and the
    // matcher ORs user terms) but contributes no constraint and no extra term.
    const typed = parseQuery('swim under $20');
    expect(Object.keys(typed)).not.toContain('costMaxCad');
    expect(typed.terms).toEqual(parseQuery('swim').terms);
  });
});
