// lib/search/server-engine.ts — build a SearchEngine for a SERVER COMPONENT that has to
// evaluate a search outside the /api/search request path (today: /account's saved-search
// list, which must say whether each saved search currently matches anything).
//
// Honours the SAME backend switch as app/api/search/route.ts — live Postgres when
// KIDS_FUN_SEARCH_BACKEND=database, the hand-authored fixture bundle otherwise — so a
// surface built on this can never disagree with what /search would show in the same
// environment. It reuses the route's cached loaders (getCachedPostgresListings and the
// per-instance alias/region caches), so this is not a second read model, just a second
// consumer of the one already warm.
//
// Returns NULL on a genuine failure to load rather than an empty engine. That distinction
// is the whole point: "we could not check" and "nothing matches" are different statements,
// and a caller must never render the second when it means the first.

import { SearchEngine } from './engine';
import { InMemoryListingRepository } from './repository';
import { getCachedPostgresListings } from './postgres-repository';
import { getPostgresAliasResolver } from './postgres-alias-resolver';
import { getPostgresRegionHierarchy } from './postgres-region-hierarchy';
import { makeFixtureEngine } from './__fixtures__/engine';
import { fsaGeocoder } from '../geo/postal-fsa';
import { getPool } from '../db/client';

let fixtureEngine: SearchEngine | null = null;

/**
 * The live search engine for server-side, non-route callers, or null if it cannot be built.
 *
 * Saved-home origins resolve through the FSA-centroid geocoder rather than Mapbox — the same
 * choice lib/email/weekly.ts makes. A page that evaluates every saved search a parent owns
 * must not fan out to a paid geocoder to do it, and FSA granularity is the documented
 * fallback for exactly this case (lib/geo/postal-fsa.ts).
 */
export async function getServerSearchEngine(): Promise<SearchEngine | null> {
  if (process.env.KIDS_FUN_SEARCH_BACKEND !== 'database') {
    if (!fixtureEngine) fixtureEngine = makeFixtureEngine().engine;
    return fixtureEngine;
  }

  try {
    const pool = getPool();
    const [listings, aliasResolver, regionHierarchy] = await Promise.all([
      getCachedPostgresListings(pool),
      getPostgresAliasResolver(pool),
      getPostgresRegionHierarchy(pool),
    ]);
    return new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver,
      regionHierarchy,
      geocoder: fsaGeocoder,
      fixtureBacked: false,
    });
  } catch {
    return null;
  }
}
