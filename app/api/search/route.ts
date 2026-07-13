// app/api/search/route.ts — Search API route (G-T16-7, TSD §5A, FR-02).
//
// Default remains fixture-backed while live coverage is narrow. Staging can opt
// into the DB read model with KIDS_FUN_SEARCH_BACKEND=database; if DB search is
// empty or unavailable, the route falls back to fixtures and marks the response
// header/meta so the product shell never goes blank during staged rollout.

import { NextResponse } from 'next/server';
import { makeFixtureEngine } from '@/lib/search/__fixtures__/engine';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { fixtureGeocoder } from '@/lib/search/__fixtures__/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { loadPostgresListings } from '@/lib/search/postgres-repository';
import { SearchEngine, type SearchRequest, type SearchResponse } from '@/lib/search/engine';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { getPool } from '@/lib/db/client';
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
    const listings = await loadPostgresListings(getPool());
    if (listings.length === 0) return { ok: false };

    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
      regionHierarchy: new RegionHierarchy(REGIONS),
      geocoder: fixtureGeocoder,
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
  const lat = Number(p.get('lat'));
  const lng = Number(p.get('lng'));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
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
