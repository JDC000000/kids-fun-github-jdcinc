// tests/search/catalogue-version-probe-db.test.ts — the catalogue version probe against REAL
// Postgres, and the shared catalogue cache end to end over a real database.
//
// The unit suite (tests/search/shared-catalogue-cache.test.ts) runs the cache over a stub pool whose
// "probe" is a JavaScript stand-in. Everything the cache's correctness rests on about the REAL probe
// is pinned here instead, against the real SQL, the real schema and the real joins:
//   · stable for unchanged content, and blind to `last_checked_at` (or it gates nothing);
//   · changed by every kind of edit a parent would see — the occurrence's own columns, its status,
//     archiving, a joined table (venue), a tag — so no change can slip past it;
//   · the cut-off semantics the cache relies on: a row ended after the cut-off is inside the hash.
// And the end-to-end parity claim on real rows: the shared path returns exactly what the direct
// load returns.
//
// Fixture dates are RELATIVE to now, deliberately: tests/search/postgres-repository.test.ts pins
// absolute 2026-09-17 dates and has been failing since they passed. This file must not rot the
// same way.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool, getPool, query } from '../../lib/db/client';
import {
  LISTING_CACHE_DEFAULT_MS,
  loadPostgresListings,
  probePostgresCatalogueVersion,
} from '../../lib/search/postgres-repository';
import { SharedCatalogueCache } from '../../lib/search/shared-catalogue-cache';
import { pruneEndedOccurrences } from '../../lib/search/occurrence-visibility';
import { TtlPromiseCache } from '../../lib/search/ttl-cache';
import type { ListingRecord } from '../../lib/search/types';
import { createFakeSharedStore } from './__support__/catalogue-cache-fakes';

const hasDb = Boolean(process.env.DATABASE_URL);
const HOUR = 3_600_000;

describe.skipIf(!hasDb)('catalogue version probe (real Postgres)', () => {
  const suffix = crypto.randomUUID();
  let occurrenceId = '';
  let venueId = '';
  let endedId = '';
  /** A fixed cut-off one hour ago: what the cache uses (an epoch start), never `now()`. */
  const cutoff = new Date(Date.now() - HOUR);
  const probe = () => probePostgresCatalogueVersion(getPool(), cutoff);

  beforeAll(async () => {
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, terms_status) VALUES ('library_bibliocommons', $1, 'official', 'allowed') RETURNING id`,
      [`Probe Test Source ${suffix}`]
    );
    const [venue] = await query<{ id: string }>(`INSERT INTO venue (name) VALUES ($1) RETURNING id`, [
      `Probe Test Venue ${suffix}`,
    ]);
    venueId = venue.id;
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id) VALUES ($1, $2, $3) RETURNING id`,
      [`Probe Storytime ${suffix}`, source.id, venue.id]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const insert = (startsInHours: number, endsInHours: number, name: string) =>
      query<{ id: string }>(
        `INSERT INTO activity_occurrence (
           series_id, source_record_id, activity_name, primary_category_id,
           start_datetime_utc, end_datetime_utc, cost_status, status_state, confidence_label, last_checked_at
         ) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), now() + make_interval(secs => $6),
                   'free', 'confirmed', 'high', now())
         RETURNING id`,
        [series.id, `probe-${name}-${suffix}`, `${name} ${suffix}`, category.id, startsInHours * 3600, endsInHours * 3600]
      );
    [{ id: occurrenceId }] = await insert(48, 49, 'Probe Storytime');
    // Ended 10 minutes ago: after the cut-off, so inside the hashed set, though no longer visible.
    [{ id: endedId }] = await insert(-1 / 2, -1 / 6, 'Probe Ended');
  });

  afterAll(async () => {
    await closePool();
  });

  it('is stable for unchanged content, and is short (the whole point: ~100 bytes, not the catalogue)', async () => {
    const a = await probe();
    const b = await probe();
    expect(a).toBe(b);
    expect(a).toMatch(/^\d+:[0-9a-f]{32}$/);
  });

  it('ignores last_checked_at — a crawl that re-checks unchanged rows does not trigger a reload', async () => {
    const before = await probe();
    await query(`UPDATE activity_occurrence SET last_checked_at = now() + interval '1 minute' WHERE id = $1`, [occurrenceId]);
    expect(await probe()).toBe(before);
  });

  it('changes when an occurrence column changes, and returns to the old value when it is reverted', async () => {
    const before = await probe();
    await query(`UPDATE activity_occurrence SET activity_name = activity_name || ' (moved)' WHERE id = $1`, [occurrenceId]);
    const edited = await probe();
    expect(edited).not.toBe(before);

    await query(`UPDATE activity_occurrence SET activity_name = replace(activity_name, ' (moved)', '') WHERE id = $1`, [occurrenceId]);
    expect(await probe()).toBe(before); // content-derived, not a counter or a timestamp
  });

  it('changes when a listing is hidden (status) or archived', async () => {
    const before = await probe();
    await query(`UPDATE activity_occurrence SET status_state = 'cancelled' WHERE id = $1`, [occurrenceId]);
    expect(await probe()).not.toBe(before);
    await query(`UPDATE activity_occurrence SET status_state = 'confirmed' WHERE id = $1`, [occurrenceId]);
    expect(await probe()).toBe(before);

    await query(`UPDATE activity_occurrence SET archived_at = now() WHERE id = $1`, [occurrenceId]);
    expect(await probe()).not.toBe(before);
    await query(`UPDATE activity_occurrence SET archived_at = NULL WHERE id = $1`, [occurrenceId]);
    expect(await probe()).toBe(before);
  });

  it('changes when a JOINED table changes (venue name) and when a tag is added', async () => {
    const before = await probe();
    await query(`UPDATE venue SET name = name || ' Annex' WHERE id = $1`, [venueId]);
    expect(await probe()).not.toBe(before);
    await query(`UPDATE venue SET name = replace(name, ' Annex', '') WHERE id = $1`, [venueId]);
    expect(await probe()).toBe(before);

    const [tag] = await query<{ id: string }>(`SELECT id FROM tag WHERE key = 'indoor' LIMIT 1`);
    await query(
      `INSERT INTO occurrence_category_tag (occurrence_id, tag_id, tag_type) VALUES ($1, $2, 'suitability')`,
      [occurrenceId, tag.id]
    );
    expect(await probe()).not.toBe(before);
    await query(`DELETE FROM occurrence_category_tag WHERE occurrence_id = $1`, [occurrenceId]);
    expect(await probe()).toBe(before);
  });

  it('hashes rows that ended after the cut-off (the superset the cache relies on), and only those', async () => {
    const before = await probe();
    await query(`UPDATE activity_occurrence SET cost_status = 'unknown' WHERE id = $1`, [endedId]);
    expect(await probe()).not.toBe(before); // ended 10 min ago, cut-off 1 h ago: inside the set

    // With a cut-off AFTER it ended, the same row is outside the set: edits to it are invisible.
    const later = new Date();
    const v1 = await probePostgresCatalogueVersion(getPool(), later);
    await query(`UPDATE activity_occurrence SET cost_status = 'free' WHERE id = $1`, [endedId]);
    expect(await probePostgresCatalogueVersion(getPool(), later)).toBe(v1);
  });

  it('end to end on real rows: the shared path returns exactly the direct load, and a second instance never queries the catalogue', async () => {
    const store = createFakeSharedStore();
    let catalogueQueries = 0;
    const real = getPool();
    const counting = {
      query: (...args: Parameters<Pool['query']>) => {
        if (String(args[0]).includes('FROM activity_occurrence o')) catalogueQueries += 1;
        return (real.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Pool;
    const makeInstance = () => {
      const ttl = new TtlPromiseCache<readonly ListingRecord[]>('KIDS_FUN_LISTING_CACHE_MS', LISTING_CACHE_DEFAULT_MS);
      return new SharedCatalogueCache({
        store,
        legacy: {
          get: (pool, now) => ttl.get(async () => Object.freeze(await loadPostgresListings(pool)), now),
          clear: () => ttl.clear(),
        },
        loadListings: loadPostgresListings,
        probeVersion: probePostgresCatalogueVersion,
        random: () => 0,
      });
    };

    // Direct load FIRST, so every row the shared path can see is also in it; both are then pruned
    // at the same instant, which makes the comparison immune to rows other suites left ending "now".
    const direct = await loadPostgresListings(real);
    const now = Date.now();
    store.now = now;
    const first = await makeInstance().get(counting, now);
    expect(catalogueQueries).toBe(2); // the probe and the one snapshot load
    const expected = pruneEndedOccurrences(direct, new Date(now));
    expect(JSON.stringify(first)).toBe(JSON.stringify(expected));
    expect(first).toStrictEqual(expected);
    expect(first.some((l) => l.id === occurrenceId)).toBe(true);
    expect(first.some((l) => l.id === endedId)).toBe(false);

    const second = await makeInstance().get(counting, now + 1_000);
    expect(catalogueQueries).toBe(2); // read from the shared store: no probe, no load
    expect(JSON.stringify(second)).toBe(JSON.stringify(pruneEndedOccurrences(direct, new Date(now + 1_000))));
  });
});
