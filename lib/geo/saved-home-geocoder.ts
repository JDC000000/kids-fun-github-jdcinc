// lib/geo/saved-home-geocoder.ts — Task 36: bridge the ASYNC Mapbox geocoder
// (lib/geo/geocode.ts) into the SYNCHRONOUS search `Geocoder` seam (lib/geo/origin.ts).
//
// The search engine + resolveOrigin are synchronous, but real geocoding is a network
// call. So for a signed-in "saved home" search we PRE-RESOLVE the saved postal to a
// precise Mapbox point once at the async route boundary, then hand the engine a plain
// synchronous Geocoder that returns that point. When Mapbox is unavailable — no key,
// timeout, rate-limit, network error, or no match — we return `null` and the caller
// keeps using the Task-29 FSA-centroid resolver (lib/geo/postal-fsa.ts) as the
// fallback-of-last-resort. Mapbox is the precise path; the FSA centroid is graceful
// degradation, never removed.

import { geocode } from './geocode';
import { fsaGeocoder, fsaOf } from './postal-fsa';
import type { Geocoder, OriginRequest } from './origin';
import type { GeoPoint } from '../search/types';

/** Country scope for Canadian postal/address geocoding (Mapbox `country` param). */
const REGION = 'CA';
/** Request-time budget for the live lookup; over-budget → FSA fallback (never blocks search). */
const REQUEST_TIMEOUT_MS = 2500;

export interface PreciseGeocoderOptions {
  /** Injected in tests so the suite runs offline; real `fetch` in production. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normalizePostal(postal: string): string {
  return postal.replace(/\s+/g, '').toUpperCase();
}

/**
 * If this is a signed-in `saved_home` request AND Mapbox resolves the saved postal to
 * a precise point, return a synchronous `Geocoder` yielding that point (with the FSA
 * centroid as the fallback for any other postal seen in the same request). Otherwise
 * return `null` — the caller then uses its default `fsaGeocoder`.
 *
 * A precise geocoder is built ONLY when we genuinely have a better point than the
 * Task-29 FSA centroid, so the search path spends at most one Mapbox call per request
 * (and `geocode()` caches per postal). Every other case — near_me / area_chip, not
 * signed in, malformed postal, or Mapbox down/timeout/miss — returns `null` and search
 * degrades gracefully to the FSA-centroid origin. As a bonus, Mapbox resolves valid
 * postals OUTSIDE the five FSA-covered municipalities that the fallback returns `null`
 * for, extending precise saved-home coverage.
 */
export async function resolvePreciseSavedHomeGeocoder(
  origin: OriginRequest | null | undefined,
  signedIn: boolean,
  opts: PreciseGeocoderOptions = {}
): Promise<Geocoder | null> {
  if (!signedIn) return null;
  if (!origin || origin.mode !== 'saved_home' || !origin.homePostal) return null;

  const postal = origin.homePostal;
  // Cheap sanity gate: only well-formed Canadian postals reach the paid API.
  if (!fsaOf(postal)) return null;

  const hit = await geocode(postal, {
    region: REGION,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
  });
  if (!hit) return null; // Mapbox unavailable / no match → caller keeps the FSA fallback.

  const precise: GeoPoint = { lng: hit.long, lat: hit.lat };
  const wantKey = normalizePostal(postal);

  return {
    geocodePostal(input: string): GeoPoint | null {
      // The precise point only applies to the postal we pre-resolved; any other postal
      // in the same request (not expected in practice) degrades to the FSA centroid.
      if (normalizePostal(input) === wantKey) return precise;
      return fsaGeocoder.geocodePostal(input);
    },
  };
}
