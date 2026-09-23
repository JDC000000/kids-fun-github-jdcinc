// tests/search/catalogue-cache-bust-route.test.ts — POST /api/admin/catalogue-cache/bust, the
// manual bust that lets an urgent correction skip the shared catalogue cache's 6 h / 24 h cycle.
//
// UNIT lane: the database seam is a stub pool, the shared store is the in-memory double of
// unstable_cache (whose invalidate() stands in for revalidateTag), and the admin session resolver is
// stubbed. The route, the repository and the cache are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown as import('./__support__/catalogue-cache-fakes').StubCatalogPool,
  store: null as unknown as import('./__support__/catalogue-cache-fakes').FakeSharedStore,
  sessionAdmin: null as null | { userId: string },
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => state.db.pool,
  query: async () => {
    throw new Error('catalogue-cache-bust-route: unexpected direct query');
  },
  closePool: async () => {},
}));
vi.mock('@/lib/search/next-data-cache-store', () => ({
  nextDataCacheStore: {
    memo: (key: readonly string[], ttlMs: number, compute: () => Promise<unknown>) => {
      state.store.now = Date.now();
      return state.store.memo(key, ttlMs, compute);
    },
    invalidate: () => state.store.invalidate(),
  },
}));
const resolveSessionAdmin = vi.hoisted(() => vi.fn(async () => state.sessionAdmin));
vi.mock('@/app/admin/_lib/gate', () => ({ resolveSessionAdmin }));

import * as route from '@/app/api/admin/catalogue-cache/bust/route';
import { clearPostgresListingsCache, getCachedPostgresListings } from '@/lib/search/postgres-repository';
import { catalogueRows, createFakeSharedStore, createStubCatalogPool } from './__support__/catalogue-cache-fakes';

const SECRET = 'bust-secret-for-tests-only-0123456789';
const NOW = Date.UTC(2026, 8, 25, 17, 0);

function post(headers: Record<string, string> = {}): Request {
  return new Request('https://kidsfun.example/api/admin/catalogue-cache/bust', { method: 'POST', headers });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.db = createStubCatalogPool(catalogueRows(NOW));
  state.store = createFakeSharedStore();
  state.sessionAdmin = null;
  resolveSessionAdmin.mockClear();
  process.env.CATALOGUE_CACHE_BUST_SECRET = SECRET;
  delete process.env.KIDS_FUN_CATALOGUE_SHARED_CACHE;
  clearPostgresListingsCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.CATALOGUE_CACHE_BUST_SECRET;
  delete process.env.KIDS_FUN_CATALOGUE_SHARED_CACHE;
  clearPostgresListingsCache();
});

describe('POST /api/admin/catalogue-cache/bust — auth', () => {
  it('refuses an anonymous caller, and busts nothing', async () => {
    const res = await route.POST(post());
    expect(res.status).toBe(401);
    expect(state.store.invalidations).toBe(0);
  });

  it('accepts the bearer secret', async () => {
    const res = await route.POST(post({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, busted: true, sharedCacheEnabled: true, propagatesWithinMs: 120_000 });
    expect(state.store.invalidations).toBe(1);
  });

  it('accepts the secret as x-cron-secret too (the repo\'s other operator endpoints do)', async () => {
    expect((await route.POST(post({ 'x-cron-secret': SECRET }))).status).toBe(200);
  });

  it('a WRONG secret is a 401 even for a signed-in admin — the session is not consulted', async () => {
    state.sessionAdmin = { userId: 'admin-1' };
    const res = await route.POST(post({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(resolveSessionAdmin).not.toHaveBeenCalled();
    expect(state.store.invalidations).toBe(0);
  });

  it('accepts a signed-in admin session when no secret is presented', async () => {
    state.sessionAdmin = { userId: 'admin-1' };
    expect((await route.POST(post())).status).toBe(200);
    expect(state.store.invalidations).toBe(1);
  });

  it('with no secret configured, a presented secret can never match', async () => {
    delete process.env.CATALOGUE_CACHE_BUST_SECRET;
    expect((await route.POST(post({ authorization: 'Bearer ' }))).status).toBe(401);
    expect((await route.POST(post({ authorization: 'Bearer undefined' }))).status).toBe(401);
  });

  it('is POST-only', () => {
    expect(Object.keys(route)).not.toContain('GET');
  });
});

describe('POST /api/admin/catalogue-cache/bust — behaviour', () => {
  it('end to end: after a correction and a bust, the next read serves the corrected catalogue', async () => {
    const before = await getCachedPostgresListings(state.db.pool);
    expect(before.some((l) => l.id.endsWith('5'))).toBe(true);

    state.db.rows = state.db.rows.filter((r) => !r.id.endsWith('5')); // the listing is taken down
    expect((await getCachedPostgresListings(state.db.pool)).some((l) => l.id.endsWith('5'))).toBe(true); // cached

    expect((await route.POST(post({ authorization: `Bearer ${SECRET}` }))).status).toBe(200);
    expect((await getCachedPostgresListings(state.db.pool)).some((l) => l.id.endsWith('5'))).toBe(false);
  });

  it('a failing store is reported as a 500, never as a successful bust', async () => {
    state.store.failWith = new Error('data cache down');
    const res = await route.POST(post({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it('with the kill switch on, it says so and reports the per-instance TTL as the real bound', async () => {
    process.env.KIDS_FUN_CATALOGUE_SHARED_CACHE = 'off';
    const body = await (await route.POST(post({ authorization: `Bearer ${SECRET}` }))).json();
    expect(body).toMatchObject({ ok: true, sharedCacheEnabled: false, propagatesWithinMs: 600_000 });
  });
});
