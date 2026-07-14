import { afterEach, describe, it, expect, vi } from 'vitest';
import { CityCalendarAdapter, getCityCalendar } from '../../worker/adapters/citycalendar';

// KIDS FUN Task 9 — City of Vancouver events calendar (Trumba public JSON feed).
// The city_calendar adapter consumes a municipality's public calendar-syndication
// feed (plain GET, no login / CSRF / CAPTCHA / headless render), attaching
// deterministic venue geo for recurring recreation venues — no geocoder at ingest.

const TRUMBA_FIXTURE = [
  {
    eventID: 204262940,
    seriesID: null,
    title: 'Free Synchronized Swimming Try-it Class for Kids',
    description: 'A free drop-in class for kids ages 6-12 at the pool.',
    location:
      '<a href="http://maps.google.com/?q=Renfrew+Pool%2C+2929+East+22nd+Ave%2C+Vancouver%2C+BC%2C+Canada" target="_blank" rel="noopener">Renfrew Pool, 2929 East 22nd Ave, Vancouver, </a>',
    locationType: 'In-Person',
    startDateTime: '2026-07-18T15:00:00',
    endDateTime: '2026-07-18T16:00:00',
    startTimeZoneOffset: '-0700',
    endTimeZoneOffset: '-0700',
    allDay: false,
    canceled: false,
    requiresPayment: false,
    permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/204262940',
    customFields: [{ fieldID: 41996, label: 'Event type', value: 'Sports / run / walk', type: 'text' }],
  },
  {
    eventID: 204574662,
    seriesID: 204574628,
    title: 'FIFA Fan Festival&#8482; Vancouver',
    description: 'A free, accessible Festival for all, from families to devoted football fans.',
    location: '<a href="http://maps.google.com/?q=Hastings+Park%2C+2901+E+Hastings+St%2C+Vancouver%2C+BC">Hastings Park</a>',
    locationType: 'In-Person',
    startDateTime: '2026-07-14T10:00:00',
    endDateTime: '2026-07-14T18:00:00',
    startTimeZoneOffset: '-0700',
    endTimeZoneOffset: '-0700',
    allDay: false,
    canceled: false,
    requiresPayment: false,
    permaLinkUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events/-/204574662',
    customFields: [{ fieldID: 41996, label: 'Event type', value: 'Celebration / festival', type: 'text' }],
  },
  {
    eventID: 204769892,
    title: 'Music in the Park',
    description: 'Free outdoor concert for all ages in the park.',
    location: '<a href="http://maps.google.com/?q=Connaught+Park%2C+2690+Larch+Street%2C+Vancouver">Connaught Park - 2690 Larch Street</a>',
    locationType: 'In-Person',
    startDateTime: '2026-08-08T11:00:00',
    startTimeZoneOffset: '-0700',
    canceled: false,
    requiresPayment: false,
    customFields: [{ fieldID: 41996, label: 'Event type', value: 'Celebration / festival', type: 'text' }],
  },
  {
    eventID: 999999999,
    title: 'Cancelled Program',
    location: '<a href="http://maps.google.com/?q=Trout+Lake+Community+Centre">Trout Lake Community Centre</a>',
    startDateTime: '2026-07-20T10:00:00',
    startTimeZoneOffset: '-0700',
    canceled: true,
    requiresPayment: false,
  },
];

function stubFetchJson(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('CityCalendar adapter — City of Vancouver Trumba feed (Task 9)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_CITY_CALENDARS;
  });

  it('is live-enabled only when vancouver is in KIDS_FUN_LIVE_CITY_CALENDARS', () => {
    const config = getCityCalendar('vancouver')!;
    const adapter = new CityCalendarAdapter(config);
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    expect(adapter.isLiveFetchEnabled()).toBe(true);
    expect(config.feedUrl).toContain('trumba.com/calendars/city-of-vancouver-events.json');
    expect(config.sourceFamily).toBe('city_calendar');
    expect(config.sourceName).toBe('City of Vancouver events calendar');
  });

  it('fetches the public JSON feed and parses UTC dates, deterministic venue geo, cost + dedup key', async () => {
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    const fetchMock = stubFetchJson(TRUMBA_FIXTURE);

    const config = getCityCalendar('vancouver')!;
    const adapter = new CityCalendarAdapter(config);
    const records = await adapter.extract(await adapter.fetch());

    // The feed URL was hit (single GET), and the cancelled item was dropped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('city-of-vancouver-events.json');
    expect(records).toHaveLength(3);

    // Venue label is split on " - " too, so it matches the deterministic geo map.
    const park = records[2];
    expect(park.venueName).toBe('Connaught Park');
    expect(park.venueLat).toBeCloseTo(49.2637, 3);

    const swim = records[0];
    expect(swim.sourceRecordId).toBe('204262940');
    // 10:00-07:00 style conversion: 15:00 local (-0700) => 22:00Z.
    expect(swim.startDatetimeUtc).toBe('2026-07-18T22:00:00.000Z');
    expect(swim.venueName).toBe('Renfrew Pool');
    // Deterministic geo attached from config (no geocoder).
    expect(swim.venueLat).toBeCloseTo(49.2506, 3);
    expect(swim.venueLng).toBeCloseTo(-123.0432, 3);
    expect(swim.venueMunicipalityName).toBe('Vancouver');
    expect(swim.costStatus).toBe('free');
    expect(swim.categoryHint).toBe('public_swim');
    expect(swim.ageText?.toLowerCase()).toContain('kids');
    expect(adapter.dedupKeys(swim).key).toBe('city_calendar::vancouver::204262940');

    const fifa = records[1];
    expect(fifa.title).toBe('FIFA Fan Festival™ Vancouver');
    expect(fifa.venueName).toBe('Hastings Park');
    expect(fifa.venueLat).toBeCloseTo(49.2819, 3);
    expect(fifa.categoryHint).toBe('festival_event');
    expect(fifa.sourceUrl).toContain('trumba.com/calendars/city-of-vancouver-events');
  });

  it('does not make a live request when the calendar is not enabled (fixture-only)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = getCityCalendar('vancouver')!;
    const adapter = new CityCalendarAdapter(config);
    const records = await adapter.extract(await adapter.fetch());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0].costStatus).toBe('free');
  });
});
