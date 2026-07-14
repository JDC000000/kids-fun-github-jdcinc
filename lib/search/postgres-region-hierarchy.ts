// lib/search/postgres-region-hierarchy.ts — DB-backed region hierarchy source
// (retires the fixture seam in live search; TSD §5B, BR-07/08, G-T18-3).
//
// `RegionHierarchy` (lib/geo/region.ts) drives multi-select, additive area chips:
// selecting a municipality includes its sub-areas (BR-08). It was built from the
// hardcoded `REGIONS` fixture even in database mode; this module reads the real
// `region` table instead so chip ids, the parent→child tree, and centroids match
// the same UUIDs that live `venue.municipality_id` rows are tagged with — making
// DB-mode region chips resolve against real listings.
//
// `RegionHierarchy`'s constructor already takes a `Region[]`, so the "source" here
// is just an async loader that maps DB rows into that shape — a drop-in replacement
// for `new RegionHierarchy(REGIONS)`. Same short in-process TTL cache rationale as
// the alias resolver (rows are tiny and rarely change on a warm serverless instance).

import type { Pool } from 'pg';
import { RegionHierarchy, type Region, type RegionLevel } from '../geo/region';

interface RegionRow {
  id: string;
  name: string;
  level: string;
  parent_id: string | null;
  lat: number | string | null;
  lng: number | string | null;
}

const REGION_LEVELS: RegionLevel[] = ['metro', 'municipality', 'sub_area'];

/**
 * Load region rows from the live `region` table. Centroids are stored as
 * geography(Point,4326); we project to lat/lng the same way the listing repository
 * does for venues (`ST_Y/ST_X(geo::geometry)`).
 */
export async function loadRegions(pool: Pool): Promise<Region[]> {
  const { rows } = await pool.query<RegionRow>(
    `SELECT id::text AS id,
            name,
            level,
            parent_id::text AS parent_id,
            CASE WHEN centroid IS NULL THEN NULL ELSE ST_Y(centroid::geometry) END AS lat,
            CASE WHEN centroid IS NULL THEN NULL ELSE ST_X(centroid::geometry) END AS lng
       FROM region`
  );
  return rows.map(rowToRegion);
}

function rowToRegion(row: RegionRow): Region {
  const lat = row.lat == null ? null : Number(row.lat);
  const lng = row.lng == null ? null : Number(row.lng);
  return {
    id: row.id,
    name: row.name,
    level: isRegionLevel(row.level) ? row.level : 'municipality',
    parentId: row.parent_id,
    // Seeded regions always carry a centroid; the {0,0} fallback only guards a
    // region row missing its centroid, which would merely disable area-chip origin
    // resolution for that one region (chip hierarchy/filtering never uses centroid).
    centroid: lat != null && lng != null ? { lat, lng } : { lat: 0, lng: 0 },
  };
}

function isRegionLevel(value: string): value is RegionLevel {
  return (REGION_LEVELS as string[]).includes(value);
}

/** Build a `RegionHierarchy` from the live `region` table — drop-in for `new RegionHierarchy(REGIONS)`. */
export async function loadPostgresRegionHierarchy(pool: Pool): Promise<RegionHierarchy> {
  return new RegionHierarchy(await loadRegions(pool));
}

// ── Short in-process TTL cache for the serverless search route ────────────────
interface CacheEntry {
  hierarchy: RegionHierarchy;
  loadedAt: number;
}
let cache: CacheEntry | null = null;

function cacheTtlMs(): number {
  const raw = Number(process.env.KIDS_FUN_REGION_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/** Cached accessor for the search route; refreshes from the DB at most once per TTL. */
export async function getPostgresRegionHierarchy(
  pool: Pool,
  now: number = Date.now()
): Promise<RegionHierarchy> {
  const ttl = cacheTtlMs();
  if (cache && ttl > 0 && now - cache.loadedAt < ttl) return cache.hierarchy;
  const hierarchy = await loadPostgresRegionHierarchy(pool);
  cache = { hierarchy, loadedAt: now };
  return hierarchy;
}

/** Test/ops hook: drop the cached hierarchy so the next access reloads from the DB. */
export function clearPostgresRegionHierarchyCache(): void {
  cache = null;
}
