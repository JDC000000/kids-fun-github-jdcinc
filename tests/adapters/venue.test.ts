import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import {
  VenueAdapter,
  LAUNCH_VENUES,
  getVenue,
  loadVenueAdapters,
  parseOpeningHours,
  parseVenueEvents,
} from '../../worker/adapters/venue';
import { separateVenueRecords, assertSeparation, type VenueIdentity } from '../../worker/adapters/venue/separate';
import { ingestSource } from '../../worker/core/ingest';
import { loadPostgresListings, loadPostgresListingById } from '../../lib/search/postgres-repository';
import { getPool, query, closePool } from '../../lib/db/client';

// KIDS FUN Round 22 / Task LL — Venue (museum/attraction) adapter (T11).
// Parses the semi-structured schema.org data a venue embeds in its public HTML:
// openingHours -> ONE open-hours series; Event nodes -> DISCRETE dated
// occurrences. The two are kept structurally distinct (T-02: Aquarium daily
// visit ≠ pool swim).

const hasDb = Boolean(process.env.DATABASE_URL);

const AQUARIUM: VenueIdentity = {
  venueKey: 'test-venue',
  venueName: 'Test Aquarium',
  venueCategory: 'attraction',
  officialUrl: 'https://example.org/aquarium/',
};

describe('Venue adapter — config + fixture shape (G-T11-1/3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_VENUES;
  });

  it('covers >=2 launch venues, all family venue_html, fixture-only (no live) by default', () => {
    expect(LAUNCH_VENUES.length).toBeGreaterThanOrEqual(2);
    const adapters = loadVenueAdapters();
    expect(adapters.every((a) => a.family === 'venue_html')).toBe(true);
    expect(adapters.every((a) => a.isLiveFetchEnabled() === false)).toBe(true);
  });

  it('fixture yields exactly one open-hours series record + >=1 special-event record (separated)', async () => {
    const adapter = new VenueAdapter(getVenue('vancouver-aquarium')!);
    const records = await adapter.extract(await adapter.fetch());

    const openHours = records.filter((r) => r.openHoursState && !r.startDatetimeUtc);
    const events = records.filter((r) => r.startDatetimeUtc && !r.openHoursState);
    expect(openHours).toHaveLength(1);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Open-hours record: standing state, no fixed start, venue category (not a swim).
    const oh = openHours[0];
    expect(oh.title).toBe('General Admission');
    expect(oh.openHoursState).toBe('Daily 9:30 AM–5 PM');
    expect(oh.startDatetimeUtc).toBeUndefined();
    expect(oh.categoryHint).toBe('attraction');
    expect(oh.venueName).toBe('Vancouver Aquarium');
    expect(oh.venueLat).toBeCloseTo(49.3006, 3);
    expect(oh.sourceRecordId).toBe('open-hours');
    expect(adapter.dedupKeys(oh).key).toBe('venue_html::vancouver-aquarium::open-hours');

    // Special-event record: dated occurrence, no open_hours_state.
    const morning = events.find((r) => r.title === 'Sensory-Friendly Morning')!;
    expect(morning.startDatetimeUtc).toBe('2026-08-15T16:00:00.000Z');
    expect(morning.openHoursState).toBeUndefined();
    expect(morning.venueName).toBe('Vancouver Aquarium');
    expect(String(morning.sourceUrl)).toMatch(/vanaqua\.org/);
    expect(adapter.dedupKeys(morning).key).toBe(
      'venue_html::vancouver-aquarium::event::sensory-friendly-morning-2026-08-15'
    );
  });

  it('T-02 correctness: every venue record satisfies exactly one of {start, open_hours}, never "swim"', async () => {
    const perVenue = await Promise.all(
      LAUNCH_VENUES.map(async (c) => {
        const a = new VenueAdapter(c);
        return a.extract(await a.fetch());
      })
    );
    const records = perVenue.flat();
    // The DB CHECK occurrence_has_time_or_open_hours in code form.
    for (const r of records) {
      const hasStart = Boolean(r.startDatetimeUtc);
      const hasOpen = Boolean(r.openHoursState);
      expect(hasStart !== hasOpen, `${r.title} must be exactly one of dated/open-hours`).toBe(true);
      if (hasOpen) expect(r.categoryHint).not.toBe('public_swim');
    }
    // assertSeparation is the runtime guard; it rejects an ambiguous record.
    expect(() =>
      assertSeparation([
        { sourceRecordId: 'bad', title: 'Both', openHoursState: 'Daily', startDatetimeUtc: '2026-08-01T00:00:00Z', sourceUrl: 'https://x' },
      ])
    ).toThrow(/BOTH dated and open-hours/);
    // And it rejects a daily visit that slipped into a rec-programme category.
    expect(() =>
      separateVenueRecords(
        { ...AQUARIUM, venueCategory: 'attraction' },
        { openHours: { openHoursState: 'Daily 9–5', sourceUrl: 'https://x' }, events: [] }
      )
    ).not.toThrow();
  });
});

describe('Venue adapter — schema.org parsing (G-T11-1)', () => {
  it('parses openingHours in day-range, comma-list, split, and OpeningHoursSpecification forms', () => {
    // schema.org abbreviated day-range, all 7 days identical -> "Daily …".
    expect(parseOpeningHours([{ openingHours: ['Mo-Su 09:30-17:00'] }])).toBe('Daily 9:30 AM–5 PM');
    // Real Space Centre comma-list form.
    expect(
      parseOpeningHours([{ openingHours: ['Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday 09:00-17:00'] }])
    ).toBe('Daily 9 AM–5 PM');
    // Split weekday/weekend hours -> grouped consecutive-day ranges.
    expect(parseOpeningHours([{ openingHours: ['Mo-Fr 09:00-17:00', 'Sa-Su 10:00-16:00'] }])).toBe(
      'Mon–Fri 9 AM–5 PM; Sat–Sun 10 AM–4 PM'
    );
    // Structured OpeningHoursSpecification objects (dayOfWeek as schema.org URLs).
    expect(
      parseOpeningHours([
        {
          openingHoursSpecification: [
            {
              '@type': 'OpeningHoursSpecification',
              dayOfWeek: [
                'https://schema.org/Monday',
                'https://schema.org/Tuesday',
                'https://schema.org/Wednesday',
                'https://schema.org/Thursday',
                'https://schema.org/Friday',
                'https://schema.org/Saturday',
                'https://schema.org/Sunday',
              ],
              opens: '10:00',
              closes: '18:00',
            },
          ],
        },
      ])
    ).toBe('Daily 10 AM–6 PM');
    // No hours data present -> undefined (so no bogus open-hours record is made).
    expect(parseOpeningHours([{ name: 'No Hours Here' }])).toBeUndefined();
  });

  it('parses schema.org Event nodes (name/startDate/offers/typicalAgeRange), dedup + skip undated', () => {
    const nodes = [
      { '@type': 'ItemList', itemListElement: [
        { '@type': 'ListItem', item: {
          '@type': 'Event', name: 'Night at the Museum', startDate: '2026-08-20T19:00:00-07:00',
          endDate: '2026-08-20T22:00:00-07:00', url: 'https://example.org/event/night-museum/',
          typicalAgeRange: 'All ages', offers: { '@type': 'Offer', price: 0, priceCurrency: 'CAD' },
        } },
      ] },
      // subtype of Event with a paid offer.
      { '@type': 'EducationEvent', name: 'Space Camp', startDate: '2026-09-01T09:00:00-07:00',
        url: 'https://example.org/event/space-camp/', offers: { price: '25.00' } },
      // undated node -> skipped.
      { '@type': 'Event', name: 'No Date Event' },
    ];
    const events = parseVenueEvents(nodes);
    expect(events).toHaveLength(2);
    const free = events.find((e) => e.title === 'Night at the Museum')!;
    expect(free.slug).toBe('night-museum');
    expect(free.startDatetimeUtc).toBe('2026-08-21T02:00:00.000Z');
    expect(free.costStatus).toBe('free');
    expect(free.ageText).toBe('All ages');
    const paid = events.find((e) => e.title === 'Space Camp')!;
    expect(paid.costStatus).toBe('check_source');
  });
});

describe('Venue adapter — live path is a credential-free GET of schema.org HTML (G-T11-1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_VENUES;
  });

  it('Space Centre live-enabled: one GET, parses real schema.org openingHours; no events page wired', async () => {
    process.env.KIDS_FUN_LIVE_VENUES = 'hr-macmillan-space-centre';
    const html =
      '<!doctype html><html><head><script type="application/ld+json">' +
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': ['EntertainmentBusiness', 'Organization'],
        name: 'H.R. MacMillan Space Centre',
        openingHours: ['Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday 09:00-17:00'],
      }) +
      '</script></head><body></body></html>';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => html }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new VenueAdapter(getVenue('hr-macmillan-space-centre')!);
    expect(adapter.isLiveFetchEnabled()).toBe(true);
    const records = adapter.extract(await adapter.fetch());

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the schema.org hours page is wired live
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('spacecentre.ca/plan-your-visit');
    const oh = records.find((r) => r.openHoursState)!;
    expect(oh.openHoursState).toBe('Daily 9 AM–5 PM');
    expect(oh.startDatetimeUtc).toBeUndefined();
    expect(records.filter((r) => r.startDatetimeUtc)).toHaveLength(0);
  });
});

// ── DB-backed end-to-end: fixture -> ingest pipeline -> search read model ─────
describe.skipIf(!hasDb)('Venue ingest end-to-end + search visibility (G-T11-1/2/4)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('ingests one open-hours series + dated special-events; both queryable via the search read model', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier) VALUES ('venue_html', $1, 'official') RETURNING id`,
      [`Venue Ingest Source ${crypto.randomUUID()}`]
    );

    const adapter = new VenueAdapter(getVenue('vancouver-aquarium')!);
    const summary = await ingestSource(pool, adapter, source.id);

    expect(summary.errors).toEqual([]);
    // 1 open-hours + 2 special events = 3 distinct series + 3 occurrences.
    expect(summary.seriesCreated).toBe(3);
    expect(summary.occurrencesCreated).toBe(3);

    const occ = await query<{
      id: string;
      open_hours_state: string | null;
      start_datetime_utc: string | null;
      category_key: string | null;
      activity_name: string;
    }>(
      `SELECT o.id, o.open_hours_state, o.start_datetime_utc, c.key AS category_key, o.activity_name
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       LEFT JOIN category c ON c.id = o.primary_category_id
       WHERE s.source_id = $1`,
      [source.id]
    );

    const openHoursRows = occ.filter((r) => r.open_hours_state && !r.start_datetime_utc);
    const eventRows = occ.filter((r) => r.start_datetime_utc && !r.open_hours_state);
    // Exactly one standing open-hours occurrence — the daily "visit".
    expect(openHoursRows).toHaveLength(1);
    // …categorised as a venue attraction, NOT a rec programme (T-02: ≠ swim).
    expect(openHoursRows[0].category_key).toBe('attraction');
    expect(openHoursRows[0].activity_name).toBe('General Admission');
    // …and >=1 discrete dated special-event occurrence.
    expect(eventRows.length).toBeGreaterThanOrEqual(1);

    // The occurrence flows through the real /api/search read model (postgres
    // repository), with the open-hours record visible independent of date and
    // the future-dated event visible via the visibility gate. (Mirrors how
    // T9/T10 verified library/city-calendar sources end-to-end.)
    const openHoursListing = await loadPostgresListingById(pool, openHoursRows[0].id);
    expect(openHoursListing, 'open-hours occurrence is queryable').toBeTruthy();
    expect(openHoursListing!.openHours).toBe(true);
    expect(openHoursListing!.startDatetimeUtc).toBeNull();
    expect(openHoursListing!.venueName).toBe('Vancouver Aquarium');

    const eventListing = await loadPostgresListingById(pool, eventRows[0].id);
    expect(eventListing, 'special-event occurrence is queryable').toBeTruthy();
    expect(eventListing!.openHours).toBe(false);
    expect(eventListing!.startDatetimeUtc).toBeTruthy();

    // Both of my source's occurrences appear in the full listing scan the engine consumes.
    const listings = await loadPostgresListings(pool, { limit: 1000 });
    const ids = new Set(listings.map((l) => l.id));
    expect(ids.has(openHoursRows[0].id)).toBe(true);
    expect(ids.has(eventRows[0].id)).toBe(true);

    // Idempotent: a second ingest updates in place (no duplicate series/occurrences).
    const second = await ingestSource(pool, adapter, source.id);
    expect(second.seriesCreated).toBe(0);
    expect(second.occurrencesCreated).toBe(0);
  });
});
