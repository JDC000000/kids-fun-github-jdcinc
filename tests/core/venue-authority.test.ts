// tests/core/venue-authority.test.ts — G-VGEO-A2: the authority-ranked venue-geo write.
//
// WHAT WAS UNTESTED BEFORE THIS FILE, AND WHY THAT MATTERED. `venue.geo`'s merge rule was
// `COALESCE(<incoming>, geo)` — incoming first, so any non-NULL incoming coordinate
// unconditionally replaced the stored one. NO test in the repo asserted that branch:
// tests/ingestion/venue.test.ts sends geo on the FIRST call and nothing on the second, so
// it only ever exercised "the existing value survives". The behaviour that caused the
// defect was completely unasserted, which is why it was documented BACKWARDS
// ("first-writer-wins") until QA ran it against a live database.
//
// So this file asserts the new rule in both directions, and every one of its cases is
// written to go red if the comparison is weakened rather than only if it is deleted.
//
//     write iff incoming is non-NULL AND (stored geo IS NULL OR incoming authority
//     is STRICTLY GREATER than the stored authority)
//
// THE ONE THAT MATTERS MOST is `venue.geo is a pure function of WHICH sources have run,
// not the order they ran in`. That is the property the product actually depends on: every
// distance number, every radius filter and every map pin reads this column, and a venue
// silently dropping out of a 5 km radius is invisible — it looks like fewer results, not
// an error. It fails against the pre-0025 code.
import { describe, it, expect, afterAll } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { resolveVenue } from '../../worker/core/venue';
import { VENUE_GEO_AUTHORITY } from '../../worker/core/venue-geo-authority';
import { ingestSource } from '../../worker/core/ingest';
import type { Adapter, StructuredRecord } from '../../worker/core/adapter';

const hasDb = Boolean(process.env.DATABASE_URL);

/** Two real, measurably different points — the Killarney disagreement, ~802 m apart. */
const CITYCALENDAR_KILLARNEY = { lat: 49.2214, lng: -123.0398 };
const ACTIVENET_KILLARNEY = { lat: 49.2274, lng: -123.0444 };

interface StoredGeo {
  lat: number | null;
  lng: number | null;
  geo_hex: string | null;
  geo_authority: number | null;
  geo_source: string | null;
  geo_attribution: string | null;
  geo_set_at: string | null;
}

async function storedGeo(name: string): Promise<StoredGeo> {
  const [row] = await query<StoredGeo>(
    `SELECT ST_Y(geo::geometry) AS lat,
            ST_X(geo::geometry) AS lng,
            geo::text           AS geo_hex,
            geo_authority, geo_source, geo_attribution, geo_set_at::text
     FROM venue WHERE lower(name) = lower($1)`,
    [name]
  );
  return row;
}

const createdNames: string[] = [];
function venueName(label: string): string {
  const name = `VAUTH ${label} ${crypto.randomUUID()}`;
  createdNames.push(name);
  return name;
}

describe.skipIf(!hasDb)('G-VGEO-A2 — authority-ranked venue geo write', () => {
  afterAll(async () => {
    // Detach, then drop the venue rows. The end-to-end ingest case leaves a series and an
    // occurrence behind, and an occurrence has children of its own (tags, age bands,
    // provenance) with no ON DELETE CASCADE — chasing that graph from here would be a
    // second, more fragile copy of the deletion order the account-deletion code already owns.
    // `activity_series.venue_id` is nullable, so detaching is enough to let the venue go, and
    // the orphaned series/occurrence rows are the same residue every other DB suite in this
    // repo leaves on a disposable database.
    for (const name of createdNames) {
      const venueScope = `SELECT id FROM venue WHERE lower(name) = lower($1)`;
      await query(`UPDATE activity_series SET venue_id = NULL WHERE venue_id IN (${venueScope})`, [name]);
      await query(`DELETE FROM venue WHERE lower(name) = lower($1)`, [name]);
    }
    await closePool();
  });

  // ── the rule, in all four directions ──────────────────────────────────────────────

  it('HIGHER authority overwrites a lower-authority incumbent', async () => {
    const pool = getPool();
    const name = venueName('higher-wins');
    await resolveVenue(pool, {
      name,
      ...CITYCALENDAR_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
      geoSource: 'citycalendar:vancouver:config',
    });
    await resolveVenue(pool, {
      name,
      ...ACTIVENET_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.COMMITTED_OPEN_DATA,
      geoSource: 'activenet:opendata-vancouver',
      geoAttribution: 'ogl-vancouver',
    });

    const row = await storedGeo(name);
    expect(row.lat).toBeCloseTo(ACTIVENET_KILLARNEY.lat, 6);
    expect(row.lng).toBeCloseTo(ACTIVENET_KILLARNEY.lng, 6);
    // The provenance columns move as ONE unit with the coordinate. A row holding
    // activenet's point under citycalendar's attribution is exactly the false-provenance
    // claim that got the per-venue notice pulled (docs/source-register.md §6.6).
    expect(row.geo_authority).toBe(VENUE_GEO_AUTHORITY.COMMITTED_OPEN_DATA);
    expect(row.geo_source).toBe('activenet:opendata-vancouver');
    expect(row.geo_attribution).toBe('ogl-vancouver');
  });

  it('LOWER authority does NOT overwrite a higher-authority incumbent, and does not touch its provenance', async () => {
    const pool = getPool();
    const name = venueName('lower-loses');
    await resolveVenue(pool, {
      name,
      ...ACTIVENET_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.CURATED_PROVENANCED,
      geoSource: 'activenet:curated',
      geoAttribution: 'osm-odbl',
    });
    const before = await storedGeo(name);

    await resolveVenue(pool, {
      name,
      ...CITYCALENDAR_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.LIVE_VENDOR_PAYLOAD,
      geoSource: 'eventbrite:api-venue',
    });

    const after = await storedGeo(name);
    expect(after.geo_hex, 'a losing write must not move the coordinate by one bit').toBe(before.geo_hex);
    expect(after.geo_authority).toBe(VENUE_GEO_AUTHORITY.CURATED_PROVENANCED);
    expect(after.geo_source).toBe('activenet:curated');
    expect(after.geo_attribution, 'a losing write must not overwrite the winner\'s attribution').toBe('osm-odbl');
    expect(after.geo_set_at, 'nor its timestamp').toBe(before.geo_set_at);
  });

  it('EQUAL authority leaves the incumbent (strictly-greater, not greater-or-equal)', async () => {
    const pool = getPool();
    const name = venueName('equal-holds');
    await resolveVenue(pool, {
      name,
      ...CITYCALENDAR_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
      geoSource: 'first',
    });
    await resolveVenue(pool, {
      name,
      ...ACTIVENET_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
      geoSource: 'second',
    });

    const row = await storedGeo(name);
    // Weakening the comparison to `>=` makes this the second writer's point. That single
    // character is the difference between order-independent and order-dependent, so it is
    // asserted rather than trusted to review.
    expect(row.lat).toBeCloseTo(CITYCALENDAR_KILLARNEY.lat, 6);
    expect(row.geo_source).toBe('first');
  });

  it('LOWER authority still FILLS a NULL geo — arbitration is not gap-refusal', async () => {
    const pool = getPool();
    const name = venueName('null-fill');
    await resolveVenue(pool, { name, address: '123 Nowhere St' });
    expect((await storedGeo(name)).geo_hex).toBeNull();

    await resolveVenue(pool, {
      name,
      ...CITYCALENDAR_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL,
      geoSource: 'geocoder:mapbox-backfill',
    });
    const row = await storedGeo(name);
    expect(row.lat).toBeCloseTo(CITYCALENDAR_KILLARNEY.lat, 6);
    expect(row.geo_authority).toBe(VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL);
  });

  it('an incoming record with NO coordinate preserves both the point and its provenance', async () => {
    // The asymmetry that makes single-writer coverage stable. It is asserted here because
    // the new SET list touches five geo columns instead of one, and "no coordinate sent"
    // must leave all five alone rather than blanking four of them.
    const pool = getPool();
    const name = venueName('null-incoming');
    await resolveVenue(pool, {
      name,
      ...ACTIVENET_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.CURATED_PROVENANCED,
      geoSource: 'activenet:curated',
      geoAttribution: 'osm-odbl',
    });
    const before = await storedGeo(name);
    await resolveVenue(pool, { name, address: '456 Later Ave', phone: '(604) 555-0100' });
    const after = await storedGeo(name);

    expect(after.geo_hex).toBe(before.geo_hex);
    expect(after.geo_authority).toBe(before.geo_authority);
    expect(after.geo_source).toBe(before.geo_source);
    expect(after.geo_attribution).toBe(before.geo_attribution);
  });

  // ── the legacy settling event ─────────────────────────────────────────────────────

  it('a legacy (authority 0) incumbent is outranked exactly once, then holds', async () => {
    // Migration 0025 stamps every pre-existing coordinate 0 so the first DECLARED source
    // settles the row onto an attributed point — once. This reproduces that row shape
    // directly, because after the migration runs there is no other way to make one.
    const pool = getPool();
    const name = venueName('legacy');
    await query(
      `INSERT INTO venue (name, geo, geo_authority)
       VALUES ($1, ST_SetSRID(ST_MakePoint($3::double precision, $2::double precision), 4326)::geography, 0)`,
      [name, CITYCALENDAR_KILLARNEY.lat, CITYCALENDAR_KILLARNEY.lng]
    );

    await resolveVenue(pool, {
      name,
      ...ACTIVENET_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL,
      geoSource: 'geocoder:mapbox-backfill',
    });
    const settled = await storedGeo(name);
    expect(settled.lat, 'even the weakest declared source outranks an unattributed legacy point').toBeCloseTo(
      ACTIVENET_KILLARNEY.lat,
      6
    );

    // ...and now it holds: a second tier-5 write cannot move it again.
    await resolveVenue(pool, {
      name,
      ...CITYCALENDAR_KILLARNEY,
      geoAuthority: VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL,
      geoSource: 'geocoder:mapbox-backfill',
    });
    expect((await storedGeo(name)).geo_hex).toBe(settled.geo_hex);
  });

  // ── the declaration is mandatory ──────────────────────────────────────────────────

  it('a coordinate with NO declared authority throws, naming the venue', async () => {
    const pool = getPool();
    const name = venueName('undeclared');
    await expect(
      resolveVenue(pool, { name, ...ACTIVENET_KILLARNEY } as Parameters<typeof resolveVenue>[1])
    ).rejects.toThrow(/geoAuthority/);
    // and nothing was written — the throw happens before the SELECT, not halfway through
    const [row] = await query<{ n: string }>(`SELECT name AS n FROM venue WHERE lower(name) = lower($1)`, [
      name,
    ]);
    expect(row).toBeUndefined();
  });

  it('the database refuses a coordinate with no authority even if the application is bypassed', async () => {
    // The CHECK from 0025. Belt to the application's braces: the write rule has nothing to
    // rank an unattributed point against, so such a row is not merely undocumented, it is
    // UNCOMPARABLE — and this makes it unrepresentable rather than unlikely.
    const name = venueName('check-constraint');
    await expect(
      query(
        `INSERT INTO venue (name, geo)
         VALUES ($1, ST_SetSRID(ST_MakePoint(-123.0, 49.0), 4326)::geography)`,
        [name]
      )
    ).rejects.toThrow(/venue_geo_authority_paired/);
  });

  // ── scalars are unchanged ─────────────────────────────────────────────────────────

  it('SCALAR fields are still last-writer-wins — the change is scoped to geo', async () => {
    const pool = getPool();
    const name = venueName('scalars');
    await resolveVenue(pool, { name, address: 'First St', phone: '(604) 111-1111' });
    await resolveVenue(pool, { name, address: 'Second Ave', phone: '(604) 222-2222' });
    const [row] = await query<{ address: string; phone: string }>(
      `SELECT address, phone FROM venue WHERE lower(name) = lower($1)`,
      [name]
    );
    expect(row.address).toBe('Second Ave');
    expect(row.phone).toBe('(604) 222-2222');
  });

  // ── THE ONE THAT MATTERS ──────────────────────────────────────────────────────────

  it('venue.geo is a pure function of WHICH sources ran, not the order they ran in', async () => {
    // The A2 acceptance criterion, run against a live-shaped database rather than reasoned
    // about: the two families that genuinely disagree about this venue are fed in BOTH
    // orders and the stored bytes must match. Against the pre-0025 code this fails on the
    // first assertion — which is precisely how the defect reached production.
    const pool = getPool();
    const cityFirst = venueName('order-city-first');
    const activenetFirst = venueName('order-activenet-first');

    const city = (name: string) =>
      resolveVenue(pool, {
        name,
        ...CITYCALENDAR_KILLARNEY,
        geoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
        geoSource: 'citycalendar:vancouver:config',
      });
    const activenet = (name: string) =>
      resolveVenue(pool, {
        name,
        ...ACTIVENET_KILLARNEY,
        geoAuthority: VENUE_GEO_AUTHORITY.COMMITTED_OPEN_DATA,
        geoSource: 'activenet:opendata-vancouver',
        geoAttribution: 'ogl-vancouver',
      });

    await city(cityFirst);
    await activenet(cityFirst);

    await activenet(activenetFirst);
    await city(activenetFirst);

    const a = await storedGeo(cityFirst);
    const b = await storedGeo(activenetFirst);
    expect(b.geo_hex, 'ingest order changed the stored coordinate').toBe(a.geo_hex);
    expect(b.geo_authority).toBe(a.geo_authority);
    expect(b.geo_source).toBe(a.geo_source);
    expect(b.geo_attribution).toBe(a.geo_attribution);
    // and it settled on the higher-authority source, not on a coin flip
    expect(a.lat).toBeCloseTo(ACTIVENET_KILLARNEY.lat, 6);
  });

  // ── the middle hop ────────────────────────────────────────────────────────────────

  it('venueGeoAuthority survives StructuredRecord → ingest.ts → resolveVenue → the venue row', async () => {
    // Same guard, and the same reasoning, as the venuePhone end-to-end test in
    // tests/ingestion/venue.test.ts: the ingest.ts hop that reads `record.venueGeoAuthority`
    // into the resolveVenue() call has no other test. Delete that line and this goes red
    // naming the field — as does every other geo-bearing ingest, because resolveVenue
    // refuses a coordinate it cannot rank.
    const pool = getPool();
    const name = venueName('ingest-hop');
    const record: StructuredRecord = {
      sourceRecordId: `vauth-${crypto.randomUUID()}`,
      title: 'Public Skate',
      venueName: name,
      venueLat: ACTIVENET_KILLARNEY.lat,
      venueLng: ACTIVENET_KILLARNEY.lng,
      venueGeoAuthority: VENUE_GEO_AUTHORITY.COMMITTED_OPEN_DATA,
      venueGeoSource: 'activenet:opendata-vancouver',
      venueGeoAttribution: 'ogl-vancouver',
      venueMunicipalityName: 'Vancouver',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      costStatus: 'free',
      sourceUrl: 'https://example.org/vauth',
    };
    const adapter: Adapter = {
      family: 'activenet',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: (r) => ({ key: `vauth::${r.sourceRecordId}` }),
    };
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status) VALUES ('activenet', $1, 'allowed') RETURNING id`,
      [`VAUTH Source ${crypto.randomUUID()}`]
    );

    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);

    const row = await storedGeo(name);
    expect(row.geo_authority).toBe(VENUE_GEO_AUTHORITY.COMMITTED_OPEN_DATA);
    expect(row.geo_source).toBe('activenet:opendata-vancouver');
    expect(row.geo_attribution).toBe('ogl-vancouver');
  });
});
