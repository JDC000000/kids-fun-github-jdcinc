// tests/search/catalogue-cache-callers.test.ts — every surface that reads the cached catalogue
// receives the SAME ListingRecord[] through the shared catalogue cache as through the direct load,
// and produces the same output (egress Thread 3, Options B + C).
//
// The shared cache is implemented entirely inside `getCachedPostgresListings`, so that no caller
// has to change. This file holds that claim to account at the callers themselves. There are six:
//   1. /api/search                         app/api/search/route.ts        (calls it directly)
//   2. the homepage's three picks          app/_components/ThreeThings.tsx ┐
//   3. /account (saved-search empty lines) app/account/page.tsx           │ through
//   4. /sms/signup (sparse-area warning)   app/sms/signup/page.tsx        │ lib/search/
//   5. /api/sms/instant-picks              app/api/sms/instant-picks/route.ts │ server-engine.ts
//   6. the sparse-area measurement         lib/sms/sparse-measure.ts      ┘ (/sms/start, /api/sms/waitlist)
//
// Each caller is driven for real, in three modes, and must behave identically in all three:
//   · SHARED, WARM          — this instance already holds the snapshot;
//   · SHARED, COLD INSTANCE — a fresh module registry (a new Vercel instance) whose only source is
//                             the shared store another instance published to;
//   · KILL SWITCH           — KIDS_FUN_CATALOGUE_SHARED_CACHE=off, i.e. the pre-existing direct load.
// In each mode the array the caller hands to the engine (captured at InMemoryListingRepository) is
// compared byte-for-byte and structurally with a direct load, and the caller's own output is
// compared across the modes.
//
// UNIT lane: the database seam is mocked (a stub pool that answers the catalogue load and the
// version probe), the shared store is an in-memory double of unstable_cache, and the alias/region
// loaders use the fixture dictionaries. Everything between the pool and the caller is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListingRecord } from '@/lib/search/types';

const state = vi.hoisted(() => ({
  db: null as unknown as import('./__support__/catalogue-cache-fakes').StubCatalogPool,
  store: null as unknown as import('./__support__/catalogue-cache-fakes').FakeSharedStore,
  /** Every array handed to `new InMemoryListingRepository(...)`, in order. */
  captured: [] as Array<readonly ListingRecord[]>,
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => state.db.pool,
  query: async () => {
    throw new Error('catalogue-cache-callers: unexpected direct query');
  },
  closePool: async () => {},
}));
vi.mock('@/lib/search/next-data-cache-store', () => ({
  nextDataCacheStore: {
    memo: (key: readonly string[], ttlMs: number, compute: () => Promise<unknown>) => {
      state.store.now = Date.now();
      return state.store.memo(key, ttlMs, compute);
    },
  },
}));
vi.mock('@/lib/search/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/search/repository')>();
  class CapturingRepository extends actual.InMemoryListingRepository {
    constructor(listings: readonly ListingRecord[]) {
      super(listings);
      state.captured.push(listings);
    }
  }
  return { ...actual, InMemoryListingRepository: CapturingRepository };
});
vi.mock('@/lib/search/postgres-alias-resolver', async () => {
  const { FixtureAliasResolver } = await import('@/lib/search/expand');
  const { ALIAS_SEED } = await import('@/lib/search/__fixtures__/aliases');
  return { getPostgresAliasResolver: async () => new FixtureAliasResolver(ALIAS_SEED) };
});
vi.mock('@/lib/search/postgres-region-hierarchy', async () => {
  const { RegionHierarchy } = await import('@/lib/geo/region');
  const { REGIONS } = await import('@/lib/search/__fixtures__/regions');
  return { getPostgresRegionHierarchy: async () => new RegionHierarchy(REGIONS) };
});

// /account: the page is gated off in production (Google sign-in disabled), but its engine call is
// the surface under test, so the gate and the user's own data are stubbed open.
vi.mock('@/lib/auth/google-signin-gate', () => ({ GOOGLE_SIGN_IN_ENABLED: true }));
vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: async () => ({ userId: 'user-1', email: 'parent@example.org' }),
}));
vi.mock('@/lib/db/user-profile', () => ({
  getUserProfile: async () => ({ home_postal: 'V6B 1A1', email_opt_in: false }),
  ensureUserProfile: async () => ({ profile: null }),
}));
vi.mock('@/lib/db/saved-search', () => ({
  listSavedSearches: async () => [
    { id: 'ss-1', name: 'Storytime', params: { q: 'storytime' }, created_at: '2026-09-01T00:00:00Z', last_run_at: null },
    { id: 'ss-2', name: 'Robotics', params: { q: 'robotics club' }, created_at: '2026-09-01T00:00:00Z', last_run_at: null },
  ],
}));

// /api/sms/instant-picks: the subscriber lookup, throttle and send are stubbed; the engine and the
// pick selection (selectInstantPicks) are real, so the response is computed from the catalogue.
vi.mock('@/lib/sms/instant-picks-store', () => ({
  findInstantPicksSubscriber: async () => ({
    outcome: 'found',
    subscriberId: '11111111-2222-3333-4444-555555555555',
    subscriber: { postalCode: 'V6B 1A1', birthYears: [2021] },
  }),
}));
vi.mock('@/lib/sms/instant-picks-throttle', () => ({
  checkAndRecordInstantPicks: async () => ({ allowed: true, reason: null, retryAfterSeconds: 0, degraded: false }),
}));
vi.mock('@/lib/sms/instant-picks-send', () => ({
  sendInstantPicksText: async () => ({ status: 'not_eligible', segments: 0, degraded: false }),
}));
vi.mock('@/lib/sms/send-log', () => ({ recordSmsSend: async () => {} }));
vi.mock('@/lib/observability/route-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/observability/route-handler')>()),
  captureAndFlush: async () => {},
}));

/** Friday 10:00 Vancouver time: a real weekday morning, with a weekend ahead for the picks. */
const NOW = Date.UTC(2026, 8, 25, 17, 0);

/** A stable, comparable rendering of whatever a caller produced (JSON, or a React element tree). */
function signature(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === 'function' ? `ƒ ${v.name}` : typeof v === 'symbol' ? v.toString() : v
  );
}

/**
 * [name, prepare]: `prepare` imports the caller's module (whose module-level setup — e.g. the
 * search route's fixture engine for non-database mode — is not the surface under test) and returns
 * the call itself.
 */
type Caller = [name: string, prepare: () => Promise<() => Promise<unknown>>];

const CALLERS: Caller[] = [
  [
    '/api/search',
    async () => {
      const { GET } = await import('@/app/api/search/route');
      return async () => {
        const res = await GET(new Request('http://localhost/api/search?q=&limit=50&region=van,nvan,wvan,bby,rmd'));
        return { status: res.status, body: await res.json() };
      };
    },
  ],
  [
    'homepage ThreeThings',
    async () => {
      const { ThreeThings } = await import('@/app/_components/ThreeThings');
      return () => ThreeThings();
    },
  ],
  [
    '/account',
    async () => {
      const { default: AccountPage } = await import('@/app/account/page');
      return () => AccountPage();
    },
  ],
  [
    '/sms/signup',
    async () => {
      const { default: SmsSignupPage } = await import('@/app/sms/signup/page');
      return () => SmsSignupPage();
    },
  ],
  [
    '/api/sms/instant-picks',
    async () => {
      const { POST } = await import('@/app/api/sms/instant-picks/route');
      return async () => {
        const res = await POST(
          new Request('https://kidsfun.example/api/sms/instant-picks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'a'.repeat(43) }),
          })
        );
        return { status: res.status, body: await res.json() };
      };
    },
  ],
  [
    'sparse-area measure (lib/sms/sparse-measure.ts)',
    async () => {
      const { measureSparseRegionIds } = await import('@/lib/sms/sparse-measure');
      return () => measureSparseRegionIds();
    },
  ],
];

interface ModeResult {
  listings: readonly ListingRecord[];
  output: string;
  loads: number;
  probes: number;
}

/** Run one caller in a FRESH module registry (a new instance), capturing what reached the engine. */
async function runInFreshInstance(prepare: Caller[1], warm: boolean): Promise<ModeResult> {
  vi.resetModules();
  const run = await prepare();
  if (warm) {
    const repo = await import('@/lib/search/postgres-repository');
    await repo.getCachedPostgresListings(state.db.pool);
  }
  const before = { ...state.db.counts };
  state.captured.length = 0;
  const output = signature(await run());
  expect(state.captured).toHaveLength(1); // the caller built exactly one engine, over the catalogue
  return {
    listings: state.captured[0],
    output,
    loads: state.db.counts.loads - before.loads,
    probes: state.db.counts.probes - before.probes,
  };
}

async function directLoad(): Promise<ListingRecord[]> {
  const { loadPostgresListings } = await import('@/lib/search/postgres-repository');
  const { pruneEndedOccurrences } = await import('@/lib/search/occurrence-visibility');
  const loads = state.db.counts.loads;
  const rows = pruneEndedOccurrences(await loadPostgresListings(state.db.pool), new Date(NOW));
  state.db.counts.loads = loads;
  return rows;
}

function expectSameRecords(actual: readonly ListingRecord[], expected: readonly ListingRecord[]): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual).toStrictEqual(expected);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  process.env.KIDS_FUN_SEARCH_BACKEND = 'database';
  process.env.SMS_SIGNUP_ENABLED = 'true';
  delete process.env.KIDS_FUN_CATALOGUE_SHARED_CACHE;
  const fakes = await import('./__support__/catalogue-cache-fakes');
  state.db = fakes.createStubCatalogPool(fakes.catalogueRows(NOW));
  state.store = fakes.createFakeSharedStore();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.KIDS_FUN_SEARCH_BACKEND;
  delete process.env.SMS_SIGNUP_ENABLED;
  delete process.env.KIDS_FUN_CATALOGUE_SHARED_CACHE;
});

describe.each(CALLERS)('%s', (_name, prepare) => {
  it('receives byte-identical records, and produces identical output, with the shared cache warm, cold, and switched off', async () => {
    const expected = await directLoad();

    // SHARED, WARM: this instance published the snapshot, then served the caller from memory.
    const warm = await runInFreshInstance(prepare, true);
    expectSameRecords(warm.listings, expected);
    expect(warm.loads).toBe(0);
    expect(warm.probes).toBe(0);

    // SHARED, COLD INSTANCE: a new registry whose only copy is the one in the shared store.
    const cold = await runInFreshInstance(prepare, false);
    expectSameRecords(cold.listings, expected);
    expect(cold.loads).toBe(0); // the egress claim, per surface: no catalogue load on a cold start
    expect(cold.probes).toBe(0);

    // KILL SWITCH: the pre-existing direct-load path.
    process.env.KIDS_FUN_CATALOGUE_SHARED_CACHE = 'off';
    const off = await runInFreshInstance(prepare, false);
    expectSameRecords(off.listings, expected);
    expect(off.loads).toBe(1);
    expect(off.probes).toBe(0);

    expect(cold.output).toBe(warm.output);
    expect(off.output).toBe(warm.output);
  });
});

// "Identical in every mode" would also hold for a caller that silently failed to build its engine
// in every mode — each of these callers degrades quietly by design ("could not check" is not an
// error page). So each output is also checked for the mark of a REAL answer from the catalogue.
describe('the callers are exercised, not vacuous', () => {
  const outputOf = async (i: number) => JSON.parse((await runInFreshInstance(CALLERS[i][1], true)).output);

  it('the catalogue reaching them is non-trivial', async () => {
    expect((await directLoad()).length).toBeGreaterThanOrEqual(5);
  });

  it('/api/search answers from the database catalogue', async () => {
    const { status, body } = await outputOf(0);
    expect(status).toBe(200);
    expect(body.meta.backend).toBe('database');
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('/api/sms/instant-picks computed picks rather than "unavailable"', async () => {
    const { status, body } = await outputOf(4);
    expect(status).toBe(200);
    expect(body.outcome).not.toBe('unavailable');
  });

  it('the sparse-area measure MEASURED rather than falling back to its static list', async () => {
    expect((await outputOf(5)).measured).toBe(true);
  });
});
