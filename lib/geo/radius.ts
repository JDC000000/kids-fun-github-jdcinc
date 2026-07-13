// lib/geo/radius.ts — Radius filter + distance for ranking (G-T18-1, BR-06, TSD §5B).
//
// Fixture stand-in for PostGIS: haversine `distanceKm` mirrors `ST_Distance` and
// `withinRadius` mirrors `ST_DWithin(venue.geo, origin, radius)`. Default radius
// 10km; quick options 5/10/20km. Distance feeds distance-decay in ranking (§5A.3).
// Un-geocoded venues (geo=null) return null distance and are excluded from a radius
// filter but may still be shown "without distance" by the caller.

import type { GeoPoint } from '../search/types';

export const DEFAULT_RADIUS_KM = 10;
export const RADIUS_OPTIONS_KM = [5, 10, 20] as const;
const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in km between two WGS84 points (haversine ≈ ST_Distance). */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from origin to a possibly-un-geocoded venue; null when venue has no geo. */
export function distanceFromOrigin(origin: GeoPoint, venueGeo: GeoPoint | null): number | null {
  if (!venueGeo) return null;
  return distanceKm(origin, venueGeo);
}

/** ST_DWithin equivalent: is the venue within `radiusKm` of origin? Un-geocoded → false. */
export function withinRadius(origin: GeoPoint, venueGeo: GeoPoint | null, radiusKm: number): boolean {
  const d = distanceFromOrigin(origin, venueGeo);
  return d != null && d <= radiusKm;
}

/**
 * Distance-decay factor in (0,1] for ranking input: 1 at the origin, decaying to
 * ~0 at the radius edge. Linear decay clamped at 0; null distance → 0 (no boost).
 */
export function distanceDecay(distance: number | null, radiusKm: number): number {
  if (distance == null) return 0;
  if (radiusKm <= 0) return 0;
  return Math.max(0, 1 - distance / radiusKm);
}
