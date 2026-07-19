// tests/saved_search_ui_params.test.ts — the "Save this search" serialization
// helpers (Round 10 / Task B). Pure, no DB: proves the current /search filter
// state serializes into the persisted `params` envelope Task 38's backend accepts,
// round-trips back into an identical SearchState (so a saved search re-runs the
// same way), never leaks raw near-me coordinates, and produces a stable, order-
// independent dedupe key.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STATE,
  parseSearchState,
  serializeStateToParams,
  savedSearchKey,
  hrefForParams,
  type SearchState,
} from '@/app/search/_lib/params';

// A rich, non-near-me state: text + non-default sort + explicit cost-off + regions
// + date + quick filters + ages + saved-location (home) intent + non-default radius.
const RICH_STATE: SearchState = {
  q: 'family swim',
  sort: 'soonest',
  includeUnknownCost: false,
  regions: ['van', 'bby'],
  when: 'weekend',
  dateFrom: null,
  dateTo: null,
  timeOfDay: 'any',
  bookableNow: true,
  rainyDay: false,
  dropIn: false,
  free: true,
  costMaxCad: null,
  ages: ['2-4', '5-9'],
  lat: null,
  lng: null,
  useSavedLocation: true,
  radiusKm: 20,
};

describe('serializeStateToParams', () => {
  it('captures the full structured filter state as a compact string map', () => {
    expect(serializeStateToParams(RICH_STATE)).toEqual({
      q: 'family swim',
      sort: 'soonest',
      includeUnknownCost: '0',
      region: 'van,bby',
      when: 'weekend',
      bookable: '1',
      free: '1',
      age: '2-4,5-9',
      home: '1',
      radius: '20',
    });
  });

  it('omits includeUnknownCost when it is at its default (on)', () => {
    const params = serializeStateToParams({ ...DEFAULT_STATE, q: 'gym' });
    expect(params).toEqual({ q: 'gym' });
    expect('includeUnknownCost' in params).toBe(false);
  });

  it('NEVER persists raw near-me coordinates (privacy parity with analytics)', () => {
    const nearMe: SearchState = {
      ...DEFAULT_STATE,
      q: 'swim',
      lat: 49.2827,
      lng: -123.1207,
      radiusKm: 20,
    };
    const params = serializeStateToParams(nearMe);
    expect(params).toEqual({ q: 'swim' }); // coords + their origin-less radius dropped
    expect('lat' in params).toBe(false);
    expect('lng' in params).toBe(false);
    expect('radius' in params).toBe(false);
  });

  it('serializes a near-me-ONLY search (no query/filters) to empty params — not savable (QA F1)', () => {
    const nearMeOnly: SearchState = { ...DEFAULT_STATE, lat: 49.2827, lng: -123.1207, radiusKm: 20 };
    // Coords are stripped for privacy and there's nothing else, so params is empty.
    // The page MUST gate the Save control on Object.keys(params).length > 0 so it
    // never offers a save the API would 400 with "must include at least one field".
    expect(serializeStateToParams(nearMeOnly)).toEqual({});
    expect(Object.keys(serializeStateToParams(nearMeOnly)).length).toBe(0);
  });

  it('keeps the saved-location intent + radius (carries no coordinates)', () => {
    const params = serializeStateToParams({
      ...DEFAULT_STATE,
      useSavedLocation: true,
      radiusKm: 5,
    });
    expect(params.home).toBe('1');
    expect(params.radius).toBe('5');
  });
});

describe('serialize → parse round-trip', () => {
  it('re-parses a non-near-me state identically (a saved search re-runs the same)', () => {
    const params = serializeStateToParams(RICH_STATE);
    expect(parseSearchState(params)).toEqual(RICH_STATE);
  });

  it('re-parses via a rebuilt /search href identically', () => {
    const href = hrefForParams(serializeStateToParams(RICH_STATE));
    const qs = href.split('?')[1] ?? '';
    const reparsed = parseSearchState(Object.fromEntries(new URLSearchParams(qs)));
    expect(reparsed).toEqual(RICH_STATE);
  });
});

describe('savedSearchKey', () => {
  it('is order-independent', () => {
    expect(savedSearchKey({ q: 'swim', region: 'van' })).toBe(savedSearchKey({ region: 'van', q: 'swim' }));
  });

  it('distinguishes different searches', () => {
    expect(savedSearchKey({ q: 'swim' })).not.toBe(savedSearchKey({ q: 'gym' }));
  });

  it('is stable for equivalent serialized states (dedupe basis)', () => {
    const a = serializeStateToParams(RICH_STATE);
    const b = serializeStateToParams({ ...RICH_STATE });
    expect(savedSearchKey(a)).toBe(savedSearchKey(b));
  });

  it('handles non-string values from hand-built /account params', () => {
    // JSON-encoded so a numeric/object value still yields a stable key. Escaping is
    // transparent for alphanumerics, so the readable form is unchanged.
    expect(savedSearchKey({ n: 3, region: 'van' })).toBe('n=3&region=van');
    expect(savedSearchKey({ region: 'van', n: 3 })).toBe('n=3&region=van');
  });

  it('escapes so a value containing & or = cannot collide (QA F2)', () => {
    expect(savedSearchKey({ q: 'a&region=van' })).not.toBe(savedSearchKey({ q: 'a', region: 'van' }));
    // And an '=' inside a value can't masquerade as another pair either.
    expect(savedSearchKey({ q: 'x=1' })).not.toBe(savedSearchKey({ q: 'x', '1': '' }));
  });
});

describe('hrefForParams', () => {
  it('rebuilds a /search href from stored params', () => {
    expect(hrefForParams({ q: 'swim', region: 'van' })).toBe('/search?q=swim&region=van');
  });

  it('returns bare /search for empty params', () => {
    expect(hrefForParams({})).toBe('/search');
  });

  it('skips null/undefined and coerces non-strings', () => {
    expect(hrefForParams({ q: 'swim', missing: null, gone: undefined, radius: 20 })).toBe(
      '/search?q=swim&radius=20'
    );
  });
});
