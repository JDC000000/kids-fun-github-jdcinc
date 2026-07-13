import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { geocode, clearGeocodeCache } from '../../lib/geo/geocode';

// G-T4-4 — geocode client wrapper (TSD §5B). No live network calls: fetch is
// injected/mocked so this suite runs offline in CI.
describe('geocode (G-T4-4)', () => {
  const originalKey = process.env.GEOCODING_API_KEY;

  beforeEach(() => {
    clearGeocodeCache();
    process.env.GEOCODING_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env.GEOCODING_API_KEY = originalKey;
  });

  it('returns null (no throw) when GEOCODING_API_KEY is unset', async () => {
    delete process.env.GEOCODING_API_KEY;
    const result = await geocode('V6B 1A1');
    expect(result).toBeNull();
  });

  it('returns null (no throw) when the query is empty', async () => {
    const result = await geocode('   ');
    expect(result).toBeNull();
  });

  it('parses a plausible lat/long from a successful response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ features: [{ center: [-123.1207, 49.2827] }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await geocode('V6B 1A1', { fetchImpl });
    expect(result).toEqual({ lat: 49.2827, long: -123.1207 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caches successful lookups (second call does not re-fetch)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ features: [{ center: [-123.0, 49.0] }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    await geocode('same query', { fetchImpl });
    await geocode('same query', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('degrades to null on a non-OK response (no throw)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const result = await geocode('bad query', { fetchImpl });
    expect(result).toBeNull();
  });

  it('degrades to null when the provider returns no features (no throw)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ features: [] }), { status: 200 })
    ) as unknown as typeof fetch;
    const result = await geocode('nowhere', { fetchImpl });
    expect(result).toBeNull();
  });

  it('degrades to null when fetch throws (no throw propagates)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await geocode('unreachable', { fetchImpl });
    expect(result).toBeNull();
  });
});
