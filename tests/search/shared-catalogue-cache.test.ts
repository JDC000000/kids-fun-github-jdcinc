// tests/search/shared-catalogue-cache.test.ts — the shared, version-gated catalogue cache
// (lib/search/shared-catalogue-cache.ts; egress Thread 3, Options B + C).
//
// UNIT lane: the pool is a stub that answers the catalogue load and the version probe, and the
// shared store is an in-memory double of `unstable_cache` that stores JSON exactly as Next does.
// Real code everywhere else: the real loadPostgresListings/rowToListing mapping, the real probe
// function, the real TTL cache as the fallback, the real codec.
//
// What is pinned, by section:
//   1. OUTPUT PARITY — the shared path returns records byte-identical to the direct load, cold,
//      warm, and read by a second instance that never touched the database.
//   2. EGRESS — what the cache is for: one probe and one load per content version per epoch,
//      across instances; warm instances cost nothing; unchanged content never reloads.
//   3. STALENESS BOUNDS — content changes arrive by the next probe; the freshness floor forces a
//      reload every epoch; ended occurrences leave at once.
//   4. SAFETY — kill switch, and every failure mode falling back to the direct load with
//      identical output.
//   5. CONFIGURATION — env parsing for the knobs.
//   6. JON'S PARAMETERS AND THE MANUAL BUST — the 6 h probe / 24 h floor defaults as they behave,
//      and the bust that lets an urgent correction skip them.
//
// Sections 1-4 run at an explicit SHORT configuration (5 min probe and re-check, 60 min floor): the
// mechanics are scale-free, and hour-long scenarios are easier to read at that scale. Section 6
// runs at the real defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  CATALOGUE_FLOOR_DEFAULT_MS,
  CATALOGUE_PROBE_DEFAULT_MS,
  CATALOGUE_PROBE_MIN_MS,
  CATALOGUE_RECHECK_DEFAULT_MS,
  FRESHNESS_FLOOR_ENV,
  PROBE_INTERVAL_ENV,
  RECHECK_INTERVAL_ENV,
  SHARED_CACHE_ENV,
  SharedCatalogueCache,
  catalogueFreshnessFloorMs,
  catalogueProbeIntervalMs,
  catalogueRecheckIntervalMs,
  resetSharedCatalogueCacheWarnings,
  sharedCatalogueCacheEnabled,
} from '../../lib/search/shared-catalogue-cache';
import {
  LISTING_CACHE_DEFAULT_MS,
  clearPostgresListingsCache,
  getCachedPostgresListings,
  loadPostgresListings,
  probePostgresCatalogueVersion,
} from '../../lib/search/postgres-repository';
import { pruneEndedOccurrences } from '../../lib/search/occurrence-visibility';
import { TtlPromiseCache, resetCacheTtlWarnings } from '../../lib/search/ttl-cache';
import type { ListingRecord } from '../../lib/search/types';
import {
  ENDING_SOON_ID,
  catalogueRows,
  createFakeSharedStore,
  createStubCatalogPool,
  type FakeSharedStore,
  type StubCatalogPool,
} from './__support__/catalogue-cache-fakes';

const MIN = 60_000;
/** The short mechanics configuration of sections 1-4 (see header). */
const PROBE = 5 * 60_000;
const FLOOR = 60 * 60_000;
const HOUR = 60 * MIN;
/** 10:05 UTC — five minutes into a floor epoch, so "the same epoch" has room on both sides. */
const T0 = Date.UTC(2026, 8, 24, 10, 5);
const EPOCH_END = Date.UTC(2026, 8, 24, 11, 0);

const ENV_VARS = [SHARED_CACHE_ENV, PROBE_INTERVAL_ENV, FRESHNESS_FLOOR_ENV, RECHECK_INTERVAL_ENV, 'KIDS_FUN_LISTING_CACHE_MS'];

/** Sections 1-4: probe and re-check every 5 minutes, floor 60 minutes. */
function useShortConfig(): void {
  process.env[PROBE_INTERVAL_ENV] = String(PROBE);
  process.env[RECHECK_INTERVAL_ENV] = String(PROBE);
  process.env[FRESHNESS_FLOOR_ENV] = String(FLOOR);
}

/** Section 5-6: nothing set, i.e. production's defaults. */
function useDefaults(): void {
  for (const v of ENV_VARS) delete process.env[v];
}

interface Harness {
  cache: SharedCatalogueCache;
  store: FakeSharedStore;
  db: StubCatalogPool;
  pool: Pool;
  legacyCalls: { count: number };
  /** Read through the cache at `now`, moving the shared store's clock with it. */
  at(now: number): Promise<readonly ListingRecord[]>;
}

/** One app instance: its own cache, the given shared store and database. */
function instance(store: FakeSharedStore, db: StubCatalogPool, random = () => 0): Harness {
  const ttl = new TtlPromiseCache<readonly ListingRecord[]>('KIDS_FUN_LISTING_CACHE_MS', LISTING_CACHE_DEFAULT_MS);
  const legacyCalls = { count: 0 };
  const cache = new SharedCatalogueCache({
    store,
    legacy: {
      get: (pool, now) => {
        legacyCalls.count += 1;
        return ttl.get(async () => Object.freeze(await loadPostgresListings(pool)), now);
      },
      clear: () => ttl.clear(),
    },
    loadListings: loadPostgresListings,
    probeVersion: probePostgresCatalogueVersion,
    random,
  });
  return {
    cache,
    store,
    db,
    pool: db.pool,
    legacyCalls,
    at: (now) => {
      store.now = now;
      return cache.get(db.pool, now);
    },
  };
}

function fresh(random = () => 0): Harness {
  return instance(createFakeSharedStore(), createStubCatalogPool(catalogueRows(T0)), random);
}

/** What a direct, uncached load would return at `now` — the parity oracle for every test. */
async function directAt(db: StubCatalogPool, now: number): Promise<ListingRecord[]> {
  const loads = db.counts.loads;
  const rows = pruneEndedOccurrences(await loadPostgresListings(db.pool), new Date(now));
  db.counts.loads = loads; // the oracle's own load is not the cache's
  return rows;
}

/** Byte-identical AND structurally identical (key presence, undefined vs missing, array order). */
function expectSameRecords(actual: readonly ListingRecord[], expected: readonly ListingRecord[]): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual).toStrictEqual(expected);
}

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
  useShortConfig();
  resetSharedCatalogueCacheWarnings();
  resetCacheTtlWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
  vi.restoreAllMocks();
  clearPostgresListingsCache();
});

describe('1. output parity with the direct load', () => {
  it('a cold instance returns exactly what the direct load returns, as a frozen array', async () => {
    const h = fresh();
    const out = await h.at(T0);

    expectSameRecords(out, await directAt(h.db, T0));
    expect(Object.isFrozen(out)).toBe(true);
    expect(h.legacyCalls.count).toBe(0); // served by the shared path, not the fallback
  });

  it('a second instance reads the snapshot from the shared store — identical records, zero database work', async () => {
    const a = fresh();
    await a.at(T0);
    const loadsBefore = a.db.counts.loads;
    const probesBefore = a.db.counts.probes;

    const b = instance(a.store, a.db); // a cold start: new process, same shared store, same database
    const out = await b.at(T0 + 1_000);

    expectSameRecords(out, await directAt(a.db, T0 + 1_000));
    expect(a.db.counts.loads).toBe(loadsBefore);
    expect(a.db.counts.probes).toBe(probesBefore);
  });

  it('the kill-switch path and the shared path return byte-identical records', async () => {
    const shared = await fresh().at(T0);
    process.env[SHARED_CACHE_ENV] = 'off';
    const h = fresh();
    const legacy = await h.at(T0);

    expect(h.legacyCalls.count).toBe(1);
    expect(h.store.stats.computes).toBe(0);
    expectSameRecords(legacy, shared);
  });

  it('preserves every field of the real mapping: nulls, trimmed text, numeric coercions, derived tags', async () => {
    const out = await fresh().at(T0);
    const storytime = out.find((l) => l.id.endsWith('1'))!;
    expect(storytime.ageNotes).toBe('Ages 0-5 with a caregiver'); // cleanText ran before encoding
    expect(storytime.venuePhone).toBe('604-331-3603');
    const swim = out.find((l) => l.id.endsWith('2'))!;
    expect(swim.costMinCad).toBe(6.1); // numeric string → number survived the round trip
    expect(swim.lastCheckedAtUtc).toBeNull();
    expect(swim.registrationRequired).toBe(false); // false, not null — the tri-state survives
    const gym = out.find((l) => l.id === ENDING_SOON_ID)!;
    expect(gym.geo).toEqual({ lat: 49.2257, lng: -122.996 });
    expect(gym.ageBandMatches).toEqual(['2-4']); // the invalid band was filtered before encoding
  });
});

describe('2. egress: what the cache exists to remove', () => {
  it('a cold instance costs one probe and one load, and a warm one costs nothing', async () => {
    const h = fresh();
    const first = await h.at(T0);
    expect(h.db.counts).toMatchObject({ probes: 1, loads: 1 });
    expect(info).toHaveBeenCalledTimes(1); // one "published catalogue snapshot" line per full load

    const computes = h.store.stats.computes;
    const hits = h.store.stats.hits;
    for (let t = T0; t < T0 + PROBE; t += 30_000) {
      expect(await h.at(t)).toBe(first); // same array: no decode, and the matcher's memo stays warm
    }
    expect(h.db.counts).toMatchObject({ probes: 1, loads: 1 });
    expect(h.store.stats.computes).toBe(computes);
    expect(h.store.stats.hits).toBe(hits); // not even a shared-store read inside the interval
  });

  it('re-checks the version once per probe interval and does NOT reload unchanged content', async () => {
    const h = fresh();
    const first = await h.at(T0);

    const later = await h.at(T0 + PROBE);
    expect(h.db.counts.probes).toBe(2); // the version was re-derived…
    expect(h.db.counts.loads).toBe(1); // …and the unchanged catalogue was not re-shipped
    expect(later).toBe(first);
  });

  it('ignores a crawl that only bumps last_checked_at', async () => {
    const h = fresh();
    await h.at(T0);
    h.db.rows = h.db.rows.map((r) => ({ ...r, last_checked_at: new Date(T0).toISOString() }));

    await h.at(T0 + PROBE);
    expect(h.db.counts.loads).toBe(1);
  });

  it('twenty concurrent cold callers on one instance share one probe and one load', async () => {
    const h = fresh();
    h.store.now = T0;
    const results = await Promise.all(Array.from({ length: 20 }, () => h.cache.get(h.pool, T0)));
    expect(h.db.counts).toMatchObject({ probes: 1, loads: 1 });
    for (const r of results) expect(r).toBe(results[0]);
  });

  it('many instances in one epoch pay for ONE load between them', async () => {
    const store = createFakeSharedStore();
    const db = createStubCatalogPool(catalogueRows(T0));
    for (let i = 0; i < 8; i += 1) await instance(store, db, () => i / 8).at(T0 + i * 1_000);
    expect(db.counts.loads).toBe(1);
    expect(db.counts.probes).toBe(1);
  });

  // The store has no cross-instance lock (neither has unstable_cache): instances that miss the
  // same key AT THE SAME TIME each load. So every tick below sends one request to every instance
  // CONCURRENTLY — the production shape — and the test is whether they still pay for one load.
  async function crossFloorBoundary(random: (i: number) => number): Promise<StubCatalogPool> {
    const store = createFakeSharedStore();
    const db = createStubCatalogPool(catalogueRows(T0));
    const fleet = Array.from({ length: 5 }, (_, i) => instance(store, db, () => random(i)));
    await Promise.all(fleet.map((h) => h.at(T0)));
    db.counts.loads = 0;
    for (let t = EPOCH_END - MIN; t <= EPOCH_END + PROBE + MIN; t += 15_000) {
      await Promise.all(fleet.map((h) => h.at(t)));
    }
    return db;
  }

  it('across a floor boundary, jittered instances do not all reload together', async () => {
    // Offsets spread across the probe interval, as `Math.random()` spreads them in production:
    // the earliest instance reloads and publishes; the rest cross later and find it published.
    const db = await crossFloorBoundary((i) => i / 5);
    expect(db.counts.loads).toBe(1);
  });

  it('a late-jittered instance cold-starting at the very end of its epoch reuses the snapshot (no stale-while-revalidate reload)', async () => {
    const store = createFakeSharedStore();
    store.staleWhileRevalidate = true; // Next's App Router behaviour past an entry's TTL
    const db = createStubCatalogPool(catalogueRows(T0));
    const epochStart = Date.UTC(2026, 8, 24, 10, 0);
    await instance(store, db, () => 0).at(epochStart); // publishes at the first instant of the epoch

    // Jitter ~4.95 min: at 11:04:30 this instance is still in the 10:00 epoch, and the snapshot it
    // needs is 64.5 minutes old — older than one floor, but still inside its key's lifetime.
    const late = instance(store, db, () => 0.99);
    await late.at(Date.UTC(2026, 8, 24, 11, 4, 30));
    await store.settle();
    expect(late.legacyCalls.count).toBe(0);
    expect(db.counts.loads).toBe(1);
  });

  it('control: WITHOUT jitter the same fleet reloads once per instance (what the jitter prevents)', async () => {
    const db = await crossFloorBoundary(() => 0);
    expect(db.counts.loads).toBe(5);
  });
});

describe('3. staleness bounds', () => {
  it('a content change reaches the instance at its next probe', async () => {
    const h = fresh();
    await h.at(T0);
    h.db.rows = h.db.rows.map((r) => (r.id.endsWith('1') ? { ...r, activity_name: 'Family Storytime (moved)' } : r));

    const before = await h.at(T0 + PROBE - 1);
    expect(before.find((l) => l.id.endsWith('1'))!.activityName).toBe('Family Storytime');

    const after = await h.at(T0 + PROBE);
    expect(after.find((l) => l.id.endsWith('1'))!.activityName).toBe('Family Storytime (moved)');
    expect(h.db.counts.loads).toBe(2);
    expectSameRecords(after, await directAt(h.db, T0 + PROBE));
  });

  it('a listing hidden or removed disappears at the next probe', async () => {
    const h = fresh();
    await h.at(T0);
    h.db.rows = h.db.rows.filter((r) => !r.id.endsWith('5'));

    const after = await h.at(T0 + PROBE);
    expect(after.some((l) => l.id.endsWith('5'))).toBe(false);
  });

  it('with a stale-while-revalidate store, content still arrives within two probe intervals', async () => {
    const h = fresh();
    h.store.staleWhileRevalidate = true;
    await h.at(T0);
    h.db.rows = h.db.rows.map((r) => (r.id.endsWith('4') ? { ...r, cost_min_cad: 20 } : r));

    await h.at(T0 + PROBE); // served the stale version once; the store refreshes in the background
    await h.store.settle();
    const out = await h.at(T0 + 2 * PROBE);
    expect(out.find((l) => l.id.endsWith('4'))!.costMinCad).toBe(20);
  });

  it('the freshness floor reloads unchanged content once per epoch (so "checked X ago" stays honest)', async () => {
    const h = fresh();
    await h.at(T0);
    const bumped = new Date(T0 + 30 * MIN).toISOString();
    h.db.rows = h.db.rows.map((r) => ({ ...r, last_checked_at: bumped })); // content unchanged

    const sameEpoch = await h.at(EPOCH_END - 1);
    expect(h.db.counts.loads).toBe(1);
    expect(sameEpoch.find((l) => l.id.endsWith('1'))!.lastCheckedAtUtc).not.toBe(bumped);

    const nextEpoch = await h.at(EPOCH_END);
    expect(h.db.counts.loads).toBe(2);
    expect(nextEpoch.find((l) => l.id.endsWith('1'))!.lastCheckedAtUtc).toBe(bumped);
  });

  it('probes with the epoch start as the visibility cut-off — fixed within an epoch, never after a request', async () => {
    const h = fresh();
    await h.at(T0);
    await h.at(T0 + PROBE);
    await h.at(EPOCH_END + 1);
    expect(h.db.probeCutoffs).toEqual([
      new Date(Date.UTC(2026, 8, 24, 10, 0)).toISOString(),
      new Date(Date.UTC(2026, 8, 24, 10, 0)).toISOString(),
      new Date(EPOCH_END).toISOString(),
    ]);
  });

  it('drops an occurrence the moment it ends, without a reload, and keeps array identity between endings', async () => {
    const h = fresh();
    const endsAt = Date.parse(catalogueRows(T0).find((r) => r.id === ENDING_SOON_ID)!.end_datetime_utc as string);

    const before = await h.at(endsAt);
    expect(before.some((l) => l.id === ENDING_SOON_ID)).toBe(true); // `>=`: visible AT its end, as in SQL

    const after = await h.at(endsAt + 1);
    expect(after.some((l) => l.id === ENDING_SOON_ID)).toBe(false);
    expect(Object.isFrozen(after)).toBe(true);
    expectSameRecords(after, await directAt(h.db, endsAt + 1));
    expect(await h.at(endsAt + 60_000)).toBe(after); // nothing else ended: same array
    expect(h.db.counts.loads).toBe(1);
  });

  it('a backwards clock step re-prunes from the full snapshot instead of pinning the pruned view', async () => {
    const h = fresh();
    const endsAt = Date.parse(catalogueRows(T0).find((r) => r.id === ENDING_SOON_ID)!.end_datetime_utc as string);
    await h.at(endsAt + 1);
    const back = await h.at(endsAt - 1_000);
    expect(back.some((l) => l.id === ENDING_SOON_ID)).toBe(true);
  });
});

describe('4. safety: kill switch and fallback', () => {
  it.each(['off', 'OFF', 'false', '0', ' off '])('KIDS_FUN_CATALOGUE_SHARED_CACHE=%j uses only the direct-load path', async (value) => {
    process.env[SHARED_CACHE_ENV] = value;
    const h = fresh();
    const out = await h.at(T0);
    await h.at(T0 + 1_000);

    expect(h.store.stats.hits + h.store.stats.misses).toBe(0);
    expect(h.db.counts.probes).toBe(0);
    expect(h.db.counts.loads).toBe(1); // the per-instance TTL cache still works
    expectSameRecords(out, await directAt(h.db, T0));
  });

  it('an unrecognised kill-switch value fails SAFE (off), with one warning', async () => {
    process.env[SHARED_CACHE_ENV] = 'maybe';
    const h = fresh();
    await h.at(T0);
    await h.at(T0 + 1);
    expect(h.store.stats.hits + h.store.stats.misses).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('switching off drops the shared snapshot; switching back on starts from the store again', async () => {
    const h = fresh();
    await h.at(T0);
    process.env[SHARED_CACHE_ENV] = 'off';
    await h.at(T0 + 1_000);
    expect(h.legacyCalls.count).toBe(1);
    delete process.env[SHARED_CACHE_ENV];
    const hits = h.store.stats.hits;
    await h.at(T0 + 2_000);
    expect(h.store.stats.hits).toBeGreaterThan(hits); // re-read, not served from the dropped copy
  });

  it('a store outage falls back to the direct load with identical output, backs off, then recovers', async () => {
    const h = fresh();
    h.store.failWith = new Error('ECONNRESET data cache');
    const out = await h.at(T0);

    expect(h.legacyCalls.count).toBe(1);
    expectSameRecords(out, await directAt(h.db, T0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ECONNRESET');

    // Inside the back-off window the shared store is not retried at all.
    h.store.failWith = null;
    await h.at(T0 + PROBE - 1);
    expect(h.store.stats.misses).toBe(0);
    expect(h.legacyCalls.count).toBe(2);

    // After it, the shared path resumes, and the legacy copy is released.
    const recovered = await h.at(T0 + PROBE);
    expect(h.store.stats.misses).toBeGreaterThan(0);
    expect(h.legacyCalls.count).toBe(2);
    expectSameRecords(recovered, await directAt(h.db, T0 + PROBE));
  });

  it('recovering releases the fallback copy, so a LATER fallback reloads instead of serving an older catalogue', async () => {
    // QA 83c6: without `legacy.clear()` on the shared path, a second outage inside the per-instance
    // TTL served the catalogue from BEFORE the first recovery: older than what was just being
    // served. That mutation survived the suite.
    process.env.KIDS_FUN_LISTING_CACHE_MS = String(60 * MIN); // a legacy TTL that outlives the scenario
    const h = fresh();
    h.store.failWith = new Error('data cache down');
    await h.at(T0); // fallback: the legacy layer loads the catalogue as it was
    h.store.failWith = null;
    await h.at(T0 + PROBE); // recovered: the shared path serves

    h.db.rows = h.db.rows.filter((r) => !r.id.endsWith('5')); // the listing is taken down
    h.store.failWith = new Error('data cache down again');
    const out = await h.at(T0 + 2 * PROBE); // second outage: fallback again

    expect(out.some((l) => l.id.endsWith('5'))).toBe(false);
    expectSameRecords(out, await directAt(h.db, T0 + 2 * PROBE));
  });

  it('logs a recurring failure once per reason, not once per request', async () => {
    const h = fresh();
    h.store.failWith = new Error('down');
    for (let i = 0; i < 5; i += 1) await h.at(T0 + i * PROBE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a failing version probe falls back', async () => {
    const h = fresh();
    h.db.failProbes = new Error('statement timeout');
    const out = await h.at(T0);
    expect(h.legacyCalls.count).toBe(1);
    expectSameRecords(out, await directAt(h.db, T0));
  });

  it('a failing snapshot load propagates exactly as the direct load would (no fake empty catalogue)', async () => {
    const h = fresh();
    h.db.failLoads = new Error('connection refused');
    await expect(h.at(T0)).rejects.toThrow('connection refused');
    expect(h.store.entries.size).toBe(1); // only the probe was stored; a failed load never is
  });

  const TAMPERINGS: Array<[string, (v: Record<string, unknown>) => unknown]> = [
    ['not an object', () => 'garbage'],
    ['unknown format', (v) => ({ ...v, format: 99 })],
    ['wrong version', (v) => ({ ...v, version: 'someone-else' })],
    ['row count mismatch', (v) => ({ ...v, count: (v.count as number) + 1 })],
    ['payload not brotli', (v) => ({ ...v, brotliBase64: Buffer.from('not brotli').toString('base64') })],
    ['payload missing', (v) => ({ ...v, brotliBase64: undefined })],
    ['publishedAt missing', (v) => ({ ...v, publishedAt: null })],
    ['published two epochs ago', (v) => ({ ...v, publishedAt: (v.publishedAt as number) - 2 * FLOOR - PROBE })],
    ['published in the future', (v) => ({ ...v, publishedAt: (v.publishedAt as number) + 10 * MIN })],
    ['oversize payload', (v) => ({ ...v, brotliBase64: 'A'.repeat(1_800_004) })],
  ];

  it.each(TAMPERINGS)('a snapshot that is %s is never served — the direct load is, identically', async (_label, edit) => {
    const writer = fresh();
    await writer.at(T0);
    expect(writer.store.tamper('snapshot', edit)).toBe(1);

    const reader = instance(writer.store, writer.db);
    const out = await reader.at(T0 + 1_000);
    expect(reader.legacyCalls.count).toBe(1);
    expectSameRecords(out, await directAt(writer.db, T0 + 1_000));
  });

  it('a snapshot that cannot round-trip through JSON is refused at publish time and never stored', async () => {
    const h = fresh();
    // A row the mapping turns into a value JSON would rewrite (lat → NaN).
    h.db.rows = h.db.rows.map((r) => (r.id.endsWith('5') ? { ...r, lat: 'not-a-number' } : r));
    const out = await h.at(T0);

    expect(h.legacyCalls.count).toBe(1);
    expect([...h.store.entries.keys()].some((k) => k.includes('snapshot'))).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain('JSON cannot carry exactly');
    expectSameRecords(out, await directAt(h.db, T0));
  });

  it('without a Next.js runtime (vitest, scripts) the real store is unavailable and the direct load serves', async () => {
    clearPostgresListingsCache();
    const db = createStubCatalogPool(catalogueRows(T0));
    const out = await getCachedPostgresListings(db.pool, T0);

    expectSameRecords(out, await directAt(db, T0));
    expect(db.counts.probes).toBe(0); // unstable_cache refused before the probe ran
    expect(String(warn.mock.calls[0][0])).toContain('incrementalCache missing');
  });
});

describe('5. configuration', () => {
  beforeEach(useDefaults);

  it("defaults (Jon, 2026-09-23): on, 6-hour probe, 24-hour floor, 1-minute store re-check", () => {
    expect(sharedCatalogueCacheEnabled()).toBe(true);
    expect(catalogueProbeIntervalMs()).toBe(6 * HOUR);
    expect(catalogueFreshnessFloorMs()).toBe(24 * HOUR);
    expect(catalogueRecheckIntervalMs()).toBe(MIN);
  });

  it('the re-check interval is tunable, floored, and never longer than the probe interval', () => {
    process.env[RECHECK_INTERVAL_ENV] = '0';
    expect(catalogueRecheckIntervalMs()).toBe(5_000);
    process.env[RECHECK_INTERVAL_ENV] = String(10 * HOUR);
    expect(catalogueRecheckIntervalMs()).toBe(6 * HOUR);
    process.env[PROBE_INTERVAL_ENV] = String(2 * MIN);
    expect(catalogueRecheckIntervalMs()).toBe(2 * MIN);
  });

  it.each(['on', 'ON', 'true', '1'])('%j turns it on', (value) => {
    process.env[SHARED_CACHE_ENV] = value;
    expect(sharedCatalogueCacheEnabled()).toBe(true);
  });

  it('the probe interval and floor are env-tunable', async () => {
    process.env[PROBE_INTERVAL_ENV] = String(2 * MIN);
    process.env[FRESHNESS_FLOOR_ENV] = String(30 * MIN);
    expect(catalogueProbeIntervalMs()).toBe(2 * MIN);
    expect(catalogueFreshnessFloorMs()).toBe(30 * MIN);

    const h = fresh();
    await h.at(T0);
    await h.at(T0 + 2 * MIN);
    expect(h.db.counts.probes).toBe(2);
    await h.at(Date.UTC(2026, 8, 24, 10, 30)); // the 30-minute floor's boundary
    expect(h.db.counts.loads).toBe(2);
  });

  it('refuses a probe interval that would make every request a catalogue scan', () => {
    process.env[PROBE_INTERVAL_ENV] = '0';
    expect(catalogueProbeIntervalMs()).toBe(CATALOGUE_PROBE_MIN_MS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a blank or unparseable value uses the default and warns', () => {
    process.env[PROBE_INTERVAL_ENV] = '';
    process.env[FRESHNESS_FLOOR_ENV] = 'an hour';
    expect(catalogueProbeIntervalMs()).toBe(CATALOGUE_PROBE_DEFAULT_MS);
    expect(catalogueFreshnessFloorMs()).toBe(CATALOGUE_FLOOR_DEFAULT_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("6. Jon's parameters (6 h probe, 24 h floor) and the manual bust", () => {
  beforeEach(useDefaults);

  const MIDNIGHT = Date.UTC(2026, 8, 25, 0, 0); // the first 24-hour epoch boundary after T0
  const rename = (h: Harness, name: string) => {
    h.db.rows = h.db.rows.map((r) => (r.id.endsWith('1') ? { ...r, activity_name: name } : r));
  };
  const nameAt = async (h: Harness, now: number) => (await h.at(now)).find((l) => l.id.endsWith('1'))!.activityName;

  it('a warm instance re-reads the shared version every minute, but the DATABASE probe runs once per 6 hours', async () => {
    const h = fresh();
    await h.at(T0);
    const hits = h.store.stats.hits;
    for (let t = T0 + 30_000; t < T0 + HOUR; t += 30_000) await h.at(t);
    expect(h.store.stats.hits - hits).toBeGreaterThanOrEqual(55); // ~one cheap store read a minute
    expect(h.db.counts).toMatchObject({ probes: 1, loads: 1 }); // and nothing at the database

    await h.at(T0 + 6 * HOUR);
    expect(h.db.counts).toMatchObject({ probes: 2, loads: 1 }); // re-derived; unchanged, so not reloaded
  });

  it('without a bust, a content change arrives within 6 hours plus ~2 re-checks (stale-while-revalidate store)', async () => {
    const h = fresh();
    h.store.staleWhileRevalidate = true;
    await h.at(T0);
    rename(h, 'Family Storytime (moved)');

    expect(await nameAt(h, T0 + 6 * HOUR - MIN)).toBe('Family Storytime');
    await h.at(T0 + 6 * HOUR); // the version entry has expired: served once more, refreshed behind
    await h.store.settle();
    expect(await nameAt(h, T0 + 6 * HOUR + 2 * MIN)).toBe('Family Storytime (moved)');
  });

  it('the 24-hour floor reloads unchanged content at the epoch boundary, not before', async () => {
    const h = fresh();
    await h.at(T0);
    for (let t = T0 + HOUR; t < MIDNIGHT; t += HOUR) await h.at(t);
    await h.at(MIDNIGHT - 1);
    expect(h.db.counts.loads).toBe(1);
    await h.at(MIDNIGHT);
    expect(h.db.counts.loads).toBe(2);
  });

  it('epoch jitter is capped at 5 minutes even with a 6-hour probe (the floor stays ~24 h, not 30 h)', async () => {
    const h = fresh(() => 0.999);
    await h.at(T0);
    await h.at(MIDNIGHT + 4 * MIN);
    expect(h.db.counts.loads).toBe(1); // still inside its (offset) epoch
    await h.at(MIDNIGHT + 5 * MIN);
    expect(h.db.counts.loads).toBe(2);
  });

  it('after a shared-path failure the fallback retries within 5 minutes, not 6 hours', async () => {
    const h = fresh();
    h.store.failWith = new Error('down');
    await h.at(T0);
    h.store.failWith = null;
    await h.at(T0 + 5 * MIN - 1);
    expect(h.legacyCalls.count).toBe(2);
    await h.at(T0 + 5 * MIN);
    expect(h.legacyCalls.count).toBe(2); // back on the shared path
  });

  it.each([
    ['a file-system-style store (the next read misses)', false, 1],
    ['a stale-while-revalidate store (Vercel: the old value is served once more)', true, 2],
  ] as const)('MANUAL BUST with %s: an urgent correction reaches OTHER instances within minutes', async (_label, swr, rechecks) => {
    const store = createFakeSharedStore();
    store.staleWhileRevalidate = swr;
    const db = createStubCatalogPool(catalogueRows(T0));
    const admin = instance(store, db);
    const other = instance(store, db);
    await admin.at(T0);
    await other.at(T0);

    rename(admin, 'Family Storytime (CANCELLED)'); // the correction lands in the database…
    expect(await nameAt(other, T0 + 30 * MIN)).toBe('Family Storytime'); // …and a 6 h probe would not see it yet

    await admin.at(T0 + 30 * MIN); // the busting instance is warm and freshly confirmed
    store.now = T0 + 30 * MIN;
    await admin.cache.bust();
    expect(store.invalidations).toBe(1);
    if (!swr) {
      // It dropped its own copy, so its very next request serves the correction — no re-check wait.
      expect(await nameAt(admin, T0 + 30 * MIN + 1_000)).toBe('Family Storytime (CANCELLED)');
    }

    let seen = '';
    let t = T0 + 30 * MIN;
    for (let i = 0; i < rechecks; i += 1) {
      t += CATALOGUE_RECHECK_DEFAULT_MS;
      seen = await nameAt(other, t);
      await store.settle();
    }
    expect(seen).toBe('Family Storytime (CANCELLED)');
    expect(await nameAt(admin, t)).toBe('Family Storytime (CANCELLED)');
    expectSameRecords(await other.at(t), await directAt(db, t));
  });

  it('a bust with no data change costs little: the catalogue is not reloaded by instances that already hold it', async () => {
    const store = createFakeSharedStore();
    const db = createStubCatalogPool(catalogueRows(T0));
    const admin = instance(store, db);
    const others = [instance(store, db, () => 0.3), instance(store, db, () => 0.6)];
    await admin.at(T0);
    for (const o of others) await o.at(T0);
    const loads = db.counts.loads;

    store.now = T0 + MIN;
    await admin.cache.bust();
    for (const o of others) await o.at(T0 + 2 * MIN);
    await admin.at(T0 + 2 * MIN);
    // One re-probe; the other instances confirm the unchanged version and keep their copy. Only the
    // busting instance, which dropped its own, re-reads — at most one load in total.
    expect(db.counts.loads - loads).toBeLessThanOrEqual(1);
  });

  it('a bust propagates the store failure to its caller (the endpoint answers 500, not a false success)', async () => {
    const h = fresh();
    await h.at(T0);
    h.store.failWith = new Error('data cache down');
    await expect(h.cache.bust()).rejects.toThrow('data cache down');
  });
});
