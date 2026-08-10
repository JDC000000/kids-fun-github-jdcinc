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
// this module BEFORE any row comes back — whether the cache short-circuits the query, and whether
// concurrent cold callers share one load — so a stub pool tests them exactly and a real database
// would only add a shared-Postgres dependency without testing anything more.
//
// The DB-backed half (real rows really load uncapped) lives in
// tests/search/postgres-repository.test.ts; the cap behaviour itself in
// tests/search/postgres-repository-cap.test.ts. Nothing here sends or asserts a LIMIT.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  clearPostgresListingsCache,
  getCachedPostgresListings,
} from '../../lib/search/postgres-repository';
import { WeightedTrigramMatcher } from '../../lib/search/match';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { resetCacheTtlWarnings } from '../../lib/search/ttl-cache';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';

/**
 * A pool stub that records every query and returns `rowCount` synthetic occurrence rows.
 *
 * It does NOT interpret a LIMIT, because `getCachedPostgresListings` — the only thing under test
 * here — never sends one. The branch that used to try was inert (`params[0]` is HIDDEN_STATUSES,
 * and `Number(['cancelled', ...])` is NaN, so it always fell through to `rowCount`) and was a
 * latent trap: empty HIDDEN_STATUSES would make `Number([]) === 0` and silently return ZERO rows,
 * turning every test in this file green-for-the-wrong-reason.
 */
function stubPool(rowCount: number): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve({
        rows: Array.from({ length: rowCount }, (_, i) => ({
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

/**
 * Row count for the cache tests. Nothing here asserts on it — these tests count QUERIES and
 * compare object identity — so it is set to the smallest number that still exercises the code
 * path. It was 5,240 (the live staging catalogue size), which built ~10k throwaway objects and
 * pushed this 22nd CPU-heavy file into the parallel unit lane hard enough to tip the wall-clock
 * assertions in tests/search/facets.perf.test.ts: 2 of 5 full-lane runs failed on this branch
 * where the baseline was 5 of 5 clean. The catalogue size belongs in the measurement comments
 * above, not in a fixture that no assertion reads.
 */
const CACHE_TEST_ROWS = 25;

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
    const { pool, calls } = stubPool(CACHE_TEST_ROWS);
    const a = await getCachedPostgresListings(pool, 1_000);
    const b = await getCachedPostgresListings(pool, 1_000 + 59_000);

    expect(calls).toHaveLength(1);
    expect(b).toBe(a); // same objects — which is also what keeps the matcher's WeakMap warm
  });

  it('reloads once the TTL has expired', async () => {
    const { pool, calls } = stubPool(CACHE_TEST_ROWS);
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

  // A var that is SET BUT EMPTY is trivially produced (a blank Vercel env entry, `VAR=` in a
  // .env). `Number('')` is 0, and the old `>= 0` guard accepted it — so the cache silently
  // switched off with no error and no log. Nobody diagnoses a latency regression with no signal.
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['non-numeric', 'off'],
    ['negative', '-1'],
  ])('an unusable KIDS_FUN_LISTING_CACHE_MS (%s) falls back to the default, not to 0', async (_label, value) => {
    resetCacheTtlWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KIDS_FUN_LISTING_CACHE_MS = value;

    const { pool, calls } = stubPool(10);
    await getCachedPostgresListings(pool, 1_000);
    await getCachedPostgresListings(pool, 1_000 + 59_000); // inside the DEFAULT 60s window

    expect(calls).toHaveLength(1); // cache still on
    expect(warn).toHaveBeenCalledTimes(1); // and the misconfiguration is diagnosable
    warn.mockRestore();
  });

  it('warns once per bad value, not once per request', async () => {
    resetCacheTtlWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KIDS_FUN_LISTING_CACHE_MS = '';

    const { pool } = stubPool(10);
    for (let i = 0; i < 5; i++) {
      clearPostgresListingsCache();
      await getCachedPostgresListings(pool, 1_000);
    }

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('collapses a concurrent cold burst into ONE load (no cache stampede)', async () => {
    // Measured before this fix: 20 concurrent cold callers → 20 full catalogue loads. The route
    // awaits this and the two other caches in one Promise.all, so a cold burst of N requests
    // issued ~3N loads. Cold happens on every deploy, every scale-out, and every TTL rollover
    // under load — i.e. exactly when the instance is least able to absorb it.
    const { pool, calls } = stubPool(CACHE_TEST_ROWS);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => getCachedPostgresListings(pool, 1_000)),
    );

    expect(calls).toHaveLength(1);
    for (const r of results) expect(r).toBe(results[0]);
  });

  it('does not cache a REJECTED load (one blip must not poison the whole TTL window)', async () => {
    let attempts = 0;
    const pool = {
      query: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('connection reset')) : Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;

    await expect(getCachedPostgresListings(pool, 1_000)).rejects.toThrow('connection reset');
    await expect(getCachedPostgresListings(pool, 1_000)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('hands out a FROZEN array — the same one every concurrent request holds', async () => {
    // The cached array is shared by reference across every request in the window. An in-place
    // sort or push on it would corrupt every other in-flight request, silently, for a full TTL.
    const { pool } = stubPool(3);
    const listings = await getCachedPostgresListings(pool, 1_000);

    expect(Object.isFrozen(listings)).toBe(true);
    expect(() => (listings as ListingRecord[]).push(listings[0])).toThrow();
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
