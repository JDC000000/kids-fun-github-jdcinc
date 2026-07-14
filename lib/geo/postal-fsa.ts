// lib/geo/postal-fsa.ts — Static Metro-Vancouver FSA → area-centroid origin (Task 29).
//
// WHY THIS EXISTS (and what it is NOT):
//   The full postal→street-point geocoder (lib/geo/geocode.ts, Mapbox) is code-complete
//   but has NO live key — the `kids-fun-mapbox` vault slug is an empty placeholder, so it
//   cannot resolve a real address. Rather than fake a precise point or block the whole
//   saved-home origin feature, this module resolves a saved postal code to an APPROXIMATE,
//   AREA-LEVEL origin using its Forward Sortation Area (FSA — the first three chars of a
//   Canadian postal code, a real, stable geographic unit).
//
//   It does NOT invent coordinates: each covered FSA maps to a Metro-Vancouver municipality,
//   and the origin is that municipality's real WGS84 centroid (the same points seeded into
//   the `region` table, supabase/seeds/regions.sql). So "Near my saved location" runs an
//   area-level search around the user's saved municipality. Honest and coarse, never
//   presented as precise. FSAs outside the five covered municipalities, or malformed input,
//   resolve to `null` and degrade gracefully (search runs with no radius origin — TSD §5B
//   "shown without distance"), never a wrong or fabricated point.
//
//   Self-contained by design: it maps FSA → point directly, WITHOUT going through the region
//   hierarchy, because region ids differ by backend (slug ids in the fixture hierarchy vs.
//   UUIDs in the live `region` table). Depending on the hierarchy's ids would silently break
//   saved-home in database mode. When a live Mapbox key lands, swap this `Geocoder` for the
//   geocode.ts-backed one at the call site (app/api/search/route.ts) for street precision —
//   the seam is unchanged.

import type { GeoPoint } from '../search/types';
import type { Geocoder } from './origin';

/** The five covered Metro-Vancouver municipalities (region-chip slug ids; UI/analytics use). */
export type CoveredRegionId = 'van' | 'nvan' | 'wvan' | 'bby' | 'rmd';

/**
 * Real WGS84 municipality centroids — copied from supabase/seeds/regions.sql so the
 * saved-home origin lands on the same point live search ranks against, independent of how a
 * given backend keys its region rows. Approximate, municipality-level (not a street point).
 */
export const MUNICIPALITY_CENTROID: Readonly<Record<CoveredRegionId, GeoPoint>> = {
  van: { lng: -123.1207, lat: 49.2827 },
  nvan: { lng: -123.0693, lat: 49.3163 },
  wvan: { lng: -123.1591, lat: 49.3286 },
  bby: { lng: -122.9805, lat: 49.2488 },
  rmd: { lng: -123.1336, lat: 49.1666 },
};

/**
 * Approximate FSA-prefix → covered municipality. Mapping is at MUNICIPALITY granularity:
 * boundary FSAs are assigned to their dominant municipality, and FSAs outside the five
 * covered municipalities (New West, Coquitlam, Surrey, …) are intentionally absent so they
 * resolve to `null` (no fake origin) rather than a wrong one. Slug ids mirror REGION_CHIPS.
 */
export const FSA_REGION: Readonly<Record<string, CoveredRegionId>> = {
  // Vancouver (city proper) — East/South V5*, Downtown/West Side/UBC V6*.
  V5K: 'van', V5L: 'van', V5M: 'van', V5N: 'van', V5P: 'van', V5R: 'van', V5S: 'van',
  V5T: 'van', V5V: 'van', V5W: 'van', V5X: 'van', V5Y: 'van', V5Z: 'van',
  V6A: 'van', V6B: 'van', V6C: 'van', V6E: 'van', V6G: 'van', V6H: 'van', V6J: 'van',
  V6K: 'van', V6L: 'van', V6M: 'van', V6N: 'van', V6P: 'van', V6R: 'van', V6S: 'van',
  V6T: 'van', V6Z: 'van',
  // Burnaby.
  V5A: 'bby', V5B: 'bby', V5C: 'bby', V5E: 'bby', V5G: 'bby', V5H: 'bby', V5J: 'bby',
  // Richmond (incl. Steveston / east Richmond V7A–V7E).
  V6V: 'rmd', V6W: 'rmd', V6X: 'rmd', V6Y: 'rmd',
  V7A: 'rmd', V7B: 'rmd', V7C: 'rmd', V7E: 'rmd',
  // North Vancouver (City + District).
  V7G: 'nvan', V7H: 'nvan', V7J: 'nvan', V7K: 'nvan', V7L: 'nvan', V7M: 'nvan',
  V7N: 'nvan', V7P: 'nvan', V7R: 'nvan',
  // West Vancouver.
  V7S: 'wvan', V7T: 'wvan', V7V: 'wvan', V7W: 'wvan',
};

/** Display labels for the covered municipalities (UI chip text; mirrors REGION_CHIPS). */
export const REGION_LABEL: Readonly<Record<CoveredRegionId, string>> = {
  van: 'Vancouver',
  nvan: 'North Vancouver',
  wvan: 'West Vancouver',
  bby: 'Burnaby',
  rmd: 'Richmond',
};

/**
 * Extract the normalized 3-char FSA from a postal code (or partial). Accepts any casing /
 * spacing ("v6k 1a1", "V6K1A1", "V6K"). Returns null if the leading three chars are not a
 * well-formed FSA (letter-digit-letter).
 */
export function fsaOf(postal: string | null | undefined): string | null {
  if (!postal) return null;
  const fsa = postal.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  return /^[A-Z]\d[A-Z]$/.test(fsa) ? fsa : null;
}

/** Saved postal → covered municipality slug id, or null if unknown / out of coverage. */
export function regionIdForPostal(postal: string | null | undefined): CoveredRegionId | null {
  const fsa = fsaOf(postal);
  return fsa ? FSA_REGION[fsa] ?? null : null;
}

/** Human label for a saved postal's area ("North Vancouver"), or null if not resolvable. */
export function areaLabelForPostal(postal: string | null | undefined): string | null {
  const id = regionIdForPostal(postal);
  return id ? REGION_LABEL[id] : null;
}

/**
 * A `Geocoder` (saved-home origin resolver) backed by the static FSA table above: postal →
 * FSA → covered municipality → that municipality's centroid. Never throws; returns null for
 * an unknown / out-of-coverage FSA, so `resolveOrigin` degrades to no-origin instead of
 * failing the search. Self-contained (no region hierarchy), so it behaves identically in
 * fixture-default and live-database search modes.
 */
export const fsaGeocoder: Geocoder = {
  geocodePostal(postal: string): GeoPoint | null {
    const id = regionIdForPostal(postal);
    return id ? MUNICIPALITY_CENTROID[id] : null;
  },
};
