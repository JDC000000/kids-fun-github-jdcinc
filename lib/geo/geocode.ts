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

/** Default request-time budget. A slow Mapbox response aborts and degrades to null. */
const DEFAULT_TIMEOUT_MS = 3000;

export interface GeocodeOptions {
  /** Biases/country-scopes the search. Defaults to Canada / BC-ish region. */
  region?: string;
  fetchImpl?: typeof fetch;
  /**
   * Abort the lookup after this many ms and return null (so a live request path
   * degrades to its fallback instead of hanging on a slow provider). Default 3000.
   * Pass 0 to disable the timeout.
   */
  timeoutMs?: number;
}

/**
 * Geocode a free-text query (postal code or address) to lat/long.
 * Never throws on a failed lookup — returns null so the caller can queue the
 * venue for manual geocode (ingest) or degrade to an approximate origin (request).
 */
export async function geocode(query: string, opts: GeocodeOptions = {}): Promise<LatLong | null> {
  const region = opts.region ?? 'CA';
  const key = cacheKey(query, region);
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  const result = await geocodeUncached(
    query,
    region,
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  // Cache successes only — a transient failure/timeout must be able to recover on
  // the next call rather than being pinned to the fallback for the process lifetime.
  if (result) cache.set(key, result);
  return result;
}

async function geocodeUncached(
  query: string,
  region: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<LatLong | null> {
  const apiKey = process.env.GEOCODING_API_KEY;
  if (!apiKey || !query.trim()) {
    return null;
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json`
    );
    url.searchParams.set('access_token', apiKey);
    url.searchParams.set('country', region);
    url.searchParams.set('limit', '1');

    const res = await fetchImpl(url.toString(), { signal: controller.signal });
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
    // Network/parse/timeout (AbortError) failure: degrade gracefully, never throw.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test/ops helper — clears the in-process cache. */
export function clearGeocodeCache(): void {
  cache.clear();
}
