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
      expect.arrayContaining(['when', 'timeOfDay', 'ages', 'areas', 'quick', 'category'])
    );
    // No 'costMax': the Max price group went with the price ceiling (Jon, 2026-08-11).
    expect(body.facets.groups.map((g: { key: string }) => g.key)).not.toContain('costMax');
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

describe('GET /api/search — Stage 2a typed structured params (roadmap initiative 2, first half)', () => {
  // End-to-end URL → buildSearchRequest → SearchRequest → engine override → passesAllFilters,
  // over real HTTP querystrings (not the engine directly, unlike tests/search/engine.test.ts's
  // Stage 2a suite) — proves the route wiring itself, not just the engine logic it calls.
  it('age= overrides a conflicting/absent age with no age phrase in q', async () => {
    const { body } = await call('q=open+gym&age=under2&minResults=0');
    const ids = body.results.map((r: { listing: { id: string } }) => r.listing.id);
    expect(ids).toContain('l-familydropin-bby'); // under2/2-4
    expect(ids).not.toContain('l-rank-confirmed'); // 5-9 only
  });

  it('when= overrides a conflicting text date phrase', async () => {
    // The route has no `now` override (unlike the engine test suite's FIXTURE_NOW), so this
    // checks the resolved DateIntent kind against the real clock rather than fixture listing
    // ids tied to a fixed July 2026 "now" — tests/search/engine.test.ts's Stage 2a suite
    // already proves the listing-level filtering effect deterministically.
    const textOnly = await call('q=open+gym+tomorrow&minResults=0');
    expect(textOnly.body.context.date.kind).toBe('tomorrow');
    const { body } = await call('q=open+gym+tomorrow&when=today&minResults=0');
    expect(body.context.date.kind).toBe('today');
  });

  it('time= overrides a conflicting text day-part', async () => {
    const { body } = await call('q=open+gym+morning&time=afternoon&minResults=0');
    const ids = body.results.map((r: { listing: { id: string } }) => r.listing.id);
    expect(ids).toContain('l-gymplay-nvan'); // 14:00 local
    expect(ids).not.toContain('l-opengym-van'); // 10:00 local
  });

  it('bookable=1/0 overrides in both directions', async () => {
    const forcedOn = await call('q=open+gym&bookable=1&minResults=0');
    expect(forcedOn.body.results.map((r: { listing: { id: string } }) => r.listing.id)).not.toContain('l-opengym-stale');
    const forcedOff = await call('q=open+gym+bookable+now&bookable=0&minResults=0');
    expect(forcedOff.body.results.map((r: { listing: { id: string } }) => r.listing.id)).toContain('l-opengym-stale');
  });

  it('rainy=1 excludes an outdoor listing a bare query never restricted', async () => {
    const { body } = await call('q=train&rainy=1&minResults=0');
    expect(body.results.map((r: { listing: { id: string } }) => r.listing.id)).not.toContain('l-minitrain-van');
  });

  it('dropin=1 narrows results a bare query never restricted', async () => {
    const { body } = await call('q=open+gym&dropin=1&minResults=0');
    const ids = body.results.map((r: { listing: { id: string } }) => r.listing.id);
    expect(ids).not.toContain('l-rank-confirmed');
    expect(ids).toContain('l-opengym-van');
  });

  it('free=1/0 overrides in both directions', async () => {
    const forcedOn = await call('q=open+gym&free=1&minResults=0');
    expect(forcedOn.body.results.map((r: { listing: { id: string } }) => r.listing.id)).not.toContain('l-gymplay-nvan');
    const forcedOff = await call('q=open+gym+free&free=0&minResults=0');
    expect(forcedOff.body.results.map((r: { listing: { id: string } }) => r.listing.id)).toContain('l-gymplay-nvan');
  });

  it('radius= overrides a conflicting text radius phrase', async () => {
    const { body } = await call('q=skate+within+5km&lat=49.26&lng=-123.07&radius=20&minResults=0');
    expect(body.context.radiusKm).toBe(20);
    expect(body.results.map((r: { listing: { id: string } }) => r.listing.id)).toContain('l-skate-rmd');
  });

  it('sending none of the new params leaves plain-text search unaffected (fallback path)', async () => {
    const { body } = await call('q=open+gym+kids&minResults=1');
    expect(body.context.ageBands).toEqual(['5-9']);
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('malformed/unrecognised values for the new params degrade to no override, never a 5xx', async () => {
    const { res, body } = await call(
      'q=open+gym&when=nonsense&time=nonsense&age=not-a-real-band&bookable=maybe&rainy=maybe&dropin=maybe&free=maybe&radius=not-a-number&minResults=1',
    );
    expect(res.status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
  });
});

describe('GET /api/search — the /search page URL is a first-class caller (report P1-5)', () => {
  // Every param the page URL carries is spelled the same on both sides, so a parent's own URL —
  // shared, saved, or pasted into curl — means here exactly what it means there. The two defects
  // below were found by probing the API with the UI's own links; the broad, table-driven version
  // of this lives in invariants/filter-params.test.ts, and these are the blocking-lane pins for
  // the specific fixes.

  it('reads `reg=1`, the page URL spelling of the registration opt-in', async () => {
    // Was dead: the route read only `includeRegistration`, so a URL that plainly said reg=1 got
    // a drop-in-only answer with no error and no notice.
    const viaPage = await call('q=open+gym&reg=1&minResults=0');
    const viaApi = await call('q=open+gym&includeRegistration=1&minResults=0');
    const off = await call('q=open+gym&minResults=0');
    expect(viaPage.body.context.includeRegistration).toBe(true);
    expect(viaApi.body.context.includeRegistration).toBe(true);
    expect(off.body.context.includeRegistration).toBe(false);
  });

  it('lets this API\'s own param name win when both spellings are present', async () => {
    const { body } = await call('q=open+gym&includeRegistration=0&reg=1&minResults=0');
    expect(body.context.includeRegistration).toBe(false);
  });

  it('keeps every value of a repeated region= param (was: all but the first were dropped)', async () => {
    const van = await call('region=van&minResults=0');
    const bby = await call('region=bby&minResults=0');
    const ids = (body: { results: Array<{ listing: { id: string } }>; expected: Array<{ listing: { id: string } }> }) =>
      [...body.results, ...body.expected].map((r) => r.listing.id);
    const union = [...new Set([...ids(van.body), ...ids(bby.body)])].sort();
    for (const spelling of ['region=van,bby', 'region=van&region=bby']) {
      const { body } = await call(`${spelling}&minResults=0`);
      expect(ids(body).sort(), `${spelling} dropped chips`).toEqual(union);
    }
    // Non-vacuous only if the two municipalities really do hold different listings.
    expect(ids(bby.body).length).toBeGreaterThan(0);
    expect(union.length).toBeGreaterThan(ids(van.body).length);
  });

  it('keeps every value of a repeated age= param', async () => {
    const csv = await call('age=5-9,10-14&minResults=0');
    const repeated = await call('age=5-9&age=10-14&minResults=0');
    expect(csv.body.context.ageBands).toEqual(['5-9', '10-14']);
    expect(repeated.body.context.ageBands).toEqual(['5-9', '10-14']);
  });
});
