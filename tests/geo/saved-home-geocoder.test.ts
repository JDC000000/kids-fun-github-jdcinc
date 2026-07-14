import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolvePreciseSavedHomeGeocoder } from '../../lib/geo/saved-home-geocoder';
import { clearGeocodeCache } from '../../lib/geo/geocode';
import { MUNICIPALITY_CENTROID } from '../../lib/geo/postal-fsa';
import type { OriginRequest } from '../../lib/geo/origin';

// Task 36 — bridge from the async Mapbox geocoder to the synchronous search Geocoder.
// Offline: fetch is injected so no live Mapbox calls happen in CI.
describe('resolvePreciseSavedHomeGeocoder (Task 36)', () => {
  const originalKey = process.env.GEOCODING_API_KEY;

  // A Mapbox hit for the Kitsilano postal V6K 2G8 (GeoJSON center = [lng, lat]).
  const mapboxHit = (center: [number, number]) =>
    vi.fn(async () =>
      new Response(JSON.stringify({ features: [{ center }] }), { status: 200 })
    ) as unknown as typeof fetch;

  const savedHome = (postal: string): OriginRequest => ({ mode: 'saved_home', homePostal: postal });

  beforeEach(() => {
    clearGeocodeCache();
    process.env.GEOCODING_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEOCODING_API_KEY;
    else process.env.GEOCODING_API_KEY = originalKey;
  });

  it('resolves a signed-in saved-home postal to the precise Mapbox point', async () => {
    const fetchImpl = mapboxHit([-123.17059, 49.264034]);
    const geocoder = await resolvePreciseSavedHomeGeocoder(savedHome('V6K 2G8'), true, { fetchImpl });
    expect(geocoder).not.toBeNull();
    // [lng, lat] from Mapbox → GeoPoint {lng, lat}.
    expect(geocoder!.geocodePostal('V6K 2G8')).toEqual({ lng: -123.17059, lat: 49.264034 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is meaningfully more precise than the FSA-centroid fallback for the same postal', async () => {
    const fetchImpl = mapboxHit([-123.17059, 49.264034]);
    const geocoder = await resolvePreciseSavedHomeGeocoder(savedHome('V6K 2G8'), true, { fetchImpl });
    const precise = geocoder!.geocodePostal('V6K 2G8')!;
    const fallback = MUNICIPALITY_CENTROID.van; // what the FSA path would have returned
    // The precise Kitsilano point is well away from the Vancouver municipality centroid.
    const dLng = Math.abs(precise.lng - fallback.lng);
    const dLat = Math.abs(precise.lat - fallback.lat);
    expect(dLng).toBeGreaterThan(0.02);
    expect(dLat).toBeGreaterThan(0.01);
  });

  it('falls back (returns null) when the user is not signed in', async () => {
    const fetchImpl = mapboxHit([-123.17059, 49.264034]);
    const geocoder = await resolvePreciseSavedHomeGeocoder(savedHome('V6K 2G8'), false, { fetchImpl });
    expect(geocoder).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // no wasted paid call
  });

  it('returns null for non-saved-home origin modes', async () => {
    const fetchImpl = mapboxHit([-123.17059, 49.264034]);
    const nearMe: OriginRequest = { mode: 'near_me', coords: { lat: 49.26, lng: -123.07 } };
    const areaChip: OriginRequest = { mode: 'area_chip', areaChipId: 'van' };
    expect(await resolvePreciseSavedHomeGeocoder(nearMe, true, { fetchImpl })).toBeNull();
    expect(await resolvePreciseSavedHomeGeocoder(areaChip, true, { fetchImpl })).toBeNull();
    expect(await resolvePreciseSavedHomeGeocoder(null, true, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null for a malformed postal without calling the API', async () => {
    const fetchImpl = mapboxHit([-123.17059, 49.264034]);
    const geocoder = await resolvePreciseSavedHomeGeocoder(savedHome('garbage'), true, { fetchImpl });
    expect(geocoder).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('degrades to null (FSA fallback) when Mapbox returns no match', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ features: [] }), { status: 200 })
    ) as unknown as typeof fetch;
    const geocoder = await resolvePreciseSavedHomeGeocoder(savedHome('V6K 2G8'), true, { fetchImpl });
    expect(geocoder).toBeNull();
  });

  it('degrades to null when Mapbox errors/times out (no throw)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const geocoder = await resolvePreciseSavedHomeGeocoder(savedHome('V6K 2G8'), true, { fetchImpl, timeoutMs: 0 });
    expect(geocoder).toBeNull();
  });
});
