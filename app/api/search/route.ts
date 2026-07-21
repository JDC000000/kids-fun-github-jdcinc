// app/api/search/route.ts — Search API route (G-T16-7, TSD §5A, FR-02).
//
// Default remains fixture-backed while live coverage is narrow. Staging/prod opt into
// the DB read model with KIDS_FUN_SEARCH_BACKEND=database; when they do, the WHOLE
// pipeline is live — DB listings AND the DB alias dictionary (synonym_alias, via
// PostgresAliasResolver) AND the DB region hierarchy (region table). No fixture resolver
// leaks into database mode.
//
// In LIVE database mode a real visitor is NEVER shown test/fixture rows. There are two
// honest outcomes and one honest failure — each maps to a UI state the product already
// has (app/search/page.tsx, app/preview ResultsShell):
//   • Reachable, zero visible results for this query (e.g. `open gym`, no live source yet,
//     or the table is momentarily empty)  → return the REAL empty response → "No matches
//     yet" empty state.  (Previously this fell back to fixtures — the P0 leak that showed
//     "Rank Test Gym" to real parents. Removed.)
//   • Reachable, has matches                                → return the real results.
//   • Genuinely unreachable / errored (pool/query threw)    → 5xx → "couldn't load, try
//     again" error state.  We must NOT fake data, and must NOT claim "nothing matches"
//     when we could not actually search.
// Fixture/default mode (KIDS_FUN_SEARCH_BACKEND !== 'database') is unchanged: local dev
// and the /preview demo shell intentionally run on fixtures — not a live-visitor path.

import { NextResponse } from 'next/server';
import { makeFixtureEngine } from '@/lib/search/__fixtures__/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { loadPostgresListings } from '@/lib/search/postgres-repository';
import { getPostgresAliasResolver } from '@/lib/search/postgres-alias-resolver';
import { getPostgresRegionHierarchy } from '@/lib/search/postgres-region-hierarchy';
import { SearchEngine, type SearchRequest, type SearchResponse } from '@/lib/search/engine';
import { getPool } from '@/lib/db/client';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { resolvePreciseSavedHomeGeocoder } from '@/lib/geo/saved-home-geocoder';
import type { Geocoder, OriginRequest } from '@/lib/geo/origin';
import type { SortKey } from '@/lib/search/types';

export const dynamic = 'force-dynamic';

const VALID_SORTS: SortKey[] = ['best_match', 'distance', 'soonest', 'lowest_cost', 'newest'];
const fixtureBundle = makeFixtureEngine();

/** GET /api/search?q=open+gym&lat=..&lng=..&sort=..&region=van,bby&includeUnknownCost=1&limit=20 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const searchRequest = buildSearchRequest(url.searchParams);

  // Precise saved-home origin (Task 36): pre-resolve the saved postal to a real Mapbox
  // point once, at the async boundary, so the synchronous engine can use it. Returns
  // null for anything that can't/shouldn't be precisely geocoded (near_me/area_chip,
  // not signed in, Mapbox down/timeout/miss) → the FSA-centroid fallback below stands in.
  const preciseGeocoder = await resolvePreciseSavedHomeGeocoder(
    searchRequest.origin,
    searchRequest.signedIn ?? false
  );

  if (process.env.KIDS_FUN_SEARCH_BACKEND === 'database') {
    const dbResult = await searchDatabase(searchRequest, preciseGeocoder);
    if (dbResult.ok) return json(dbResult.response, dbResult.header);
    // Genuine DB outage in LIVE database mode: fail honestly with a 5xx so each client
    // renders its existing "couldn't load — try again" state. We deliberately do NOT fall
    // through to the fixture path below — real production visitors must NEVER be shown
    // test/fixture rows (e.g. "Rank Test Gym"), and an outage is not a "nothing matches".
    return jsonError('search temporarily unavailable', 503);
  }

  // Fixture/default mode only (KIDS_FUN_SEARCH_BACKEND !== 'database'): local dev and the
  // /preview demo shell intentionally run on hand-authored fixtures. This is NOT the live
  // production data path, so returning fixtures here is correct and unchanged.
  const response = searchFixtures(searchRequest, preciseGeocoder);
  return json(response, 'fixture');
}

async function searchDatabase(
  searchRequest: SearchRequest,
  preciseGeocoder: Geocoder | null
): Promise<{ ok: true; response: SearchResponse; header: string } | { ok: false }> {
  try {
    const pool = getPool();
    // Retire the fixture seam in database mode: the ENTIRE pipeline reads live DB —
    // listings AND the alias dictionary (synonym_alias) AND the region hierarchy (region).
    // All three load in parallel; a genuine failure of any of them throws to the catch
    // below (→ honest 5xx), which is categorically different from a successful search that
    // simply matched nothing.
    const [listings, aliasResolver, regionHierarchy] = await Promise.all([
      loadPostgresListings(pool),
      getPostgresAliasResolver(pool),
      getPostgresRegionHierarchy(pool),
    ]);

    // No fixture fallback on an empty/zero-match result set anymore. Pre-launch the DB was
    // completely empty and fixtures kept the shell from going blank (the original, now-stale
    // rationale). Post-launch the DB is populated for the live sources, so BOTH "the table
    // is empty" AND "this specific query matched nothing" (e.g. `open gym`, which no live
    // source covers yet) are REAL zero-result answers that must render the honest empty
    // state — never test rows like "Rank Test Gym". The engine handles an empty repository
    // correctly (zero results), so we run it unconditionally and return whatever it produces.
    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver,
      regionHierarchy,
      // Saved-home origin (postal → point): Task 36 wires live Mapbox geocoding. When the
      // request pre-resolved a precise point, use it; otherwise degrade to the Task-29
      // FSA-centroid resolver (fsaGeocoder) as the fallback-of-last-resort.
      geocoder: preciseGeocoder ?? fsaGeocoder,
      fixtureBacked: false,
    });
    const response = engine.search(searchRequest);
    response.meta.backend = 'database';
    return { ok: true, response, header: 'database' };
  } catch {
    // Genuine DB failure (pool/connection/query threw) — categorically different from a
    // reachable-but-zero-match result. We could not search at all, so we must neither fake
    // data (fixtures) nor falsely claim "nothing matches" (empty state). Signal failure; the
    // caller returns a 5xx and the client shows its honest "couldn't load — try again" state.
    return { ok: false };
  }
}

function searchFixtures(searchRequest: SearchRequest, preciseGeocoder: Geocoder | null = null): SearchResponse {
  // Reuse the cached fixture engine (fsaGeocoder baked in) unless the request pre-resolved
  // a precise saved-home point — then build a one-off engine over the same fixture deps
  // with the precise geocoder swapped in. Task 36.
  const engine = preciseGeocoder
    ? new SearchEngine({
        repository: fixtureBundle.repository,
        aliasResolver: fixtureBundle.aliasResolver,
        regionHierarchy: fixtureBundle.regionHierarchy,
        geocoder: preciseGeocoder,
      })
    : fixtureBundle.engine;
  const response = engine.search(searchRequest);
  response.meta.backend = 'fixture';
  return response;
}

function json(response: SearchResponse, source: string): NextResponse {
  return NextResponse.json(response, { headers: { 'x-data-source': source } });
}

/** Honest failure for LIVE database mode: a genuine DB outage returns a 5xx (never a
 *  fixture/test row) so every client renders its existing "couldn't load — try again"
 *  state. `x-data-source: database-error` lets monitoring distinguish an outage from a
 *  real empty result. */
function jsonError(reason: string, status: number): NextResponse {
  return NextResponse.json({ error: reason }, { status, headers: { 'x-data-source': 'database-error' } });
}

function buildSearchRequest(p: URLSearchParams): SearchRequest {
  const q = p.get('q') ?? '';
  const sortParam = p.get('sort');
  const sort = sortParam && (VALID_SORTS as string[]).includes(sortParam) ? (sortParam as SortKey) : undefined;
  const origin = buildOriginRequest(p);
  const regionChipIds = (p.get('region') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const includeUnknownCost = ['1', 'true', 'yes'].includes((p.get('includeUnknownCost') ?? '').toLowerCase());
  const dateRange = buildDateRange(p);
  const limit = clampInt(p.get('limit'), 1, 100);
  const minResults = clampInt(p.get('minResults'), 0, 100);

  return {
    q,
    origin,
    signedIn: p.get('signedIn') === '1',
    regionChipIds,
    sort,
    includeUnknownCost,
    ...(dateRange != null ? { dateRange } : {}),
    ...(limit != null ? { limit } : {}),
    ...(minResults != null ? { minResults } : {}),
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Custom date range (T26 / FR-04): `from`/`to` are structured YYYY-MM-DD params (like region,
 * not text in `q`). Both ends must be present and well-formed, else no range is applied. */
function buildDateRange(p: URLSearchParams): { from: string; to: string } | null {
  const from = p.get('from');
  const to = p.get('to');
  if (from && to && ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to)) return { from, to };
  return null;
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
