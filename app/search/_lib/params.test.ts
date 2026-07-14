import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE,
  apiQuery,
  hasActiveFilters,
  hasOrigin,
  hiddenStateFields,
  hrefFor,
  intentPhrases,
  parseSearchState,
  toggleAge,
  toggleRegion,
  type SearchState,
} from './params';

/** Build a state from partial overrides on top of the defaults. */
function st(overrides: Partial<SearchState> = {}): SearchState {
  return { ...DEFAULT_STATE, ...overrides };
}

/** Parse an /api/search query string back into a param map for assertions. */
function apiParams(state: SearchState): URLSearchParams {
  return new URLSearchParams(apiQuery(state));
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
