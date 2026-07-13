import { describe, it, expect, afterAll } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { resolveVenue } from '../../worker/core/venue';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('venue resolver', () => {
  afterAll(async () => {
    await closePool();
  });

  it('creates and enriches a geocoded venue deterministically', async () => {
    const pool = getPool();
    const name = `Steveston Test Venue ${crypto.randomUUID()}`;

    const first = await resolveVenue(pool, {
      name,
      address: '4320 Moncton St, Richmond, BC V7E 6T4',
      lat: 49.12546,
      lng: -123.1783832,
      municipalityName: 'Richmond',
      displayArea: 'Steveston',
      officialUrl: 'https://www.google.com/maps/search/?api=1&query=4320%20Moncton%20St%20Richmond%20BC%20V7E%206T4',
    });
    const second = await resolveVenue(pool, { name, municipalityName: 'Richmond' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.venueId).toBe(first.venueId);

    const [venue] = await query<{
      address: string;
      display_area: string;
      municipality: string;
      lat: string;
      lng: string;
    }>(
      `SELECT v.address, v.display_area, r.name AS municipality,
              ST_Y(v.geo::geometry)::text AS lat,
              ST_X(v.geo::geometry)::text AS lng
       FROM venue v
       LEFT JOIN region r ON r.id = v.municipality_id
       WHERE v.id = $1`,
      [first.venueId]
    );

    expect(venue.address).toBe('4320 Moncton St, Richmond, BC V7E 6T4');
    expect(venue.display_area).toBe('Steveston');
    expect(venue.municipality).toBe('Richmond');
    expect(Number(venue.lat)).toBeCloseTo(49.12546, 5);
    expect(Number(venue.lng)).toBeCloseTo(-123.1783832, 5);
  });
});
