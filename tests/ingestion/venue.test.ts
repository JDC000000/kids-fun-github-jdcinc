import { describe, it, expect, afterAll, onTestFinished } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { deleteSourceRows } from '../../lib/testing/delete-source-rows';
import { resolveVenue } from '../../worker/core/venue';
import { VENUE_GEO_AUTHORITY } from '../../worker/core/venue-geo-authority';
import { ingestSource } from '../../worker/core/ingest';
import type { Adapter, StructuredRecord } from '../../worker/core/adapter';

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
      geoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
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

  // ── venue.phone (migration 0024) ────────────────────────────────────────────────
  //
  // The point of these three is that phone got NO mechanism of its own: it is enriched
  // by the same COALESCE as address/display_area/geo, so it must exhibit the same
  // last-writer-wins behaviour — including the part that is easy to get wrong, which is
  // that a LATER writer sending nothing does not erase an earlier writer's value. That
  // asymmetry is what makes today's single-populating-family situation stable, and it
  // is asserted here rather than reasoned about.
  it('phone is written on create and preserved when a later writer sends none', async () => {
    const pool = getPool();
    const name = `Phone Test Venue ${crypto.randomUUID()}`;

    await resolveVenue(pool, {
      name,
      address: '1661 Napier St, Vancouver, BC',
      phone: '(604) 718-5800',
      municipalityName: 'Vancouver',
    });
    // A second family (citycalendar's real behaviour) writes the same venue name with
    // geo but no phone. COALESCE must PRESERVE, not blank.
    await resolveVenue(pool, {
      name,
      lat: 49.2757,
      lng: -123.0714,
      geoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
      municipalityName: 'Vancouver',
    });

    const [venue] = await query<{ phone: string | null; lat: string | null }>(
      `SELECT phone, ST_Y(geo::geometry)::text AS lat FROM venue WHERE lower(name) = lower($1)`,
      [name]
    );
    expect(venue.phone).toBe('(604) 718-5800');
    expect(Number(venue.lat)).toBeCloseTo(49.2757, 4);
  });

  it('a second non-null phone OVERWRITES — last-writer-wins, same as lat/lng', async () => {
    const pool = getPool();
    const name = `Phone Conflict Venue ${crypto.randomUUID()}`;

    await resolveVenue(pool, { name, phone: '(604) 111-1111', municipalityName: 'Vancouver' });
    await resolveVenue(pool, { name, phone: '(604) 222-2222', municipalityName: 'Vancouver' });

    const [venue] = await query<{ phone: string | null }>(
      `SELECT phone FROM venue WHERE lower(name) = lower($1)`,
      [name]
    );
    // NOT gap-filling. If two families ever disagree on a venue's number, the stored
    // value churns with ingest order exactly as geo already does for the five venue
    // names activenet and citycalendar both carry. Documented, not defended: the fix is
    // to converge the sources, not to bolt a bespoke merge rule onto this one field.
    expect(venue.phone).toBe('(604) 222-2222');
  });

  it('a venue created without a phone stores NULL, and gains one from a later writer', async () => {
    const pool = getPool();
    const name = `Phoneless Venue ${crypto.randomUUID()}`;

    await resolveVenue(pool, { name, municipalityName: 'Vancouver' });
    const [before] = await query<{ phone: string | null }>(
      `SELECT phone FROM venue WHERE lower(name) = lower($1)`,
      [name]
    );
    expect(before.phone, 'most venues are NULL on day one, and that is honest').toBeNull();

    await resolveVenue(pool, { name, phone: '(604) 333-3333', municipalityName: 'Vancouver' });
    const [after] = await query<{ phone: string | null }>(
      `SELECT phone FROM venue WHERE lower(name) = lower($1)`,
      [name]
    );
    expect(after.phone).toBe('(604) 333-3333');
  });

  // ── the hop that has no other guard ─────────────────────────────────────────────
  //
  // WHY THIS EXISTS, in its own words. The bug 0024 fixes was NOT a parsing bug: the
  // ActiveNet adapter read the phone correctly for two days and it vanished at a
  // BOUNDARY, because no test asserted the field survived the handoff. Wiring the field
  // through adds three new boundaries, and two of them are guarded elsewhere —
  // tests/adapters/activenet.test.ts pins centerdetails → StructuredRecord, and the
  // three tests above pin VenueInput → the `venue` row. The middle hop, ingest.ts
  // reading `record.venuePhone` into the resolveVenue() call, had NOTHING: verified by
  // deleting that single line and watching the entire 416-test DB lane stay green.
  // That is the original bug's exact shape, relocated one hop downstream, so it gets the
  // one test that reproduces it. Delete `phone: record.venuePhone` from
  // worker/core/ingest.ts and this goes red naming the field.
  it('a record carrying venuePhone lands it on the venue row, end to end through ingestSource', async () => {
    const pool = getPool();
    const venueName = `Ingest Phone Venue ${crypto.randomUUID()}`;
    const record: StructuredRecord = {
      sourceRecordId: `ingest-phone-${crypto.randomUUID()}`,
      title: 'Parent and Tot Drop-in Swim',
      venueName,
      venueAddress: '1661 Napier St, Vancouver, BC',
      venuePhone: '(604) 718-5831',
      venueMunicipalityName: 'Vancouver',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      costStatus: 'free',
      sourceUrl: 'https://example.org/ingest-phone',
    };
    const adapter: Adapter = {
      family: 'activenet',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: (r) => ({ key: `ingest-phone::${r.sourceRecordId}` }),
    };

    const [source] = await query<{ id: string }>(
      // terms_status='allowed': a structured record ingests to a 'confirmed' occurrence,
      // which the 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, terms_status) VALUES ('activenet', $1, 'allowed') RETURNING id`,
      [`Ingest Phone Source ${crypto.randomUUID()}`]
    );
    // Allowed + Vancouver + a fresh `success` check run: left behind, it becomes the region's
    // "last crawl" in tests/coverage-status-db.test.ts.
    onTestFinished(() => deleteSourceRows(source.id));
    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);

    const [venue] = await query<{ phone: string | null; address: string | null }>(
      `SELECT phone, address FROM venue WHERE lower(name) = lower($1)`,
      [venueName]
    );
    expect(
      venue.phone,
      'venuePhone must survive StructuredRecord → ingest.ts → resolveVenue → venue.phone'
    ).toBe('(604) 718-5831');
    // Pinned alongside address so a future refactor cannot quietly drop one of the two.
    expect(venue.address).toBe('1661 Napier St, Vancouver, BC');
  });
});
