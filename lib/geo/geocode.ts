// lib/geo/geocode.ts — G-T4-4: geocoding client wrapper (TSD §5B).
// Postal/address -> {lat, long} via Mapbox Geocoding API (GEOCODING_API_KEY,
// vault slug kids-fun-mapbox — see docs/credentials.md). Results are cached
// in-process (per worker/server lifetime); failures degrade gracefully to
// `null` so callers can queue a manual-geocode follow-up instead of throwing
// (TSD §5B: "venue shown without distance until resolved").

export interface LatLong {
  lat: number;
  long: number;
}

const cache = new Map<string, LatLong | null>();

function cacheKey(query: string, region: string): string {
  return `${region.toLowerCase()}::${query.trim().toLowerCase()}`;
}

export interface GeocodeOptions {
  /** Biases/country-scopes the search. Defaults to Canada / BC-ish region. */
  region?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Geocode a free-text query (postal code or address) to lat/long.
 * Never throws on a failed lookup — returns null so the caller can queue the
 * venue for manual geocode instead of failing the whole ingest/request.
 */
export async function geocode(query: string, opts: GeocodeOptions = {}): Promise<LatLong | null> {
  const region = opts.region ?? 'CA';
  const key = cacheKey(query, region);
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  const result = await geocodeUncached(query, region, opts.fetchImpl ?? fetch);
  cache.set(key, result);
  return result;
}

async function geocodeUncached(
  query: string,
  region: string,
  fetchImpl: typeof fetch
): Promise<LatLong | null> {
  const apiKey = process.env.GEOCODING_API_KEY;
  if (!apiKey || !query.trim()) {
    return null;
  }

  try {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json`
    );
    url.searchParams.set('access_token', apiKey);
    url.searchParams.set('country', region);
    url.searchParams.set('limit', '1');

    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      features?: Array<{ center?: [number, number] }>;
    };
    const center = body.features?.[0]?.center;
    if (!center || center.length !== 2) {
      return null;
    }
    const [long, lat] = center;
    if (!isFinite(lat) || !isFinite(long)) {
      return null;
    }
    return { lat, long };
  } catch {
    // Network/parse failure: degrade gracefully, never throw.
    return null;
  }
}

/** Test/ops helper — clears the in-process cache. */
export function clearGeocodeCache(): void {
  cache.clear();
}
