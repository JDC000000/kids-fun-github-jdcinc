// tests/geo/backfill-clobber-guard.test.ts — QA finding F4.
//
// The Mapbox geocoder backfill is the weakest coordinate source in the system, and it is the
// ONE writer that structurally cannot clobber: `... WHERE id = $1 AND geo IS NULL`. That
// predicate matters more after migration 0025, not less — the geocoder's tier outranks the
// legacy tier stamped onto every pre-existing coordinate, so the authority ordinal ALONE would
// newly permit it to overwrite every hand-placed point in the database with an address-derived
// guess (see `GEOCODER_BACKFILL` in worker/core/venue-geo-authority.ts).
//
// It was pinned only by a TEXT REGEX in the compliance suite. That proves somebody typed the
// words; it does not prove the statement behaves that way — and the failure mode if it ever
// stops behaving that way is silent, global and irreversible. So the real statement is executed
// here, against real rows, in both directions.
import { describe, it, expect, afterAll } from 'vitest';
import { query, closePool } from '../../lib/db/client';
import { SET_GEO_SQL } from '../../lib/geo/venue-geo-enrichment';
import { VENUE_GEO_AUTHORITY } from '../../worker/core/venue-geo-authority';

const hasDb = Boolean(process.env.DATABASE_URL);
const names: string[] = [];
const venueName = (label: string) => {
  const n = `BACKFILL ${label} ${crypto.randomUUID()}`;
  names.push(n);
  return n;
};

/** pg params, matching the script's own call: $2 = lng (x), $3 = lat (y). */
const runBackfill = (id: string, lat: number, lng: number) =>
  query(SET_GEO_SQL, [id, lng, lat, VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL]);

async function stored(name: string) {
  const [row] = await query<{ lat: string | null; authority: number | null; source: string | null }>(
    `SELECT ST_Y(geo::geometry)::text AS lat, geo_authority AS authority, geo_source AS source
     FROM venue WHERE lower(name) = lower($1)`,
    [name]
  );
  return row;
}

describe.skipIf(!hasDb)('geocoder backfill clobber-guard (F4)', () => {
  afterAll(async () => {
    for (const n of names) await query(`DELETE FROM venue WHERE lower(name) = lower($1)`, [n]);
    await closePool();
  });

  it('REFUSES to move a venue that already has a coordinate, even a legacy unattributed one', async () => {
    // Tier 5 outranks tier 0. If the guard is ever deleted, this row moves — and every legacy
    // hand-placed coordinate in production moves with it, silently, on the next backfill run.
    const name = venueName('has-geo');
    const [v] = await query<{ id: string }>(
      `INSERT INTO venue (name, geo, geo_authority)
       VALUES ($1, ST_SetSRID(ST_MakePoint($3::double precision, $2::double precision), 4326)::geography, $4)
       RETURNING id`,
      [name, 49.2757, -123.0714, VENUE_GEO_AUTHORITY.LEGACY_UNATTRIBUTED]
    );

    await runBackfill(v.id, 49.9999, -122.9999);

    const row = await stored(name);
    expect(Number(row.lat), 'the geocoder must not have moved a coordinate that already existed').toBeCloseTo(
      49.2757,
      6
    );
    expect(row.authority, 'nor re-stamped its authority').toBe(VENUE_GEO_AUTHORITY.LEGACY_UNATTRIBUTED);
    expect(row.source).toBeNull();
  });

  it('DOES fill a venue that has no coordinate at all, and declares its tier', async () => {
    // The other half: the guard must not have been "fixed" by making the script a no-op.
    const name = venueName('no-geo');
    const [v] = await query<{ id: string }>(
      `INSERT INTO venue (name) VALUES ($1) RETURNING id`,
      [name]
    );

    await runBackfill(v.id, 49.2827, -123.1207);

    const row = await stored(name);
    expect(Number(row.lat)).toBeCloseTo(49.2827, 6);
    expect(row.authority).toBe(VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL);
    expect(row.source).toBe('geocoder:mapbox-backfill');
  });
});
