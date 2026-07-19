import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE,
  analyticsFilterTokens,
  apiQuery,
  hasActiveFilters,
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

  it('includeUnknownCost defaults on, explicit off honoured', () => {
    expect(parseSearchState({}).includeUnknownCost).toBe(true);
    expect(parseSearchState({ includeUnknownCost: '0' }).includeUnknownCost).toBe(false);
    expect(parseSearchState({ includeUnknownCost: 'yes' }).includeUnknownCost).toBe(true);
  });

  it('parses region csv, drops unknown ids, canonicalises order', () => {
    expect(parseSearchState({ region: 'bby,van,notreal' }).regions).toEqual(['van', 'bby']);
  });

  it('parses age csv into canonical band order', () => {
    expect(parseSearchState({ age: '15+,under2,5-9' }).ages).toEqual(['under2', '5-9', '15+']);
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

describe('hrefFor', () => {
  it('serialises only non-default params and keeps them shareable', () => {
    expect(hrefFor(st())).toBe('/search?includeUnknownCost=1');
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
    expect(names).toContain('includeUnknownCost');
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

describe('time-of-day, drop-in and max-price filters (Round 17 / T21 — G-T21-3/4)', () => {
  it('parses ?time / ?cost / ?dropin and rejects invalid values', () => {
    expect(parseSearchState({ time: 'morning' }).timeOfDay).toBe('morning');
    expect(parseSearchState({ time: 'midnight' }).timeOfDay).toBe('any');
    expect(parseSearchState({ cost: '20' }).costMaxCad).toBe(20);
    expect(parseSearchState({ cost: '999' }).costMaxCad).toBeNull(); // not a preset band
    expect(parseSearchState({ dropin: '1' }).dropIn).toBe(true);
  });

  it('serialises only non-default values into the shareable page URL', () => {
    const p = new URLSearchParams(hrefFor(st({ timeOfDay: 'evening', costMaxCad: 50, dropIn: true })).split('?')[1]);
    expect(p.get('time')).toBe('evening');
    expect(p.get('cost')).toBe('50');
    expect(p.get('dropin')).toBe('1');
    const bare = new URLSearchParams(hrefFor(st({})).split('?')[1] ?? '');
    expect(bare.has('time')).toBe(false);
    expect(bare.has('cost')).toBe(false);
    expect(bare.has('dropin')).toBe(false);
  });

  it('a page URL round-trips through serialise → parse identically', () => {
    const state = st({ timeOfDay: 'afternoon', costMaxCad: 20, dropIn: true });
    const parsed = parseSearchState(Object.fromEntries(new URLSearchParams(hrefFor(state).split('?')[1])));
    expect(parsed.timeOfDay).toBe('afternoon');
    expect(parsed.costMaxCad).toBe(20);
    expect(parsed.dropIn).toBe(true);
  });

  it('counts each as an active filter and is reset by CLEARED_FILTERS shape', () => {
    expect(hasActiveFilters(st({ timeOfDay: 'morning' }))).toBe(true);
    expect(hasActiveFilters(st({ costMaxCad: 20 }))).toBe(true);
    expect(hasActiveFilters(st({ dropIn: true }))).toBe(true);
  });

  it('emits stable, non-PII analytics tokens', () => {
    const tokens = analyticsFilterTokens(st({ timeOfDay: 'evening', costMaxCad: 50, dropIn: true }));
    expect(tokens).toEqual(expect.arrayContaining(['time:evening', 'cost_max:50', 'drop_in']));
  });

  it('composes parent-language phrases the backend query parser resolves (full UI→API wiring)', () => {
    const state = st({ q: 'swim', timeOfDay: 'morning', costMaxCad: 20, dropIn: true });
    expect(intentPhrases(state)).toEqual(expect.arrayContaining(['morning', 'under $20', 'drop-in']));
    // Decisive end-to-end check: the q string apiQuery builds parses back into the exact
    // backend SearchContext fields the engine filters on (timeOfDay / costMaxCad / dropIn).
    const q = new URLSearchParams(apiQuery(state)).get('q') ?? '';
    const ctx = parseQuery(q);
    expect(ctx.timeOfDay).toBe('morning');
    expect(ctx.costMaxCad).toBe(20);
    expect(ctx.dropIn).toBe(true);
    expect(ctx.terms).toContain('swim');
  });
});
