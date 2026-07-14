// app/api/search/route.ts — Search API route (G-T16-7, TSD §5A, FR-02).
//
// Default remains fixture-backed while live coverage is narrow. Staging can opt
// into the DB read model with KIDS_FUN_SEARCH_BACKEND=database; when it does, the
// WHOLE pipeline is live — DB listings AND the DB alias dictionary (synonym_alias,
// via PostgresAliasResolver) AND the DB region hierarchy (region table). No fixture
// resolver leaks into database mode. If DB search is empty or unavailable, the route
// falls back to fixtures and marks the response header/meta so the product shell
// never goes blank during staged rollout. Fixture/default mode is unchanged.

import { NextResponse } from 'next/server';
import { makeFixtureEngine } from '@/lib/search/__fixtures__/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { loadPostgresListings } from '@/lib/search/postgres-repository';
import { getPostgresAliasResolver } from '@/lib/search/postgres-alias-resolver';
import { getPostgresRegionHierarchy } from '@/lib/search/postgres-region-hierarchy';
import { SearchEngine, type SearchRequest, type SearchResponse } from '@/lib/search/engine';
import { getPool } from '@/lib/db/client';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import type { OriginRequest } from '@/lib/geo/origin';
import type { SortKey } from '@/lib/search/types';

export const dynamic = 'force-dynamic';

const VALID_SORTS: SortKey[] = ['best_match', 'distance', 'soonest', 'lowest_cost', 'newest'];
const fixtureBundle = makeFixtureEngine();

/** GET /api/search?q=open+gym&lat=..&lng=..&sort=..&region=van,bby&includeUnknownCost=1&limit=20 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const searchRequest = buildSearchRequest(url.searchParams);

  if (process.env.KIDS_FUN_SEARCH_BACKEND === 'database') {
    const dbResult = await searchDatabase(searchRequest);
    if (dbResult.ok) return json(dbResult.response, dbResult.header);
  }

  const response = searchFixtures(searchRequest);
  return json(response, 'fixture');
}

async function searchDatabase(
  searchRequest: SearchRequest
): Promise<{ ok: true; response: SearchResponse; header: string } | { ok: false }> {
  try {
    const pool = getPool();
    // Retire the fixture seam in database mode: the ENTIRE pipeline reads live DB —
    // listings AND the alias dictionary (synonym_alias) AND the region hierarchy
    // (region). All three load in parallel; any failure drops to the fixture fallback
    // below so the staging shell never goes blank during staged rollout.
    const [listings, aliasResolver, regionHierarchy] = await Promise.all([
      loadPostgresListings(pool),
      getPostgresAliasResolver(pool),
      getPostgresRegionHierarchy(pool),
    ]);
    if (listings.length === 0) {
      const fallback = searchFixtures(searchRequest);
      fallback.meta.fallbackReason = 'database has no indexed listings yet';
      return { ok: true, response: fallback, header: 'database-fallback-fixture' };
    }

    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver,
      regionHierarchy,
      // Saved-home origin (postal → point) resolves at FSA / area granularity (Task 29):
      // the `kids-fun-mapbox` key is still absent, so full street-level geocoding
      // (lib/geo/geocode.ts) is unavailable — this maps a saved postal's FSA to its
      // municipality centroid instead. Swap for the Mapbox-backed Geocoder here once the
      // key lands, no other change needed.
      geocoder: fsaGeocoder,
      fixtureBacked: false,
    });
    const response = engine.search(searchRequest);
    response.meta.backend = 'database';

    if (response.results.length === 0 && response.expected.length === 0) {
      const fallback = searchFixtures(searchRequest);
      fallback.meta.fallbackReason = 'database search returned no visible results for this query';
      return { ok: true, response: fallback, header: 'database-fallback-fixture' };
    }

    return { ok: true, response, header: 'database' };
  } catch {
    const fallback = searchFixtures(searchRequest);
    fallback.meta.fallbackReason = 'database search unavailable';
    return { ok: true, response: fallback, header: 'database-fallback-fixture' };
  }
}

function searchFixtures(searchRequest: SearchRequest): SearchResponse {
  const response = fixtureBundle.engine.search(searchRequest);
  response.meta.backend = 'fixture';
  return response;
}

function json(response: SearchResponse, source: string): NextResponse {
  return NextResponse.json(response, { headers: { 'x-data-source': source } });
}

function buildSearchRequest(p: URLSearchParams): SearchRequest {
  const q = p.get('q') ?? '';
  const sortParam = p.get('sort');
  const sort = sortParam && (VALID_SORTS as string[]).includes(sortParam) ? (sortParam as SortKey) : undefined;
  const origin = buildOriginRequest(p);
  const regionChipIds = (p.get('region') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const includeUnknownCost = ['1', 'true', 'yes'].includes((p.get('includeUnknownCost') ?? '').toLowerCase());
  const limit = clampInt(p.get('limit'), 1, 100);
  const minResults = clampInt(p.get('minResults'), 0, 100);

  return {
    q,
    origin,
    signedIn: p.get('signedIn') === '1',
    regionChipIds,
    sort,
    includeUnknownCost,
    ...(limit != null ? { limit } : {}),
    ...(minResults != null ? { minResults } : {}),
  };
}

/** Derive an origin resolution request from query params (near me / area chip / saved home). */
function buildOriginRequest(p: URLSearchParams): OriginRequest | null {
  const latParam = p.get('lat');
  const lngParam = p.get('lng');
  if (latParam != null && lngParam != null) {
    const lat = Number(latParam);
    const lng = Number(lngParam);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { mode: 'near_me', coords: { lat, lng } };
  }
  const area = p.get('area');
  if (area) return { mode: 'area_chip', areaChipId: area };
  const postal = p.get('postal');
  if (postal) return { mode: 'saved_home', homePostal: postal };
  return null;
}

function clampInt(raw: string | null, min: number, max: number): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
