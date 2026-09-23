// tests/search/__support__/catalogue-cache-fakes.ts — test doubles for the shared catalogue cache.
//
// Three fakes, each faithful to the one property of the real thing the tests depend on:
//
//   · createFakeSharedStore — `unstable_cache` as next@14.2 implements it: the value is stored as
//     JSON.stringify(result) and a hit returns JSON.parse of that, so every test that reads through
//     it proves JSON round-trip fidelity rather than handing back the same object. Optionally
//     serves stale-while-revalidate, as Next does in the App Router.
//   · createStubCatalogPool — a pg Pool that answers the two statements the cache sends: the
//     catalogue load (returns the rows) and the version probe (returns a hash that, like the real
//     one, ignores last_checked_at and changes when any other column does). Counts both.
//   · catalogueRows — realistic occurrence rows in the shape loadPostgresListings reads: dated and
//     dateless, geo and not, ages, tags, costs, every nullable column exercised.
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { SharedCatalogueStore } from '../../../lib/search/shared-catalogue-cache';

export interface FakeSharedStore extends SharedCatalogueStore {
  /** The store's own clock (ms). Tests move it with the `now` they pass to the cache. */
  now: number;
  /** When set, every memo() call rejects with this — the store is down. */
  failWith: Error | null;
  /** Serve an expired entry once more while recomputing it (Next's App Router behaviour). */
  staleWhileRevalidate: boolean;
  readonly entries: Map<string, { body: string; storedAt: number; ttlMs: number }>;
  readonly stats: { hits: number; misses: number; computes: number };
  /** Settles once every background (stale-while-revalidate) recompute has been stored. */
  settle(): Promise<void>;
  /** Rewrite the stored JSON value of every entry whose key contains `fragment`. */
  tamper(fragment: string, edit: (value: Record<string, unknown>) => unknown): number;
}

export function createFakeSharedStore(): FakeSharedStore {
  const entries = new Map<string, { body: string; storedAt: number; ttlMs: number }>();
  const pending: Promise<unknown>[] = [];
  const store: FakeSharedStore = {
    now: 0,
    failWith: null,
    staleWhileRevalidate: false,
    entries,
    stats: { hits: 0, misses: 0, computes: 0 },
    async memo<T>(key: readonly string[], ttlMs: number, compute: () => Promise<T>): Promise<T> {
      if (store.failWith) throw store.failWith;
      const id = key.join('|');
      const entry = entries.get(id);
      const at = store.now;
      if (entry && at - entry.storedAt < entry.ttlMs) {
        store.stats.hits += 1;
        return JSON.parse(entry.body) as T;
      }
      if (entry && store.staleWhileRevalidate) {
        store.stats.hits += 1;
        store.stats.computes += 1;
        pending.push(
          compute().then(
            (value) => entries.set(id, { body: JSON.stringify(value), storedAt: at, ttlMs }),
            () => undefined
          )
        );
        return JSON.parse(entry.body) as T;
      }
      store.stats.misses += 1;
      store.stats.computes += 1;
      // Like unstable_cache: a thrown compute is propagated and NOT stored.
      const value = await compute();
      entries.set(id, { body: JSON.stringify(value), storedAt: at, ttlMs });
      // Like unstable_cache's miss path: the caller gets the in-memory result, not a round trip.
      return value;
    },
    async settle() {
      while (pending.length) await pending.shift();
    },
    tamper(fragment, edit) {
      let n = 0;
      for (const [id, entry] of entries) {
        if (!id.includes(fragment)) continue;
        entry.body = JSON.stringify(edit(JSON.parse(entry.body) as Record<string, unknown>));
        n += 1;
      }
      return n;
    },
  };
  return store;
}

export type CatalogueRow = Record<string, unknown> & { id: string };

export interface StubCatalogPool {
  pool: Pool;
  /** Replace the "table". The next load/probe sees it. */
  rows: CatalogueRow[];
  counts: { loads: number; probes: number; other: number };
  /** Cut-offs the probe was called with (ISO strings). */
  probeCutoffs: string[];
  /** When set, the matching statement rejects. */
  failLoads: Error | null;
  failProbes: Error | null;
}

/**
 * The version a real probe would return: stable for the same content, blind to last_checked_at,
 * different when anything else differs. (The real hash is Postgres md5 over to_jsonb rows; the
 * tests only depend on those three properties, which tests/search/catalogue-version-probe-db.test.ts
 * pins against real Postgres.)
 */
export function fakeVersionOf(rows: readonly CatalogueRow[]): string {
  const content = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ last_checked_at: _ignored, ...rest }) => JSON.stringify(rest));
  return `${rows.length}:${createHash('md5').update(content.join('|')).digest('hex')}`;
}

export function createStubCatalogPool(initialRows: CatalogueRow[]): StubCatalogPool {
  const stub: StubCatalogPool = {
    pool: null as unknown as Pool,
    rows: initialRows,
    counts: { loads: 0, probes: 0, other: 0 },
    probeCutoffs: [],
    failLoads: null,
    failProbes: null,
  };
  stub.pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('md5(string_agg(')) {
        stub.counts.probes += 1;
        stub.probeCutoffs.push(String(params[1]));
        if (stub.failProbes) throw stub.failProbes;
        const [count, version] = fakeVersionOf(stub.rows).split(':');
        return { rows: [{ row_count: Number(count), version }] };
      }
      if (sql.includes('FROM activity_occurrence o')) {
        stub.counts.loads += 1;
        if (stub.failLoads) throw stub.failLoads;
        // Fresh objects per load, as pg returns them.
        return { rows: stub.rows.map((r) => ({ ...r })) };
      }
      stub.counts.other += 1;
      throw new Error(`stub pool: unexpected statement ${sql.slice(0, 60)}`);
    },
  } as unknown as Pool;
  return stub;
}

const HOUR = 3_600_000;

/**
 * Realistic catalogue rows around `baseMs`: most run days ahead, `endingSoonId` ends 30 minutes
 * after `baseMs` (so pruning can be observed), and two are dateless standing venues.
 */
export function catalogueRows(baseMs: number): CatalogueRow[] {
  const at = (h: number) => new Date(baseMs + h * HOUR).toISOString();
  const base = {
    tag_keys: [] as string[],
    venue_address: null,
    series_title: null,
    source_authority_tier: 'official',
    description_snippet: null,
    open_hours_state: null,
    cost_min_cad: null,
    cost_max_cad: null,
    source_url: null,
    booking_url: null,
    location_url: null,
    registration_required: null,
    status_state: 'confirmed',
    confidence_label: 'high',
    last_checked_at: new Date(baseMs - 2 * HOUR).toISOString(),
    age_min_months: null,
    age_max_months: null,
    age_notes: null,
    age_band_keys: [] as string[],
    lat: null,
    lng: null,
    municipality_id: null,
    neighbourhood: null,
    display_area: null,
    phone: null,
  };
  return [
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000001',
      series_id: '10000000-0000-4000-8000-000000000001',
      activity_name: 'Family Storytime',
      primary_category_key: 'storytime',
      tag_keys: ['free', 'indoor'],
      venue_name: 'Central Library',
      venue_address: '350 W Georgia St, Vancouver',
      source_name: 'Vancouver Public Library',
      series_title: 'Family Storytime — Central Library',
      description_snippet: 'Stories, songs and rhymes for ages 0-5.',
      start_datetime_utc: at(20),
      end_datetime_utc: at(20.5),
      cost_status: 'free',
      source_url: 'https://example.org/storytime',
      age_min_months: 0,
      age_max_months: 60,
      age_notes: ' Ages 0-5 with a caregiver ',
      age_band_keys: ['under2', '2-4'],
      lat: 49.2796,
      lng: -123.1157,
      municipality_id: 'van',
      neighbourhood: 'Downtown',
      display_area: 'Downtown',
      phone: '604-331-3603',
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000002',
      series_id: '10000000-0000-4000-8000-000000000002',
      activity_name: 'Public Swim',
      primary_category_key: 'public_swim',
      venue_name: 'Vancouver Aquatic Centre',
      source_name: 'Vancouver Park Board',
      start_datetime_utc: null,
      end_datetime_utc: null,
      open_hours_state: 'Daily 6:30am-9pm',
      cost_status: 'known',
      cost_min_cad: '6.10',
      cost_max_cad: 6.1,
      registration_required: false,
      lat: 49.2772,
      lng: -123.1352,
      municipality_id: 'van',
      display_area: 'West End',
      last_checked_at: null,
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000003',
      series_id: '10000000-0000-4000-8000-000000000003',
      activity_name: 'Toddler Open Gym',
      primary_category_key: null,
      venue_name: null,
      source_name: 'Burnaby Recreation',
      series_title: 'Toddler Open Gym — Bonsor Recreation Complex',
      start_datetime_utc: at(0.2),
      end_datetime_utc: at(0.5),
      cost_status: 'unknown',
      status_state: 'inferred_recurring',
      confidence_label: 'medium',
      age_band_keys: ['2-4', 'not-a-band'],
      lat: '49.2257',
      lng: '-122.9960',
      municipality_id: 'bby',
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000004',
      series_id: '10000000-0000-4000-8000-000000000004',
      activity_name: 'Outdoor Soccer Skills (Rain/Shine)',
      primary_category_key: 'class_program',
      tag_keys: ['outdoor'],
      venue_name: 'Minoru Park',
      source_name: 'Sportball',
      source_authority_tier: 'aggregator',
      start_datetime_utc: at(44),
      end_datetime_utc: null,
      cost_status: 'known',
      cost_min_cad: 18,
      cost_max_cad: 25,
      registration_required: true,
      confidence_label: 'low',
      age_min_months: 60,
      age_max_months: 108,
      age_band_keys: ['5-9'],
      lat: 49.1685,
      lng: -123.1436,
      municipality_id: 'rmd',
      booking_url: 'https://example.org/book',
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000005',
      series_id: '10000000-0000-4000-8000-000000000005',
      activity_name: 'Science World After Dark',
      primary_category_key: 'museum_venue',
      venue_name: 'Science World',
      source_name: 'Science World',
      start_datetime_utc: at(70),
      end_datetime_utc: at(74),
      cost_status: 'known',
      cost_min_cad: 35,
      confidence_label: null,
      age_band_keys: ['10-14', '15+'],
      lat: 49.2734,
      lng: -123.1038,
      municipality_id: 'van',
      location_url: 'http://maps.google.com/?q=Science+World',
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000006',
      series_id: '10000000-0000-4000-8000-000000000006',
      activity_name: 'Lonsdale Quay Market Stroll',
      primary_category_key: 'outdoor_park',
      venue_name: 'Lonsdale Quay',
      source_name: 'North Van Events',
      start_datetime_utc: null,
      end_datetime_utc: null,
      open_hours_state: '   ',
      cost_status: 'free',
      lat: 49.3106,
      lng: -123.0826,
      municipality_id: 'nvan',
    },
  ];
}

/** Id of the row in catalogueRows() that ends 30 minutes after its base time. */
export const ENDING_SOON_ID = '00000000-0000-4000-8000-000000000003';
