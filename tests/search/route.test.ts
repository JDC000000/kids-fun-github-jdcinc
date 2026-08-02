// tests/search/route.test.ts — Search API route stub (G-T16-7).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../../app/api/search/route';
import { clearGeocodeCache } from '../../lib/geo/geocode';

async function call(qs: string) {
  const res = await GET(new Request(`http://localhost/api/search?${qs}`));
  return { res, body: await res.json() };
}

describe('GET /api/search (fixture stub)', () => {
  // Keep this suite hermetic + offline: with no geocoding key, a signed-in saved-home
  // postal deterministically resolves via the Task-29 FSA-centroid fallback (Task 36).
  const savedKey = process.env.GEOCODING_API_KEY;
  beforeEach(() => {
    clearGeocodeCache();
    delete process.env.GEOCODING_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEOCODING_API_KEY;
    else process.env.GEOCODING_API_KEY = savedKey;
  });

  it('returns fixture-backed results for "open gym near me" with the data-source header', async () => {
    const { res, body } = await call('q=open+gym&lat=49.26&lng=-123.07&minResults=1');
    expect(res.headers.get('x-data-source')).toBe('fixture');
    expect(body.meta.fixtureBacked).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].listing.primaryCategoryKey).toBe('open_gym');
  });

  it('honours the sort control and region chips via query params', async () => {
    const { body } = await call('q=open+gym&lat=49.26&lng=-123.07&sort=distance&region=van&minResults=1');
    expect(body.meta.sort).toBe('distance');
    // region=van restricts to Vancouver-tagged listings
    expect(body.results.every((r: { listing: { municipalityId: string } }) => r.listing.municipalityId === 'van')).toBe(true);
  });

  it('does not invent a 0,0 near-me origin when lat/lng are omitted', async () => {
    const { body } = await call('q=open+gym&minResults=1');
    expect(body.origin).toBeNull();
    expect(body.originError).toBeNull();
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('resolves a signed-in saved-home origin from a postal code (Task 29)', async () => {
    // V6X is a Richmond FSA that the 3-entry test double never knew — proving the fuller
    // Metro-Vancouver fsaGeocoder is the active resolver. With signedIn=1 the postal
    // resolves to an area-level origin (no browser geolocation, no lat/lng needed).
    const { body } = await call('q=open+gym&postal=V6X+1A1&signedIn=1&minResults=1');
    expect(body.originError).toBeNull();
    expect(body.origin).not.toBeNull();
    expect(body.origin.mode).toBe('saved_home');
    // Origin lands on the Richmond municipality centroid (~49.17, -123.13), not 0,0.
    expect(body.origin.geo.lat).toBeCloseTo(49.1666, 2);
    expect(body.origin.geo.lng).toBeCloseTo(-123.1336, 2);
  });

  it('gates the saved-home origin on sign-in (no postal origin when signedIn is absent)', async () => {
    const { body } = await call('q=open+gym&postal=V6X+1A1&minResults=1');
    expect(body.origin).toBeNull();
    expect(body.originError).toContain('auth_required');
    // Search still succeeds, just without a radius origin (never load-bearing).
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('returns an empty-state explanation when nothing matches in range', async () => {
    const { body } = await call('q=public+skate&lat=49.26&lng=-123.07&minResults=1');
    expect(body.broadening.emptyState).not.toBeNull();
    expect(body.broadening.applied.length).toBeGreaterThan(0);
  });

  it('fails honestly (5xx, never fixtures) when database mode is on but the DB is unavailable', async () => {
    // Behaviour change — P0 fixture-leak fix. Previously a genuine DB outage in database mode
    // fell back to fixture/test rows (x-data-source: database-fallback-fixture), which showed
    // "Rank Test Gym" to real visitors. A true outage is categorically different from a real
    // zero-match result: we could not search at all, so the route now returns a 5xx (clients
    // render their existing "couldn't load — try again" state) and NEVER fixtures — and it
    // must not masquerade as a "nothing matches" result either.
    const oldBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
    const oldDb = process.env.DATABASE_URL;
    process.env.KIDS_FUN_SEARCH_BACKEND = 'database';
    delete process.env.DATABASE_URL; // getPool() throws → searchDatabase catch → honest 5xx
    try {
      const { res, body } = await call('q=open+gym&lat=49.26&lng=-123.07&minResults=1');
      expect(res.status).toBe(503);
      expect(res.headers.get('x-data-source')).not.toBe('database-fallback-fixture');
      // No fixture/test payload of any kind in an outage response.
      expect(body.results).toBeUndefined();
      expect(body.meta).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/Rank Test Gym|l-rank-confirmed|Test Centre/);
    } finally {
      if (oldBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
      else process.env.KIDS_FUN_SEARCH_BACKEND = oldBackend;
      if (oldDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldDb;
    }
  });

});

describe('GET /api/search — precise saved-home geocoding (Task 36)', () => {
  const savedKey = process.env.GEOCODING_API_KEY;
  beforeEach(() => {
    clearGeocodeCache();
    process.env.GEOCODING_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.GEOCODING_API_KEY;
    else process.env.GEOCODING_API_KEY = savedKey;
  });

  it('resolves a signed-in saved-home postal to the precise Mapbox point, not the FSA centroid', async () => {
    const preciseCenter = [-123.17059, 49.264034]; // Kitsilano V6K 2G8 (Mapbox [lng, lat])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ features: [{ center: preciseCenter }] }), { status: 200 })
      )
    );
    const { body } = await call('q=open+gym&postal=V6K+2G8&signedIn=1&minResults=1');
    expect(body.origin).not.toBeNull();
    expect(body.origin.mode).toBe('saved_home');
    // Precise Kitsilano point — NOT the Vancouver municipality centroid (~49.2827, -123.1207).
    expect(body.origin.geo.lat).toBeCloseTo(49.264034, 4);
    expect(body.origin.geo.lng).toBeCloseTo(-123.17059, 4);
  });

  it('still degrades to the FSA centroid when Mapbox fails at request time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('mapbox down'); }));
    const { body } = await call('q=open+gym&postal=V6X+1A1&signedIn=1&minResults=1');
    expect(body.origin).not.toBeNull();
    // Richmond municipality centroid from the Task-29 FSA fallback.
    expect(body.origin.geo.lat).toBeCloseTo(49.1666, 2);
    expect(body.origin.geo.lng).toBeCloseTo(-123.1336, 2);
  });
});

describe('GET /api/search — facet counts for the filter UI (facets=1)', () => {
  // Counts ride along with the search that produced them rather than living on a second
  // endpoint, so the filter UI gets results and counts from one request — see the note in
  // buildSearchRequest for why a separate /facets route would double the pipeline cost.
  it('omits facets unless they are asked for', async () => {
    const { body } = await call('q=open+gym&minResults=1');
    expect(body.facets).toBeUndefined();
  });

  it('returns per-value counts for every filter group, agreeing with the result total', async () => {
    const { body } = await call('q=open+gym&facets=1&minResults=0');
    expect(body.facets.total).toBe(body.total);
    expect(body.facets.groups.map((g: { key: string }) => g.key)).toEqual(
      expect.arrayContaining(['when', 'timeOfDay', 'ages', 'areas', 'quick', 'costMax', 'category'])
    );
    const ages = body.facets.groups.find((g: { key: string }) => g.key === 'ages');
    expect(ages.values.map((v: { value: string }) => v.value)).toEqual([
      'any', 'under2', '2-4', '5-9', '10-14', '15+',
    ]);
    expect(ages.values.every((v: { count: number }) => Number.isInteger(v.count))).toBe(true);
  });

  it('counts against the filters already applied, and marks them selected', async () => {
    const { body } = await call('q=open+gym&region=van&facets=1&minResults=0');
    const areas = body.facets.groups.find((g: { key: string }) => g.key === 'areas');
    expect(areas.values.find((v: { value: string }) => v.value === 'van').selected).toBe(true);
    // Every listed result is in Vancouver, so the Vancouver count is the whole result set…
    expect(areas.values.find((v: { value: string }) => v.value === 'van').count).toBe(body.total);
    // …while the other areas still report what SWITCHING to them would give (drop-one).
    const nvan = areas.values.find((v: { value: string }) => v.value === 'nvan');
    const { body: nvanBody } = await call('q=open+gym&region=nvan&facets=1&minResults=0');
    expect(nvan.count).toBe(nvanBody.total);
  });

  it('adds the radius group only once an origin is in play', async () => {
    const { body: noOrigin } = await call('q=open+gym&facets=1&minResults=0');
    expect(noOrigin.facets.groups.some((g: { key: string }) => g.key === 'radius')).toBe(false);
    const { body: nearMe } = await call('q=open+gym&lat=49.26&lng=-123.07&facets=1&minResults=0');
    const radius = nearMe.facets.groups.find((g: { key: string }) => g.key === 'radius');
    expect(radius.values.map((v: { value: string }) => v.value)).toEqual(['5', '10', '20']);
    expect(radius.values.find((v: { value: string }) => v.value === '10').selected).toBe(true);
  });
});
