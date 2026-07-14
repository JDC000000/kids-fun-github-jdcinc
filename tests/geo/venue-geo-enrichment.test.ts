import { describe, it, expect, vi } from 'vitest';
import { enrichVenueGeo, type EnrichVenueGeoDeps, type VenueGeoRow } from '../../lib/geo/venue-geo-enrichment';
import type { LatLong } from '../../lib/geo/geocode';

// Task 36 — offline unit tests for the venue-geo backfill core (geocoder + DB injected).
describe('enrichVenueGeo (Task 36)', () => {
  const rows: VenueGeoRow[] = [
    { id: 'v1', name: 'Chinatown Storytelling Centre', address: '168 E Pender St, Vancouver, BC V6A 1T3' },
    { id: 'v2', name: 'King George Secondary', address: '1755 Barclay St, Vancouver, BC V6G 1K6' },
    { id: 'v3', name: 'Mystery Hall', address: 'somewhere unresolvable' },
  ];

  function makeDeps(overrides: Partial<EnrichVenueGeoDeps> = {}) {
    const setGeo = vi.fn(async () => {});
    const geocode = vi.fn(async (address: string): Promise<LatLong | null> => {
      if (address.startsWith('168 E Pender')) return { lat: 49.2801, long: -123.0989 };
      if (address.startsWith('1755 Barclay')) return { lat: 49.2907, long: -123.1361 };
      return null; // Mystery Hall doesn't resolve
    });
    const deps: EnrichVenueGeoDeps = {
      listMissing: vi.fn(async (limit: number) => rows.slice(0, limit)),
      setGeo,
      geocode,
      ...overrides,
    };
    return { deps, setGeo, geocode };
  }

  const noSleep = () => Promise.resolve();

  it('geocodes and writes venues with an address but no geo', async () => {
    const { deps, setGeo } = makeDeps();
    const result = await enrichVenueGeo(deps, { limit: 100, sleep: noSleep });
    expect(result.considered).toBe(3);
    expect(result.enriched).toBe(2);
    expect(result.unresolved).toEqual(['Mystery Hall']);
    // setGeo called with (id, lat, lng)
    expect(setGeo).toHaveBeenCalledWith('v1', 49.2801, -123.0989);
    expect(setGeo).toHaveBeenCalledWith('v2', 49.2907, -123.1361);
    expect(setGeo).toHaveBeenCalledTimes(2); // never for the unresolved venue
  });

  it('dry-run previews without writing', async () => {
    const { deps, setGeo, geocode } = makeDeps();
    const result = await enrichVenueGeo(deps, { dryRun: true, sleep: noSleep });
    expect(result.enriched).toBe(2);
    expect(geocode).toHaveBeenCalled();
    expect(setGeo).not.toHaveBeenCalled();
  });

  it('respects the limit (bounds Mapbox call volume)', async () => {
    const { deps, geocode } = makeDeps();
    const result = await enrichVenueGeo(deps, { limit: 1, sleep: noSleep });
    expect(result.considered).toBe(1);
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a geocode lookup misses (leaves venue NULL for retry)', async () => {
    const { deps } = makeDeps({ geocode: vi.fn(async () => null) });
    const result = await enrichVenueGeo(deps, { sleep: noSleep });
    expect(result.enriched).toBe(0);
    expect(result.unresolved).toHaveLength(3);
  });
});
