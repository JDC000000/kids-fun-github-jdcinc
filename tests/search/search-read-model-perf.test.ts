// tests/search/search-read-model-perf.test.ts — the PERFORMANCE half of the catalogue-cap fix.
//
// Commit d6b2341 removed the 500-row pre-search cap (correct: rows below the cut were invisible to
// every query). Its cost is that /api/search now reloads the COMPLETE catalogue on every request
// and re-tokenises every listing on every one of the 3-18 matcher passes a request makes. Measured
// back to back against live staging at 4,967 rows: 292ms/request capped → 560ms/request uncapped.
// These tests pin the two mechanisms that close that gap without giving back any visibility.
//
// The cap BEHAVIOUR itself is main's and is covered by tests/search/postgres-repository-cap.test.ts;
// nothing here re-tests it.
//
// These are UNIT tests (no database): the pool is a stub that records the SQL it is handed and
// returns synthetic rows. That is deliberate. The behaviours this fix turns on are all decided in
// this module BEFORE any row comes back — what LIMIT is sent, whether truncation is detected, and
// whether the cache short-circuits the query — so a stub pool tests them exactly and a real
// database would only add a shared-Postgres dependency without testing anything more.
//
// The DB-backed half (real rows really load uncapped) lives in tests/search/postgres-repository.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  clearPostgresListingsCache,
  getCachedPostgresListings,
} from '../../lib/search/postgres-repository';
import { WeightedTrigramMatcher } from '../../lib/search/match';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';

/** A pool stub that records every query and returns `rowCount` synthetic occurrence rows. */
function stubPool(rowCount: number): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const limit = Number(params[0] ?? rowCount);
      const n = Math.min(rowCount, Number.isFinite(limit) ? limit : rowCount);
      return Promise.resolve({
        rows: Array.from({ length: n }, (_, i) => ({
          id: `id-${i}`,
          series_id: `series-${i}`,
          activity_name: `Activity ${i}`,
          primary_category_key: 'storytime',
          tag_keys: [],
          venue_name: 'Venue',
          source_name: 'Source',
          series_title: 'Series',
          source_authority_tier: 'official',
          description_snippet: '',
          start_datetime_utc: null,
          end_datetime_utc: null,
          open_hours_state: 'open',
          cost_status: 'free',
          cost_min_cad: null,
          cost_max_cad: null,
          source_url: null,
          booking_url: null,
          location_url: null,
          status_state: 'confirmed',
          confidence_label: 'high',
          last_checked_at: null,
          age_min_months: null,
          age_max_months: null,
          age_notes: null,
          age_band_keys: [],
          lat: null,
          lng: null,
          municipality_id: null,
          neighbourhood: null,
          display_area: null,
          phone: null,
        })),
      });
    },
  } as unknown as Pool;
  return { pool, calls };
}

/** The LIMIT actually sent to Postgres for a given call. */
const limitOf = (call: { params: unknown[] }) => Number(call.params[0]);

describe('read-model TTL cache', () => {
  beforeEach(() => {
    clearPostgresListingsCache();
    delete process.env.KIDS_FUN_LISTING_CACHE_MS;
  });
  afterEach(() => {
    clearPostgresListingsCache();
    delete process.env.KIDS_FUN_LISTING_CACHE_MS;
  });

  it('serves a second request from cache inside the TTL window', async () => {
    // This is what makes the uncapped read model affordable: measured on live staging the uncapped
    // load is ~428ms of a 560ms request, so without amortisation the visibility fix ships a ~1.9x
    // latency regression that widens as the catalogue grows.
    const { pool, calls } = stubPool(5_240);
    const a = await getCachedPostgresListings(pool, 1_000);
    const b = await getCachedPostgresListings(pool, 1_000 + 59_000);

    expect(calls).toHaveLength(1);
    expect(b).toBe(a); // same objects — which is also what keeps the matcher's WeakMap warm
  });

  it('reloads once the TTL has expired', async () => {
    const { pool, calls } = stubPool(5_240);
    await getCachedPostgresListings(pool, 1_000);
    await getCachedPostgresListings(pool, 1_000 + 60_001);

    expect(calls).toHaveLength(2);
  });

  it('KIDS_FUN_LISTING_CACHE_MS=0 disables caching entirely', async () => {
    // The DB-backed suites rely on this: a cached read model would make them assert against rows
    // from a previous test's world.
    process.env.KIDS_FUN_LISTING_CACHE_MS = '0';
    const { pool, calls } = stubPool(10);
    await getCachedPostgresListings(pool, 1_000);
    await getCachedPostgresListings(pool, 1_000);

    expect(calls).toHaveLength(2);
  });

  it('clearPostgresListingsCache forces the next access to reload', async () => {
    const { pool, calls } = stubPool(10);
    await getCachedPostgresListings(pool, 1_000);
    clearPostgresListingsCache();
    await getCachedPostgresListings(pool, 1_000);

    expect(calls).toHaveLength(2);
  });
});

describe('matcher token-index memoisation', () => {
  // The memoisation is a PURE speed change or it is a bug. These tests assert that directly rather
  // than trusting the intent: same listings in, byte-identical candidate sets out.
  // Built through the shared fixture factory rather than hand-rolled, so a future field added to
  // ListingRecord (as `registrationRequired` just was) cannot silently make this file stale.
  const listings: ListingRecord[] = [
    'Public Swim - Teach Pool',
    'Summer Reading Club',
    'Ball Hockey - GOALIES ONLY',
    'Ballet Barre',
    'Family Storytime',
    'Indoor Soccer',
  ].map((activityName, i) =>
    makeListing({
      id: `l-${i}`,
      activityName,
      primaryCategoryKey: 'class_program',
      categoryTags: ['class_program'],
      venueName: 'Community Centre',
      organisation: 'Test Source',
      descriptionSnippet: 'A description for testing.',
      suitabilityTags: ['indoor'],
    }),
  );

  const aliases = new FixtureAliasResolver([]);
  const fingerprint = (m: WeightedTrigramMatcher, q: string) =>
    JSON.stringify(
      m.match(aliases.expand([q]), listings).map((c) => [c.listing.id, c.relevance, c.matchedTerms, c.categoryHit]),
    );

  it.each(['swim', 'swimmer', 'ball', 'soccer', 'storytime', 'pa', 'summer'])(
    'returns identical candidates on the cached second pass — query "%s"',
    (q) => {
      const matcher = new WeightedTrigramMatcher();
      const cold = fingerprint(matcher, q); // populates the WeakMap
      const warm = fingerprint(matcher, q); // must be served from it
      expect(warm).toBe(cold);
    },
  );

  it('a memoised matcher agrees with a fresh one on every query (no cross-request drift)', () => {
    // The engine makes 3-18 matcher passes per request over the SAME listing objects, and with the
    // read-model cache those objects now also survive between requests. So "warm matcher, warm
    // listings" is the normal steady state and has to be provably identical to a cold start.
    const warm = new WeightedTrigramMatcher();
    for (const q of ['swim', 'ball', 'soccer']) fingerprint(warm, q); // warm it thoroughly

    for (const q of ['swim', 'swimmer', 'ball', 'soccer', 'storytime', 'pa', 'summer', 'time']) {
      expect(fingerprint(warm, q)).toBe(fingerprint(new WeightedTrigramMatcher(), q));
    }
  });

  it('does not tokenise the same listing twice', () => {
    // MUTATION CHECK for the test above: without this, deleting the cache read would leave every
    // assertion in this describe block still green, because a correct-but-unmemoised matcher
    // returns identical results. This is the only test here that FAILS if the memoisation is
    // removed — verified by removing it.
    const matcher = new WeightedTrigramMatcher();
    const spy = vi.spyOn(matcher as unknown as { buildFields: (l: ListingRecord) => unknown }, 'buildFields');

    fingerprint(matcher, 'swim');
    const afterFirst = spy.mock.calls.length;
    fingerprint(matcher, 'swim');
    fingerprint(matcher, 'ball');

    expect(afterFirst).toBe(listings.length); // cold pass tokenises each listing exactly once
    expect(spy.mock.calls.length).toBe(afterFirst); // two further passes tokenise nothing
    spy.mockRestore();
  });
});
