// tests/search/catalogue-snapshot.test.ts — the shared catalogue snapshot's wire format
// (lib/search/catalogue-snapshot.ts), and the two SQL facts the shared cache rests on.
//
// The decode-side rejections are exercised end to end by tests/search/shared-catalogue-cache.test.ts
// ("a snapshot that is … is never served"). This file pins the encode side: exact round trips,
// refusal of anything JSON would silently rewrite, and the size limit.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  CatalogueSnapshotError,
  MAX_SNAPSHOT_BASE64_CHARS,
  SNAPSHOT_FORMAT,
  decodeCatalogueSnapshot,
  encodeCatalogueSnapshot,
} from '../../lib/search/catalogue-snapshot';
import { loadPostgresListings, probePostgresCatalogueVersion } from '../../lib/search/postgres-repository';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';

const roundTrip = async (listings: readonly ListingRecord[]) =>
  decodeCatalogueSnapshot(JSON.parse(JSON.stringify(await encodeCatalogueSnapshot(listings, 'v', 1))), 'v');

describe('catalogue snapshot codec', () => {
  it('round-trips records exactly, frozen, with its envelope intact', async () => {
    const listings = [
      makeListing({ id: 'a', geo: { lat: 49.1, lng: -123.2 }, ageNotes: null, registrationRequired: null }),
      makeListing({ id: 'b', openHoursLocal: { startMin: 540, endMin: 1020 }, costMinCad: 0, categoryTags: [] }),
    ];
    const encoded = await encodeCatalogueSnapshot(listings, 'v', 1234);
    expect(encoded).toMatchObject({ format: SNAPSHOT_FORMAT, version: 'v', publishedAt: 1234, count: 2 });

    const decoded = await roundTrip(listings);
    expect(decoded.listings).toStrictEqual(listings);
    expect(JSON.stringify(decoded.listings)).toBe(JSON.stringify(listings));
    expect(Object.isFrozen(decoded.listings)).toBe(true);
  });

  it('round-trips an empty catalogue (reachable but empty is a real answer, not a failure)', async () => {
    expect((await roundTrip([])).listings).toEqual([]);
  });

  it.each<[string, Partial<ListingRecord> | Record<string, unknown>]>([
    ['an undefined property (JSON would drop the key)', { venueAddress: undefined }],
    ['NaN (JSON would write null)', { geo: { lat: Number.NaN, lng: -123 } }],
    ['Infinity (JSON would write null)', { costMinCad: Number.POSITIVE_INFINITY }],
    ['-0 (JSON would write 0)', { costMinCad: -0 }],
    ['a Date (JSON would write a string)', { lastCheckedAtUtc: new Date(0) as unknown as string }],
  ])('refuses to encode %s', async (_label, patch) => {
    const listing = { ...makeListing({ id: 'x' }), ...patch } as ListingRecord;
    await expect(encodeCatalogueSnapshot([listing], 'v', 1)).rejects.toBeInstanceOf(CatalogueSnapshotError);
  });

  it('refuses to encode a catalogue whose snapshot would exceed the store item limit', async () => {
    // Incompressible text, so the brotli output really is over the limit.
    const noise = randomBytes(MAX_SNAPSHOT_BASE64_CHARS).toString('base64');
    const listing = makeListing({ id: 'big', descriptionSnippet: noise });
    await expect(encodeCatalogueSnapshot([listing], 'v', 1)).rejects.toThrow(/over the 1800000 limit/);
  });
});

describe('the SQL the shared cache rests on', () => {
  function recordingPool() {
    const sql: string[] = [];
    const pool = {
      query: async (text: string) => {
        sql.push(text);
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, sql };
  }

  it('the catalogue load itself is unchanged: visibility is still judged against now()', async () => {
    const { pool, sql } = recordingPool();
    await loadPostgresListings(pool);
    expect(sql[0]).toContain('COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now()');
    expect(sql[0]).not.toContain('$2::timestamptz');
  });

  it('the probe judges visibility against the fixed cut-off, hashes without last_checked_at, and returns only a version', async () => {
    const { pool, sql } = recordingPool();
    const version = await probePostgresCatalogueVersion(pool, new Date(0));
    expect(sql[0]).toContain('COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= $2::timestamptz');
    expect(sql[0]).not.toContain('>= now()');
    expect(sql[0]).toContain("- 'last_checked_at'");
    expect(version).toBe('0:empty'); // an empty result still yields a usable, distinct version
  });
});
