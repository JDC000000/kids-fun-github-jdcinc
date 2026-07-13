// lib/geo/radius.ts — G-T18-1: radius filter + distance for ranking (TSD §5B
// BR-06). ST_DWithin filters venues within radius; ST_Distance feeds the
// distance-decay ranking input (T19).
import { query } from '../db/client';

export interface Origin {
  lat: number;
  long: number;
}

export const DEFAULT_RADIUS_KM = 10;
export const RADIUS_OPTIONS_KM = [5, 10, 20] as const;

export interface VenueWithinRadius {
  id: string;
  name: string;
  distanceMeters: number;
}

export async function venuesWithinRadius(
  origin: Origin,
  radiusKm: number = DEFAULT_RADIUS_KM
): Promise<VenueWithinRadius[]> {
  const radiusMeters = radiusKm * 1000;
  return query<VenueWithinRadius>(
    `SELECT id, name,
            ST_Distance(geo, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS "distanceMeters"
     FROM venue
     WHERE geo IS NOT NULL
       AND ST_DWithin(geo, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY "distanceMeters" ASC`,
    [origin.long, origin.lat, radiusMeters]
  );
}
