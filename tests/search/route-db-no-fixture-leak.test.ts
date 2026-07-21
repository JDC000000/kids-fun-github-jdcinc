// tests/search/route-db-no-fixture-leak.test.ts
//
// P0 REGRESSION GUARD — "the Rank Test Gym leak".
//
// In LIVE database mode (KIDS_FUN_SEARCH_BACKEND=database) with a POPULATED-but-non-matching
// database, a real visitor's zero/low-result query must NEVER be answered with fixture/test
// rows (e.g. "Rank Test Gym" at "Test Centre", id l-rank-confirmed) and must NEVER carry the
// internal fixture-fallback metadata (x-data-source: database-fallback-fixture / meta.
// fallbackReason). It must return the REAL empty response so the product renders its honest
// "No matches yet" empty state. A genuine DB outage (distinct from zero-match) must fail with
// a 5xx — never fixtures. See app/api/search/route.ts and app/preview/_data/load-activity.ts.
//
// The DB seam is mocked with a populated set of REAL (db-*) listings — three in Metro
// Vancouver of categories that don't match the probe queries, and one that IS an open_gym but
// lives in Toronto (out of range of a Vancouver near-me origin even after the 20km broadening
// cap). That makes several "no visible results for this query" cases deterministic while the
// table is demonstrably non-empty — exactly the partially-populated prod condition that broke.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { GET } from '../../app/api/search/route';
import { loadActivityById } from '../../app/preview/_data/load-activity';
import { clearGeocodeCache } from '../../lib/geo/geocode';

// Every surfaced listing id from the mocked DB starts with this. Fixture ids start with "l-".
const DB_ID_PREFIX = 'db-live-';

// Switchable DB behaviour, flipped per-test so EACH original fallback branch of route.ts's
// searchDatabase() is scrutinised directly (before = fixtures/leak, after = honest state):
//   'populated' → zero-real-matches branch   (pre-fix L86-90: results/expected 0 → fixtures)
//   'empty'     → empty-table branch          (pre-fix L67-71: listings.length===0 → fixtures)
//   'error'     → DB-outage catch branch      (pre-fix L93-97: thrown error → fixtures)
// vi.hoisted() lets the mock factory below reference this without hitting hoisting pitfalls.
const db = vi.hoisted(() => ({ mode: 'populated' as 'populated' | 'empty' | 'error' }));

// --- Mock the entire live DB seam the route + detail loader read through. Async factories +
// dynamic import avoid vi.mock hoisting pitfalls (no top-level variable capture). ---
vi.mock('@/lib/db/client', () => ({
  // Non-null dummy pool; it is never actually queried because the repository is mocked too.
  getPool: () => ({}),
}));

vi.mock('@/lib/search/postgres-repository', async () => {
  const { makeListing } = await import('@/lib/search/__fixtures__/factory');
  const VAN_EAST = { lat: 49.28, lng: -123.07 };
  const TORONTO = { lat: 43.65, lng: -79.38 };
  // Populated live table: real rows, none an "open gym" near Vancouver.
  const LIVE = [
    makeListing({
      id: 'db-live-swim-1', activityName: 'Lane Swim', primaryCategoryKey: 'swimming',
      venueName: 'Hillcrest Pool', geo: VAN_EAST, municipalityId: 'van', displayArea: 'van-east',
      startDatetimeUtc: '2026-07-21T18:00:00Z', endDatetimeUtc: '2026-07-21T20:00:00Z',
    }),
    makeListing({
      id: 'db-live-skate-1', activityName: 'Public Skate', primaryCategoryKey: 'skating',
      venueName: 'Trout Lake Rink', geo: VAN_EAST, municipalityId: 'van', displayArea: 'van-east',
      startDatetimeUtc: '2026-07-21T15:00:00Z', endDatetimeUtc: '2026-07-21T17:00:00Z',
    }),
    makeListing({
      id: 'db-live-art-1', activityName: 'Kids Pottery', primaryCategoryKey: 'arts',
      venueName: 'Community Studio', geo: VAN_EAST, municipalityId: 'van', displayArea: 'van-east',
      startDatetimeUtc: '2026-07-21T16:00:00Z', endDatetimeUtc: '2026-07-21T18:00:00Z',
    }),
    // The DB DOES hold an open_gym — but in Toronto, out of range for a Vancouver origin even
    // after full radius broadening. So "open gym near Vancouver" is a real zero-match while the
    // table is clearly non-empty. Pre-fix, this returned the Vancouver FIXTURE "Rank Test Gym".
    makeListing({
      id: 'db-live-opengym-toronto', activityName: 'Open Gym Drop-In', primaryCategoryKey: 'open_gym',
      venueName: 'Regent Park Rec', geo: TORONTO, municipalityId: 'tor', displayArea: 'tor',
      startDatetimeUtc: '2026-07-21T17:00:00Z', endDatetimeUtc: '2026-07-21T19:00:00Z',
    }),
  ];
  return {
    loadPostgresListings: async () => {
      if (db.mode === 'error') throw new Error('db connection refused'); // genuine outage
      if (db.mode === 'empty') return []; // reachable but empty table
      return LIVE;
    },
    loadPostgresListingById: async (_pool: unknown, id: string) => {
      if (db.mode === 'error') throw new Error('db connection refused');
      if (db.mode === 'empty') return null;
      return LIVE.find((l) => l.id === id) ?? null;
    },
  };
});

// Reset to the populated table before every test; branch-specific tests opt into empty/error.
beforeEach(() => {
  db.mode = 'populated';
});

vi.mock('@/lib/search/postgres-alias-resolver', async () => {
  const { FixtureAliasResolver } = await import('@/lib/search/expand');
  const { ALIAS_SEED } = await import('@/lib/search/__fixtures__/aliases');
  // Reuse the real alias dictionary so e.g. "open gym" genuinely parses to the open_gym
  // category — proving the zero-match is a real semantic miss, not a tokenisation accident.
  return { getPostgresAliasResolver: async () => new FixtureAliasResolver(ALIAS_SEED) };
});

vi.mock('@/lib/search/postgres-region-hierarchy', async () => {
  const { RegionHierarchy } = await import('@/lib/geo/region');
  const { REGIONS } = await import('@/lib/search/__fixtures__/regions');
  return { getPostgresRegionHierarchy: async () => new RegionHierarchy(REGIONS) };
});

async function call(qs: string) {
  const res = await GET(new Request(`http://localhost/api/search?${qs}`));
  return { res, body: await res.json() };
}

interface ResultItem { listing: { id: string; activityName: string; venueName: string } }

/** Every listing the response surfaces (confirmed + expected). */
function items(body: { results?: ResultItem[]; expected?: ResultItem[] }): ResultItem[] {
  return [...(body.results ?? []), ...(body.expected ?? [])];
}

describe('GET /api/search — database mode never leaks fixture/test rows on zero/low match', () => {
  const savedKey = process.env.GEOCODING_API_KEY;
  const savedBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
  beforeEach(() => {
    clearGeocodeCache();
    delete process.env.GEOCODING_API_KEY; // near-me origin is offline; keep it hermetic
    process.env.KIDS_FUN_SEARCH_BACKEND = 'database';
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEOCODING_API_KEY;
    else process.env.GEOCODING_API_KEY = savedKey;
    if (savedBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
    else process.env.KIDS_FUN_SEARCH_BACKEND = savedBackend;
  });

  // Adversarial sweep: multiple queries that legitimately match nothing near Vancouver against
  // a populated table. NONE may leak a fixture; EVERY surfaced row must come from the mocked DB.
  const ZERO_MATCH_QUERIES = [
    'q=open+gym&lat=49.26&lng=-123.07&minResults=1',        // category exists, but only in Toronto
    'q=fencing&lat=49.26&lng=-123.07&minResults=1',         // category not in the DB at all
    'q=trampoline+park&lat=49.26&lng=-123.07&minResults=1', // category not in the DB at all
    'q=archery&lat=49.26&lng=-123.07&minResults=1',         // category not in the DB at all
    'q=underwater+basket+weaving&lat=49.26&lng=-123.07&minResults=1', // nonsense term
  ];

  for (const qs of ZERO_MATCH_QUERIES) {
    it(`serves the real DB pipeline (no fixtures) for "${qs.split('&')[0]}"`, async () => {
      const { res, body } = await call(qs);

      // Never the fixture-fallback contract.
      expect(res.status).toBe(200);
      expect(res.headers.get('x-data-source')).toBe('database');
      expect(res.headers.get('x-data-source')).not.toBe('database-fallback-fixture');
      expect(body.meta.backend).toBe('database');
      expect(body.meta.fixtureBacked).toBe(false);
      expect(body.meta.fallbackReason).toBeUndefined();

      // No test row may appear, by id, name, or venue — and every surfaced row (if the
      // broadening ladder pulls any real neighbour in) must originate from the mocked DB.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/Rank Test Gym|Test Centre|l-rank-confirmed|l-rank-stale/);
      for (const item of items(body)) {
        expect(item.listing.id.startsWith(DB_ID_PREFIX)).toBe(true);
      }
    });
  }

  it('uses the real empty-state path (total 0, no fixtures) for an out-of-range zero-match', async () => {
    // The only open_gym is in Toronto → guaranteed zero near Vancouver, even after 20km
    // broadening. This is the exact honest empty state the UI renders instead of test data.
    const { res, body } = await call('q=open+gym&lat=49.26&lng=-123.07&minResults=1');
    expect(res.headers.get('x-data-source')).toBe('database');
    expect(body.results.length).toBe(0);
    expect(body.expected.length).toBe(0);
    // The engine still explains the empty state (what the UI uses for its broaden copy) —
    // proving we take the empty-state branch, not the fixture branch.
    expect(body.broadening.emptyState).not.toBeNull();
  });

  it('still returns REAL database matches (never fixtures) when the query does match', async () => {
    // Positive control: a query that matches a live row returns that live row, database-tagged.
    const { res, body } = await call('q=swim&lat=49.28&lng=-123.07&minResults=1');
    expect(res.headers.get('x-data-source')).toBe('database');
    expect(body.meta.backend).toBe('database');
    expect(body.meta.fixtureBacked).toBe(false);
    expect(body.meta.fallbackReason).toBeUndefined();
    const ids = items(body).map((i) => i.listing.id);
    expect(ids).toContain('db-live-swim-1');
    for (const item of items(body)) {
      expect(item.listing.id.startsWith(DB_ID_PREFIX)).toBe(true);
    }
  });

  it('EMPTY-TABLE branch (route.ts L67-71 pre-fix): a reachable-but-empty DB → real empty state, never fixtures', async () => {
    // Pre-fix this short-circuited to fixtures ("database has no indexed listings yet").
    // Post-fix an empty table is just a real zero-result answer → honest empty state.
    db.mode = 'empty';
    const { res, body } = await call('q=swim&lat=49.28&lng=-123.07&minResults=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-data-source')).toBe('database');
    expect(res.headers.get('x-data-source')).not.toBe('database-fallback-fixture');
    expect(body.meta.backend).toBe('database');
    expect(body.meta.fixtureBacked).toBe(false);
    expect(body.meta.fallbackReason).toBeUndefined();
    expect(body.results.length).toBe(0);
    expect(body.expected.length).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/Rank Test Gym|Test Centre|l-rank-confirmed/);
  });

  it('DB-OUTAGE branch (route.ts L93-97 pre-fix): a thrown DB error → honest 5xx, never fixtures', async () => {
    // Pre-fix the catch swallowed the error and returned fixtures ("database search
    // unavailable"). Post-fix a genuine outage is categorically different from a zero-match:
    // fail with a 5xx (client shows "couldn't load — try again"), never fixtures, and never
    // masquerading as "nothing matches".
    db.mode = 'error';
    const { res, body } = await call('q=open+gym&lat=49.26&lng=-123.07&minResults=1');
    expect(res.status).toBe(503);
    expect(res.headers.get('x-data-source')).not.toBe('database-fallback-fixture');
    expect(body.results).toBeUndefined();
    expect(body.meta).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/Rank Test Gym|Test Centre|l-rank-confirmed/);
  });
});

describe('loadActivityById — database mode resolves ONLY Postgres, never fixture/test ids', () => {
  const savedBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
    else process.env.KIDS_FUN_SEARCH_BACKEND = savedBackend;
  });

  it('does NOT resolve the fixture test id "l-rank-confirmed" to a fake detail page in database mode', async () => {
    process.env.KIDS_FUN_SEARCH_BACKEND = 'database';
    // Not in the mocked DB → must be null (404), NOT the "Rank Test Gym" fixture activity.
    const activity = await loadActivityById('l-rank-confirmed');
    expect(activity).toBeNull();
  });

  it('resolves a real DB id in database mode', async () => {
    process.env.KIDS_FUN_SEARCH_BACKEND = 'database';
    const activity = await loadActivityById('db-live-swim-1');
    expect(activity).not.toBeNull();
    expect(activity?.id).toBe('db-live-swim-1');
  });

  it('still resolves fixture ids in FIXTURE mode (dev/demo behaviour preserved)', async () => {
    delete process.env.KIDS_FUN_SEARCH_BACKEND; // fixture/default mode
    const activity = await loadActivityById('l-rank-confirmed');
    expect(activity).not.toBeNull();
    expect(activity?.id).toBe('l-rank-confirmed');
  });
});
