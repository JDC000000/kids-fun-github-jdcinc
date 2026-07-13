import { describe, it, expect, afterAll } from 'vitest';
import { venuesWithinRadius } from '../../lib/geo/radius';
import { query, closePool } from '../../lib/db/client';

// G-T18-1 — radius filter + distance for ranking (TSD §5B BR-06).
const hasDb = Boolean(process.env.DATABASE_URL);

const VANCOUVER_DOWNTOWN = { lat: 49.2827, long: -123.1207 };
// East Van — a few km from downtown, safely inside a 10km radius.
const EAST_VAN = { lat: 49.262, long: -123.071 };
// Whistler — well outside any launch radius option.
const WHISTLER = { lat: 50.1163, long: -122.9574 };

describe.skipIf(!hasDb)('venuesWithinRadius (G-T18-1)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('a 10km radius returns an in-radius venue with a computed distance, excludes a far one', async () => {
    const [near] = await query<{ id: string }>(
      `INSERT INTO venue (name, geo) VALUES ('Near Venue', ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) RETURNING id`,
      [EAST_VAN.long, EAST_VAN.lat]
    );
    await query(
      `INSERT INTO venue (name, geo) VALUES ('Far Venue', ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)`,
      [WHISTLER.long, WHISTLER.lat]
    );

    const results = await venuesWithinRadius(VANCOUVER_DOWNTOWN, 10);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(near.id);
    expect(results.find((r) => r.id === near.id)!.distanceMeters).toBeGreaterThan(0);
    expect(results.every((r) => r.name !== 'Far Venue')).toBe(true);
  });

  it('venues with no geo are excluded (queued for manual geocode instead)', async () => {
    await query(`INSERT INTO venue (name) VALUES ('No Geo Venue')`);
    const results = await venuesWithinRadius(VANCOUVER_DOWNTOWN, 10);
    expect(results.some((r) => r.name === 'No Geo Venue')).toBe(false);
  });
});
