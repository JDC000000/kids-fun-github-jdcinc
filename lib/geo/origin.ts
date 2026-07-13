// lib/geo/origin.ts — Origin resolution, 3 modes (G-T18-2, TSD §5B).
//
// (a) Near me → browser geolocation coords; (b) Saved home / postal → geocoded once
// on save; (c) Typed area / area chip → region centroid. Anonymous users get (a)/(c);
// signed-in users additionally get (b). `Geocoder` is the swap seam (fixture now,
// maps/geocoding key later).

import type { GeoPoint } from '../search/types';
import type { RegionHierarchy } from './region';

export type OriginMode = 'near_me' | 'saved_home' | 'area_chip';

/** Postal/address → point. Fixture impl now; maps/geocoding key impl later (BR-06). */
export interface Geocoder {
  geocodePostal(postal: string): GeoPoint | null;
}

export interface OriginRequest {
  mode: OriginMode;
  /** near_me: browser geolocation coordinates. */
  coords?: GeoPoint | null;
  /** saved_home: the user's saved home postal (already geocoded on save, or re-geocoded). */
  homePostal?: string | null;
  /** area_chip: selected region/area id → its centroid. */
  areaChipId?: string | null;
}

export interface ResolveOriginDeps {
  hierarchy: RegionHierarchy;
  geocoder: Geocoder;
  /** Auth state — saved_home requires a signed-in user. */
  signedIn: boolean;
}

export interface ResolvedOrigin {
  geo: GeoPoint;
  mode: OriginMode;
  label: string;
}

export class OriginResolutionError extends Error {
  constructor(
    message: string,
    readonly code: 'auth_required' | 'missing_input' | 'geocode_failed' | 'unknown_area',
  ) {
    super(message);
    this.name = 'OriginResolutionError';
  }
}

/** Resolve a request to an origin point, enforcing the anon vs signed-in mode gate. */
export function resolveOrigin(req: OriginRequest, deps: ResolveOriginDeps): ResolvedOrigin {
  switch (req.mode) {
    case 'near_me': {
      if (!req.coords) throw new OriginResolutionError('near_me requires geolocation coords', 'missing_input');
      return { geo: req.coords, mode: 'near_me', label: 'Near me' };
    }
    case 'area_chip': {
      if (!req.areaChipId) throw new OriginResolutionError('area_chip requires an area id', 'missing_input');
      const centroid = deps.hierarchy.centroid(req.areaChipId);
      if (!centroid) throw new OriginResolutionError(`unknown area: ${req.areaChipId}`, 'unknown_area');
      const region = deps.hierarchy.get(req.areaChipId);
      return { geo: centroid, mode: 'area_chip', label: region?.name ?? 'Area' };
    }
    case 'saved_home': {
      if (!deps.signedIn) throw new OriginResolutionError('saved_home requires sign-in', 'auth_required');
      if (!req.homePostal) throw new OriginResolutionError('saved_home requires a saved postal', 'missing_input');
      const geo = deps.geocoder.geocodePostal(req.homePostal);
      if (!geo) throw new OriginResolutionError(`could not geocode ${req.homePostal}`, 'geocode_failed');
      return { geo, mode: 'saved_home', label: 'Home' };
    }
  }
}
