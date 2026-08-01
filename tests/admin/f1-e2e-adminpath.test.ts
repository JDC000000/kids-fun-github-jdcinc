// Closes the one gap neither my tests nor QA's re-verify covered: the ADMIN PATH, END TO END.
// F1 was about `createManualListing`, but every regression test written for the fix (mine and
// QA's) drove `resolveVenue` directly. This drives the real server-side entry point twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { createManualListing } from '@/app/admin/listings/_lib/data';
import type { ManualListingInput } from '@/app/admin/listings/_lib/vocab';

const hasDb = Boolean(process.env.DATABASE_URL);
const FUTURE = '2026-12-01T18:00:00.000Z';
const VENUE = `F1 E2E Venue ${crypto.randomUUID()}`;

function listing(o: Partial<ManualListingInput> = {}): ManualListingInput {
  return {
    title: `F1 E2E ${crypto.randomUUID()}`,
    sourceId: null,
    venueName: VENUE,
    venueAddress: '123 First St',
    displayArea: 'Downtown',
    venueLat: 49.1,
    venueLng: -123.1,
    startDatetimeUtc: FUTURE,
    endDatetimeUtc: null,
    openHoursState: null,
    costStatus: 'free',
    costMinCad: null,
    costMaxCad: null,
    sourceUrl: 'https://example.org/f1-e2e',
    bookingUrl: null,
    locationUrl: null,
    descriptionSnippet: 'admin path end-to-end',
    statusState: 'manual_candidate',
    confidenceLabel: 'unscored',
    ...o,
  };
}

describe.skipIf(!hasDb)('F1 END-TO-END through createManualListing (the real admin path)', () => {
  let adminId = '';
  beforeAll(async () => {
    const [a] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = a.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);
  });
  afterAll(async () => {
    await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    await query(`DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE venue_id IN (SELECT id FROM venue WHERE name = $1))`, [VENUE]);
    await query(`DELETE FROM activity_series WHERE venue_id IN (SELECT id FROM venue WHERE name = $1)`, [VENUE]);
    await query(`DELETE FROM venue WHERE name = $1`, [VENUE]);
    await query(`DELETE FROM source WHERE family = 'manual' AND name = 'Manual Curation'`);
    await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
    await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    await closePool();
  });

  const stored = async () => {
    const [r] = await query<{ lat: string; lng: string; auth: number; src: string; addr: string }>(
      `SELECT ST_Y(geo::geometry)::text lat, ST_X(geo::geometry)::text lng,
              geo_authority auth, geo_source src, address addr
       FROM venue WHERE name = $1`, [VENUE]);
    return r;
  };

  it('a SECOND manual listing at the same venue with a corrected coordinate moves the pin', async () => {
    await createManualListing(listing(), adminId);
    const first = await stored();
    expect(Number(first.lat)).toBeCloseTo(49.1, 6);
    expect(first.auth).toBe(50);
    expect(first.src).toBe('admin:manual-listing');

    // The admin spots the pin is wrong and re-enters it. Pre-fix this silently did nothing.
    await createManualListing(listing({ venueLat: 49.2, venueLng: -123.2, venueAddress: '456 Corrected Ave' }), adminId);
    const second = await stored();
    expect(Number(second.lat), 'the corrected coordinate must land').toBeCloseTo(49.2, 6);
    expect(Number(second.lng)).toBeCloseTo(-123.2, 6);
    expect(second.addr, 'and the address alongside it').toBe('456 Corrected Ave');

    // and a third, to prove it is not a one-shot
    await createManualListing(listing({ venueLat: 49.3, venueLng: -123.3 }), adminId);
    expect(Number((await stored()).lat)).toBeCloseTo(49.3, 6);
  });

  it('a manual listing with NO coordinate does not blank an existing one', async () => {
    const before = await stored();
    await createManualListing(listing({ venueLat: null, venueLng: null }), adminId);
    const after = await stored();
    expect(Number(after.lat)).toBeCloseTo(Number(before.lat), 6);
    expect(after.auth).toBe(50);
  });
});
