// Marker extraction for the /search map view (Task 37).
//
// The parent-facing Activity DTO (app/preview/_data/types.ts) deliberately DROPS the
// raw lat/lng — the card UI never needed a coordinate. The map view does. Rather than
// widen the shared Activity type (owned by /preview), we read geo straight off the raw
// /api/search items in the server component and re-attach it by id, so the marker set is
// exactly the rendered result set (same ids, same confirmed/expected split) — no second
// fetch, no divergence between what the list shows and what the map plots.

import type { Activity } from '../../preview/_data/types';
import type { SearchItemDto } from '../../preview/_data/search-api';

/** One plottable result. `[lng, lat]` matches Mapbox/GeoJSON order at the call site. */
export interface SearchMarker {
  id: string;
  lng: number;
  lat: number;
  name: string;
  venue: string;
  area: string;
  category: string;
  /**
   * Which rendered section this pin came from — never blurred, on the map any more than in the
   * list. `age_unconfirmed` is the age-not-stated section (lib/search/engine.ts): a primary
   * result whose age the source never gave, which is a different caveat from `expected`
   * (we don't know if it's happening) and must not be drawn as if it were the same one.
   */
  section: 'confirmed' | 'expected' | 'age_unconfirmed';
}

/**
 * Build an `id -> {lng,lat}` index from the raw search items. Un-geocoded listings
 * (geo === null) and malformed points are skipped; the first coordinate seen for an id
 * wins (results + expected can overlap on id and are de-duped upstream the same way).
 */
export function geoIndex(items: SearchItemDto[]): Map<string, { lng: number; lat: number }> {
  const idx = new Map<string, { lng: number; lat: number }>();
  for (const item of items) {
    const g = item.listing.geo;
    if (
      g &&
      typeof g.lng === 'number' &&
      typeof g.lat === 'number' &&
      Number.isFinite(g.lng) &&
      Number.isFinite(g.lat) &&
      !idx.has(item.listing.id)
    ) {
      idx.set(item.listing.id, { lng: g.lng, lat: g.lat });
    }
  }
  return idx;
}

/**
 * Project the already-partitioned activities onto markers, keeping only those with a
 * resolved coordinate. Order and section follow the rendered list, so a parent scanning
 * the map sees exactly the confirmed/expected cards they'd see in the list.
 */
export function buildMarkers(
  confirmed: Activity[],
  expected: Activity[],
  geo: Map<string, { lng: number; lat: number }>,
  /**
   * The age-not-stated section. Defaults to empty so the existing two-section callers are
   * unchanged — but the /search page passes it, because a listing that is reachable in the list
   * and absent from the map is exactly the "N of M mapped" arithmetic going quietly wrong.
   */
  ageUnconfirmed: Activity[] = []
): SearchMarker[] {
  const out: SearchMarker[] = [];
  const push = (a: Activity, section: SearchMarker['section']) => {
    const point = geo.get(a.id);
    if (!point) return;
    out.push({
      id: a.id,
      lng: point.lng,
      lat: point.lat,
      name: a.activityName,
      venue: a.venue,
      area: a.area,
      category: a.category,
      section,
    });
  };
  confirmed.forEach((a) => push(a, 'confirmed'));
  ageUnconfirmed.forEach((a) => push(a, 'age_unconfirmed'));
  expected.forEach((a) => push(a, 'expected'));
  return out;
}
