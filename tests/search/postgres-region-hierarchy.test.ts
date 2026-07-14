// tests/search/postgres-region-hierarchy.test.ts — DB-backed region hierarchy.
//
// Pure unit tests with a stubbed Pool (no live DB): row→Region mapping, centroid
// projection, drop-in parity with the fixture RegionHierarchy behaviour (descendant
// resolution / BR-08 sub-area inclusion), and the TTL cache.

import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { matchesRegion } from '../../lib/geo/region';
import {
  loadRegions,
  loadPostgresRegionHierarchy,
  getPostgresRegionHierarchy,
  clearPostgresRegionHierarchyCache,
} from '../../lib/search/postgres-region-hierarchy';

function stubPool(rows: unknown[]): { pool: Pool; calls: () => number } {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls: () => calls };
}

// Mirrors the seeded region table (supabase/seeds/regions.sql) as loadRegions'
// SELECT returns it (id/parent_id as text, centroid projected to lat/lng).
const VAN = '10000000-0000-0000-0000-000000000010';
const EAST_VAN = '10000000-0000-0000-0000-000000000020';
const WEST_SIDE = '10000000-0000-0000-0000-000000000021';
const RICHMOND = '10000000-0000-0000-0000-000000000014';
const METRO = '10000000-0000-0000-0000-000000000001';

const DB_ROWS = [
  { id: METRO, name: 'Metro Vancouver', level: 'metro', parent_id: null, lat: 49.261, lng: -123.0946 },
  { id: VAN, name: 'Vancouver', level: 'municipality', parent_id: METRO, lat: 49.2827, lng: -123.1207 },
  { id: RICHMOND, name: 'Richmond', level: 'municipality', parent_id: METRO, lat: 49.1666, lng: -123.1336 },
  { id: EAST_VAN, name: 'East Van', level: 'sub_area', parent_id: VAN, lat: 49.262, lng: -123.071 },
  { id: WEST_SIDE, name: 'West Side', level: 'sub_area', parent_id: VAN, lat: 49.253, lng: -123.165 },
];

afterEach(() => {
  clearPostgresRegionHierarchyCache();
  delete process.env.KIDS_FUN_REGION_CACHE_MS;
});

describe('loadRegions', () => {
  it('maps region rows into Region with numeric centroids', async () => {
    const { pool } = stubPool([DB_ROWS[1]]);
    const regions = await loadRegions(pool);
    expect(regions).toEqual([
      {
        id: VAN,
        name: 'Vancouver',
        level: 'municipality',
        parentId: METRO,
        centroid: { lat: 49.2827, lng: -123.1207 },
      },
    ]);
  });

  it('falls back to a {0,0} centroid when a region row has no centroid', async () => {
    const { pool } = stubPool([
      { id: VAN, name: 'Vancouver', level: 'municipality', parent_id: METRO, lat: null, lng: null },
    ]);
    const [region] = await loadRegions(pool);
    expect(region.centroid).toEqual({ lat: 0, lng: 0 });
  });
});

describe('loadPostgresRegionHierarchy (BR-08 sub-area inclusion)', () => {
  it('resolves a Vancouver chip to itself + its seeded sub-areas', async () => {
    const { pool } = stubPool(DB_ROWS);
    const hierarchy = await loadPostgresRegionHierarchy(pool);
    const resolved = hierarchy.resolveSelectedIds([VAN]);
    expect(resolved).toEqual(new Set([VAN, EAST_VAN, WEST_SIDE]));
  });

  it('matches a sub-area-tagged listing when its parent municipality chip is selected', async () => {
    const { pool } = stubPool(DB_ROWS);
    const hierarchy = await loadPostgresRegionHierarchy(pool);
    // Listing tagged only to the East Van sub-area is included by a Vancouver chip…
    expect(matchesRegion([EAST_VAN], hierarchy, [VAN])).toBe(true);
    // …but not by a Richmond chip.
    expect(matchesRegion([EAST_VAN], hierarchy, [RICHMOND])).toBe(false);
  });

  it('exposes centroids for area-chip origin resolution', async () => {
    const { pool } = stubPool(DB_ROWS);
    const hierarchy = await loadPostgresRegionHierarchy(pool);
    expect(hierarchy.centroid(VAN)).toEqual({ lat: 49.2827, lng: -123.1207 });
  });
});

describe('getPostgresRegionHierarchy TTL cache', () => {
  it('reuses the cached hierarchy within the TTL window and reloads after it', async () => {
    process.env.KIDS_FUN_REGION_CACHE_MS = '1000';
    const { pool, calls } = stubPool(DB_ROWS);
    await getPostgresRegionHierarchy(pool, 0);
    await getPostgresRegionHierarchy(pool, 500);
    expect(calls()).toBe(1);
    await getPostgresRegionHierarchy(pool, 1500);
    expect(calls()).toBe(2);
  });
});
