// evals/harness.ts — shared eval harness for the T36 benchmark suite (G-T36-1/2).
//
// Everything here runs over the REAL search path — the exact SearchEngine composition
// that app/api/search/route.ts serves. There are no mocks or stubbed responses:
//
//   • defaultEngine() === makeFixtureEngine().engine — the fixture-backed engine the
//     product ships and /api/search returns in its default mode (KIDS_FUN_SEARCH_BACKEND
//     unset). It is the real parse → alias-expand → match → filter → rank → sort →
//     broaden pipeline over the app's shipped FIXTURE_LISTINGS + real alias dictionary +
//     real region hierarchy.
//   • buildDbEngine() === the SAME engine wired to the LIVE Postgres read model
//     (loadPostgresListings + the DB alias/region resolvers), i.e. the staging
//     KIDS_FUN_SEARCH_BACKEND=database path. This is how the harness measures the real
//     ingested catalogue — thin today (M1 ingestion is early), so its numbers are
//     honestly low and reported as such rather than hidden.
//
// No test-framework imports live here so this harness is reusable by the golden test,
// the PRD scenario suite, and a future UAT harness (G-T36-3).

import { SearchEngine } from '@/lib/search/engine';
import type { SearchRequest, SearchResponse } from '@/lib/search/engine';
import type { SortKey } from '@/lib/search/types';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';

export { FIXTURE_NOW };

/**
 * The East-Van origin — the "near East Van" location signal of the flagship query.
 * Matches the FIXTURE_LISTINGS geo header and the East-Van point in lib/analytics/
 * benchmark.ts / app/preview/_data/search-api.ts, so the whole codebase agrees on
 * where "East Van" is.
 */
export const EAST_VAN = { lat: 49.26, lng: -123.07 } as const;

/** A named origin keeps evals/golden.json pure JSON (no coordinates/functions inline). */
export type NamedOrigin = 'east_van_near_me' | 'none';

/** The request half of a golden query — a JSON-serialisable subset of SearchRequest. */
export interface GoldenRequest {
  q: string;
  origin?: NamedOrigin;
  regionChipIds?: string[];
  sort?: SortKey;
  includeUnknownCost?: boolean;
  minResults?: number;
  limit?: number;
}

/** The assertion half of a golden query — every field is optional and additive. */
export interface GoldenExpect {
  /** Primary result count must be at least this. */
  minResults?: number;
  /** Ceiling on the zero-result rate for this single query (0 = must never be empty). */
  maxZeroResultPct?: number;
  /** The #1 ranked result must be this listing id. */
  topResultId?: string;
  /** The #1 ranked result's primary category must be this. */
  topResultCategory?: string;
  /** These listing ids must all be present in the primary results. */
  containsIds?: string[];
  /** None of these listing ids may appear in the primary results. */
  excludesIds?: string[];
  /** Every primary result's category must be one of these (relevance guard). */
  allCategoriesIn?: string[];
}

/** One row of evals/golden.json. */
export interface GoldenQuery {
  id: string;
  label: string;
  /** Which KPI / PRD scenario this golden query anchors to (documentation only). */
  anchor: string;
  request: GoldenRequest;
  expect: GoldenExpect;
}

/** The normalised outcome of running one golden query through an engine. */
export interface GoldenRun {
  id: string;
  total: number;
  zeroResult: boolean;
  broadened: boolean;
  topId: string | null;
  topCategory: string | null;
  resultIds: string[];
  categories: string[];
  response: SearchResponse;
}

/** The real default search engine — identical composition to /api/search fixture mode. */
export function defaultEngine(): SearchEngine {
  return makeFixtureEngine().engine;
}

/** Map a golden request onto a real SearchRequest (deterministic clock = FIXTURE_NOW). */
export function toSearchRequest(req: GoldenRequest): SearchRequest {
  const request: SearchRequest = {
    q: req.q,
    now: FIXTURE_NOW,
    origin:
      req.origin === 'east_van_near_me'
        ? { mode: 'near_me', coords: { lat: EAST_VAN.lat, lng: EAST_VAN.lng } }
        : null,
    regionChipIds: req.regionChipIds ?? [],
    includeUnknownCost: req.includeUnknownCost ?? false,
    minResults: req.minResults ?? 3,
    limit: req.limit ?? 20,
  };
  if (req.sort) request.sort = req.sort;
  return request;
}

/** Run one golden query through the given engine and normalise the outcome. */
export function runGolden(engine: SearchEngine, gq: GoldenQuery): GoldenRun {
  const response = engine.search(toSearchRequest(gq.request));
  return {
    id: gq.id,
    total: response.total,
    zeroResult: response.total === 0,
    broadened: response.broadening.applied.length > 0,
    topId: response.results[0]?.listing.id ?? null,
    topCategory: response.results[0]?.listing.primaryCategoryKey ?? null,
    resultIds: response.results.map((r) => r.listing.id),
    categories: response.results.map((r) => r.listing.primaryCategoryKey),
    response,
  };
}

/** The failing expectations for one run (empty array = the query fully passed). */
export function checkExpectations(gq: GoldenQuery, run: GoldenRun): string[] {
  const e = gq.expect;
  const failures: string[] = [];
  if (e.minResults != null && run.total < e.minResults) {
    failures.push(`expected ≥${e.minResults} results, got ${run.total}`);
  }
  if (e.maxZeroResultPct != null && e.maxZeroResultPct === 0 && run.zeroResult) {
    failures.push('expected a non-empty result set (zero-result not allowed)');
  }
  if (e.topResultId != null && run.topId !== e.topResultId) {
    failures.push(`expected top result ${e.topResultId}, got ${run.topId ?? 'none'}`);
  }
  if (e.topResultCategory != null && run.topCategory !== e.topResultCategory) {
    failures.push(`expected top category ${e.topResultCategory}, got ${run.topCategory ?? 'none'}`);
  }
  for (const id of e.containsIds ?? []) {
    if (!run.resultIds.includes(id)) failures.push(`expected results to contain ${id}`);
  }
  for (const id of e.excludesIds ?? []) {
    if (run.resultIds.includes(id)) failures.push(`expected results to exclude ${id}`);
  }
  if (e.allCategoriesIn != null) {
    const stray = run.categories.filter((c) => !e.allCategoriesIn!.includes(c));
    if (stray.length > 0) failures.push(`stray categories present: ${[...new Set(stray)].join(', ')}`);
  }
  return failures;
}

/** Aggregate coverage numbers over a batch of runs — the honest harness report. */
export interface GoldenSummary {
  queries: number;
  zeroResultQueries: number;
  zeroResultPct: number;
  avgResults: number;
  passedQueries: number;
  passRatePct: number;
}

/** Compute the aggregate summary given each query and its run outcome. */
export function summarize(pairs: { gq: GoldenQuery; run: GoldenRun }[]): GoldenSummary {
  const queries = pairs.length;
  const zero = pairs.filter((p) => p.run.zeroResult).length;
  const totalResults = pairs.reduce((a, p) => a + p.run.total, 0);
  const passed = pairs.filter((p) => checkExpectations(p.gq, p.run).length === 0).length;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    queries,
    zeroResultQueries: zero,
    zeroResultPct: queries ? round1((zero / queries) * 100) : 0,
    avgResults: queries ? round1(totalResults / queries) : 0,
    passedQueries: passed,
    passRatePct: queries ? round1((passed / queries) * 100) : 0,
  };
}

/**
 * Build the engine wired to the LIVE Postgres read model — the staging
 * KIDS_FUN_SEARCH_BACKEND=database path, assembled exactly as app/api/search/route.ts
 * assembles it. Returns the engine plus how many real listings the catalogue currently
 * holds (0 today on a fresh CI DB, since reference seeds carry no activity listings).
 * The pg-touching modules are imported lazily so the fixture-only tests never open a pool.
 */
export async function buildDbEngine(): Promise<{ engine: SearchEngine; listingCount: number }> {
  const { getPool } = await import('@/lib/db/client');
  const { loadPostgresListings } = await import('@/lib/search/postgres-repository');
  const { getPostgresAliasResolver } = await import('@/lib/search/postgres-alias-resolver');
  const { getPostgresRegionHierarchy } = await import('@/lib/search/postgres-region-hierarchy');
  const { fsaGeocoder } = await import('@/lib/geo/postal-fsa');
  const { InMemoryListingRepository } = await import('@/lib/search/repository');

  const pool = getPool();
  const [listings, aliasResolver, regionHierarchy] = await Promise.all([
    loadPostgresListings(pool),
    getPostgresAliasResolver(pool),
    getPostgresRegionHierarchy(pool),
  ]);
  const engine = new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver,
    regionHierarchy,
    geocoder: fsaGeocoder,
    fixtureBacked: false,
  });
  return { engine, listingCount: listings.length };
}
