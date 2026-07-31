// tests/adapters/activenet.test.ts — G-T7R-5: contract fixtures + breakage detection for
// the live ActiveCommunities adapter (T7 REBUILD).
//
// These endpoints are undocumented, unversioned and unofficial: they can change without
// notice, and the dangerous failure is the SILENT one (a key moves, the parser yields
// nothing, a municipality quietly empties while the run still says "success"). So the
// suite pins three separate things:
//
//   • PARSER STABILITY against payloads captured verbatim from the live portal on
//     2026-07-30 (worker/adapters/activenet/__fixtures__/). Trimmed by COUNT only —
//     no record was hand-edited — so an assertion here is an assertion about real data.
//   • THE PORTAL BUILD STAMP (window.__version / __cuiVersion) as an explicit canary.
//   • BREAKAGE DETECTION: an unrecognised top-level payload key, or a yield collapse
//     against the trailing baseline, must produce a source_check_run failure rather
//     than a green run over an empty municipality.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ACTIVENET_TENANTS,
  ACTIVENET_PORTAL_VERSION,
  ActiveNetAdapter,
  getTenantConfig,
  ingestableTenants,
  loadActiveNetAdapters,
  defaultWindow,
} from '../../worker/adapters/activenet';
import {
  RequestBudget,
  fetchTenant,
  PortalBlockedError,
  PortalRateLimitedError,
  PortalProtocolError,
  RequestCapExceededError,
  ENDPOINTS,
  type ActiveNetCentreEvents,
  type CalendarFetchResult,
} from '../../worker/adapters/activenet/client';
import {
  parseTenantCalendars,
  classifyCost,
  stripCentreSentinel,
  occurrenceRecordId,
} from '../../worker/adapters/activenet/parse';
import { buildVenueIndex, applyVenues } from '../../worker/adapters/activenet/venues';
import { assessRunHealth, loadYieldBaseline, YIELD_COLLAPSE_RATIO } from '../../worker/adapters/activenet/health';
import { zonedLocalToUtcIso } from '../../worker/core/time';
import { clearPolicyState } from '../../worker/health/policy';

const FIXTURES = join(process.cwd(), 'worker/adapters/activenet/__fixtures__');
const ORIGINAL_ENV = { ...process.env };

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

interface EventsFixture {
  body: { center_events: ActiveNetCentreEvents[] };
}

/** Wrap a captured events payload as the client's per-calendar result. */
function asCalendar(name: string, calendarId: number, calendarName: string): CalendarFetchResult {
  const groups = fixture<EventsFixture>(name).body.center_events;
  return {
    calendarId,
    calendarName,
    centreIds: groups.map((g) => g.center_id),
    centreNames: Object.fromEntries(groups.map((g) => [g.center_id, g.center_name ?? ''])),
    centreEvents: groups,
    occurrenceCount: groups.reduce((n, g) => n + (g.events?.length ?? 0), 0),
    warnings: [],
  };
}

const VANCOUVER = getTenantConfig('vancouver')!;
const BURNABY = getTenantConfig('burnaby')!;
/** The captured window — used so fixture assertions don't drift with the wall clock. */
const CAPTURE_WINDOW = { startDate: '2026-07-26', endDate: '2026-11-08' };

// H6 added per-request/run logging to the client (see the file header there and
// tests/adapters/activenet-observability.test.ts, which asserts on it). This suite drives
// fetchTenant more than a dozen times, including a 23-calendar cap run, so its output is
// silenced here to keep the report readable. Silenced, not disabled: the logging's own
// contract is tested in the file above.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  clearPolicyState();
});

// ── G-T7R-1 config ───────────────────────────────────────────────────────────────────

describe('G-T7R-1 ActiveCommunities tenant config', () => {
  it('is keyed by portal tenant and loads ≥2 ingestable municipalities', () => {
    expect(ingestableTenants().map((t) => t.tenantKey).sort()).toEqual(['burnaby', 'vancouver']);
    expect(VANCOUVER.host).toBe('anc.ca.apm.activecommunities.com');
    expect(VANCOUVER.sitePath).toBe('/vancouver');
    expect(VANCOUVER.timezone).toBe('America/Vancouver');
    expect(VANCOUVER.dropInCalendarIds).toHaveLength(23); // 24 listed − 1 UI placeholder
    expect(BURNABY.dropInCalendarIds).toHaveLength(17);
  });

  it('config matches the calendars the portal actually returned (fixture-pinned)', () => {
    for (const [tenantKey, file] of [
      ['vancouver', 'vancouver.calendars.json'],
      ['burnaby', 'burnaby.calendars.json'],
    ] as const) {
      const listed = fixture<{ body: { calendars: Array<{ calendar_id: number; name: string }> } }>(file)
        .body.calendars.filter((c) => !/choose a calendar/i.test(c.name));
      expect(getTenantConfig(tenantKey)!.dropInCalendarIds.slice().sort((a, b) => a - b)).toEqual(
        listed.map((c) => c.calendar_id).sort((a, b) => a - b)
      );
    }
  });

  it('West Vancouver is present, NOT ingestable, and records the measured ZERO', () => {
    // The honest negative: the tenant is live but its online-calendar module is empty.
    // Recording it (rather than omitting it) is what stops it being counted as coverage.
    const wv = getTenantConfig('west_vancouver')!;
    expect(wv.dropInCalendarIds).toEqual([]);
    expect(wv.enabled).toBe(false);
    expect(wv.evidenceNote).toMatch(/ZERO drop-in coverage/i);
    expect(fixture<{ body: { calendars: unknown[] } }>('west-vancouver.calendars.json').body.calendars).toEqual([]);
    expect(ingestableTenants().map((t) => t.tenantKey)).not.toContain('west_vancouver');
  });

  it('every tenant carries measured evidence, not aspiration', () => {
    for (const tenant of ACTIVENET_TENANTS) {
      expect(tenant.evidenceNote.length, `${tenant.tenantKey} needs an evidenceNote`).toBeGreaterThan(40);
      expect(tenant.maxRequestsPerRun).toBeGreaterThan(0);
    }
  });

  it('preserves the historical official-API evidence that justified the rebuild', () => {
    // The prior T7 pass excluded ActiveNet on DATA grounds (official API syndication
    // ceased ~2024-06). That evidence explains why this file is keyed by portal tenant
    // and must not be deleted when someone tidies the header.
    const src = readFileSync(join(process.cwd(), 'worker/adapters/activenet/config.ts'), 'utf8');
    expect(src).toMatch(/syndication CEASED ~2024-06/);
    expect(src).toMatch(/2025→0 · 2026→0/);
  });
});

// ── G-T7R-5 breakage canary ──────────────────────────────────────────────────────────

describe('G-T7R-5 payload contract is pinned to the real captured shape', () => {
  // The shape-drift canary in client.ts only works if its "recognised keys" set is
  // actually the truth about the wire format. These cases assert the captured payloads
  // against an EXPLICIT expected set declared here — not imported from the code under
  // test — so a drift in either direction shows up.
  const EXPECTED_BODY_KEYS: Array<[string, string[]]> = [
    ['vancouver.calendars.json', ['calendars']],
    ['burnaby.calendars.json', ['calendars']],
    ['west-vancouver.calendars.json', ['calendars']],
    [
      'vancouver.filters.calendar-5.json',
      [
        'center',
        'activity',
        'activity_category',
        'facilities',
        'calendar_period',
        'event_types',
        'activity_center',
        'activity_sub_category',
        'permit_center',
      ],
    ],
    [
      'burnaby.filters.calendar-1.json',
      [
        'center',
        'activity',
        'activity_category',
        'facilities',
        'calendar_period',
        'event_types',
        'activity_center',
        'activity_sub_category',
        'permit_center',
      ],
    ],
    ['vancouver.events.calendar-5.json', ['center_events']],
    ['burnaby.events.calendar-1.json', ['center_events']],
    ['vancouver.centerdetails.json', ['center_details']],
    ['burnaby.centerdetails.json', ['center_details']],
  ];

  for (const [file, keys] of EXPECTED_BODY_KEYS) {
    it(`${file} carries exactly the recognised top-level keys`, () => {
      const body = fixture<{ body: Record<string, unknown> }>(file).body;
      expect(Object.keys(body).sort()).toEqual([...keys].sort());
    });
  }

  it('the event record shape is stable across both tenants', () => {
    const EXPECTED_EVENT_KEYS = [
      'title',
      'start_time',
      'end_time',
      'event_type',
      'description',
      'event_item_id',
      'online_new_activity',
      'activity_detail_url',
      'activity_location_desc',
      'facilities',
      'reservation_event_type_id',
      'price',
      'instructors',
      'background_color',
      'text_color',
      'action_link',
      'allow_flexible_class',
    ].sort();
    for (const file of ['vancouver.events.calendar-5.json', 'burnaby.events.calendar-1.json']) {
      const event = fixture<EventsFixture>(file).body.center_events[0].events![0];
      expect(Object.keys(event).sort(), file).toEqual(EXPECTED_EVENT_KEYS);
    }
  });
});

describe('G-T7R-5 portal build-stamp canary', () => {
  it('pins the observed __version / __cuiVersion for both tenants', () => {
    const pinned = fixture<{
      tenants: Record<string, { version: string; cuiVersion: string }>;
    }>('portal-version.json');
    expect(ACTIVENET_PORTAL_VERSION.version).toBe('26.9.53');
    expect(ACTIVENET_PORTAL_VERSION.cuiVersion).toBe('26.9.37');
    for (const tenantKey of ['vancouver', 'burnaby']) {
      expect(pinned.tenants[tenantKey].version, `${tenantKey} __version`).toBe(
        ACTIVENET_PORTAL_VERSION.version
      );
      expect(pinned.tenants[tenantKey].cuiVersion, `${tenantKey} __cuiVersion`).toBe(
        ACTIVENET_PORTAL_VERSION.cuiVersion
      );
    }
  });
});

// ── G-T7R-3 time: the DST trap ───────────────────────────────────────────────────────

describe('G-T7R-3 offset-less local time → UTC is DST-correct', () => {
  it('round-trips a fixture spanning both 2026 America/Vancouver transitions', () => {
    const calendar = asCalendar('dst-boundary.events.json', 5, 'DST boundary fixture');
    const { records } = parseTenantCalendars(VANCOUVER, [calendar], {
      window: { startDate: '2026-03-01', endDate: '2026-11-30' },
    });
    const byTitle = new Map(records.map((r) => [r.title, r.startDatetimeUtc]));

    // Fall-back (2026-11-01 02:00 PDT → 01:00 PST).
    expect(byTitle.get('Before fall-back (PDT, UTC-7)')).toBe('2026-10-31T17:00:00.000Z');
    expect(byTitle.get('Fall-back morning, pre-transition (PDT)')).toBe('2026-11-01T07:30:00.000Z');
    // The 01:30 hour happens TWICE; we deliberately take the first (PDT) occurrence.
    expect(byTitle.get('Fall-back ambiguous hour (occurs twice)')).toBe('2026-11-01T08:30:00.000Z');
    expect(byTitle.get('Fall-back morning, post-transition (PST)')).toBe('2026-11-01T11:00:00.000Z');
    expect(byTitle.get('After fall-back (PST, UTC-8)')).toBe('2026-11-02T18:00:00.000Z');

    // Spring-forward (2026-03-08 02:00 PST → 03:00 PDT).
    expect(byTitle.get('Spring-forward morning, pre-transition (PST)')).toBe('2026-03-08T09:30:00.000Z');
    expect(byTitle.get('Spring-forward, post-transition (PDT)')).toBe('2026-03-08T10:30:00.000Z');
  });

  it('a fixed-offset reading would be wrong — the two sides differ by an hour', () => {
    // Guard against a "simplification" that hardcodes -07:00 or -08:00: the same local
    // wall-clock 10:00 is a DIFFERENT instant on either side of the transition.
    const summer = Date.parse(zonedLocalToUtcIso('2026-10-31 10:00:00', 'America/Vancouver')!);
    const winter = Date.parse(zonedLocalToUtcIso('2026-11-02 10:00:00', 'America/Vancouver')!);
    expect((winter - summer) % (24 * 3600_000)).toBe(3600_000);
  });

  it('the real captured payload parses to the right instant (PDT, UTC-7)', () => {
    expect(zonedLocalToUtcIso('2026-07-30 15:30:00', 'America/Vancouver')).toBe('2026-07-30T22:30:00.000Z');
  });
});

// ── G-T7R-3 cost honesty ─────────────────────────────────────────────────────────────

describe('G-T7R-3 cost status is corroborated, never asserted from price.free alone', () => {
  it('NEVER claims free when the description quotes a price — the measured contradiction', () => {
    // Real record: price.free === true AND estimate_price "no charge", but the
    // description says "Drop-in price is per child $3.00". Two "free" signals and a
    // contradicting fee — this is exactly the case that must not reach a parent as free.
    const calendar = asCalendar('vancouver.events.calendar-1.json', 1, '*Parent and Tot Activities');
    const { records } = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    const gymBugs = records.filter((r) => r.title === 'Gym Bugs Drop In');
    expect(gymBugs.length).toBeGreaterThan(0);
    for (const r of gymBugs) {
      expect(r.costStatus, 'a priced drop-in must never be reported free').toBe('check_source');
      expect(r.costMinCad).toBeUndefined();
    }
    // Sanity: the raw payload really does carry the misleading flag we are defending against.
    const raw = gymBugs[0].raw as { price: { free: boolean; estimate_price: string } };
    expect(raw.price.free).toBe(true);
    expect(raw.price.estimate_price).toBe('no charge');
  });

  it('claims free only on ≥2 corroborating signals', () => {
    const calendar = asCalendar('vancouver.events.calendar-1.json', 1, '*Parent and Tot Activities');
    const { records } = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    // "A free drop-in parent-participation program…" + free:true + "no charge" → free.
    const familyPlay = records.find((r) => r.title === 'Family Play Time');
    expect(familyPlay?.costStatus).toBe('free');
    expect(familyPlay?.costMinCad).toBe(0);
  });

  it('a lone price.free boolean is NOT enough', () => {
    expect(classifyCost({ price: { free: true, estimate_price: '' } }).costStatus).toBe('check_source');
    expect(classifyCost({ title: 'Open Gym', price: { free: true } }).costStatus).toBe('check_source');
  });

  it('"Check details for fees" maps to check_source — never coerced to 0, never dropped', () => {
    const verdict = classifyCost({
      title: 'Badminton Drop-in',
      price: { free: true, estimate_price: 'Check details for fees' },
    });
    expect(verdict.costStatus).toBe('check_source');
    expect(verdict.costMinCad).toBeUndefined();
  });

  it('a real amount is captured as a known cost', () => {
    const calendar = asCalendar('vancouver.events.calendar-32.json', 32, '*Kerrisdale Play Palace');
    const { records } = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    const playPalace = records.find((r) => r.title === 'Play Palace - 0-12 yrs');
    expect(playPalace?.costStatus).toBe('known');
    expect(playPalace?.costMinCad).toBe(6.22);
  });

  it('$0.00 is free', () => {
    expect(classifyCost({ price: { estimate_price: '$0.00' } })).toMatchObject({
      costStatus: 'free',
      costMinCad: 0,
    });
  });
});

// ── G-T7R-3 parse: identity, sentinels, closures, windowing ──────────────────────────

describe('G-T7R-3 parse against real captured payloads', () => {
  it('strips the leading * centre sentinel (Vancouver) and leaves Burnaby names intact', () => {
    // MEASURED: Vancouver 36/36 centres carry the sentinel, Burnaby 0/7 do.
    expect(stripCentreSentinel('*Hastings Community Centre')).toBe('Hastings Community Centre');
    expect(stripCentreSentinel('**Public Swimming')).toBe('Public Swimming');
    expect(stripCentreSentinel('Bonsor Recreation Complex (BON)')).toBe('Bonsor Recreation Complex (BON)');

    const van = parseTenantCalendars(VANCOUVER, [asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times')], {
      window: CAPTURE_WINDOW,
    });
    expect(van.records.every((r) => !r.venueName?.startsWith('*'))).toBe(true);
    expect(van.stats.centreSentinelsStripped).toBeGreaterThan(0);

    const bby = parseTenantCalendars(BURNABY, [asCalendar('burnaby.events.calendar-1.json', 1, 'Badminton')], {
      window: CAPTURE_WINDOW,
    });
    expect(bby.records.some((r) => r.venueName === 'Bonsor Recreation Complex (BON)')).toBe(true);
    expect(bby.stats.centreSentinelsStripped).toBe(0);
  });

  it('occurrence identity is unique — event_item_id alone is NOT (it is the activity id)', () => {
    const calendar = asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times');
    const { records } = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    expect(records.length).toBeGreaterThan(10);
    expect(new Set(records.map((r) => r.sourceRecordId)).size).toBe(records.length);
    // The underlying activity id genuinely repeats — which is why the composite exists.
    const activityIds = records.map((r) => (r.raw as { event_item_id: number }).event_item_id);
    expect(new Set(activityIds).size).toBeLessThan(records.length);
  });

  it('the same event at two facilities does not collapse into one record', () => {
    const base = { event_item_id: 1, start_time: '2026-08-03 10:00:00' };
    const a = occurrenceRecordId({ ...base, facilities: [{ facility_id: 10, center_id: 44 }] }, 44);
    const b = occurrenceRecordId({ ...base, facilities: [{ facility_id: 11, center_id: 44 }] }, 44);
    expect(a).not.toBe(b);
  });

  it('facility-closure notices are skipped and COUNTED, not silently dropped', () => {
    const calendar = asCalendar('vancouver.events.calendar-32.json', 32, '*Kerrisdale Play Palace');
    const { records, stats } = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    expect(stats.skippedClosures).toBeGreaterThan(0);
    expect(records.some((r) => /^CLOSED/i.test(r.title))).toBe(false);
    expect(stats.eventsSeen).toBe(stats.recordsEmitted + stats.skippedClosures + stats.skippedOutsideWindow);
  });

  it('windows client-side, because the vendor ignores start_date/end_date', () => {
    const calendar = asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times');
    const wide = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    const narrow = parseTenantCalendars(VANCOUVER, [calendar], {
      window: { startDate: '2026-08-03', endDate: '2026-08-09' },
    });
    expect(narrow.records.length).toBeLessThan(wide.records.length);
    expect(narrow.stats.skippedOutsideWindow).toBeGreaterThan(0);
    for (const r of narrow.records) {
      expect(r.startDatetimeUtc! >= '2026-08-03').toBe(true);
    }
  });

  it('captures raw age wording for T13 rather than forking its normaliser', () => {
    const calendar = asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times');
    const { records } = parseTenantCalendars(VANCOUVER, [calendar], { window: CAPTURE_WINDOW });
    const youth = records.find((r) => /Youth \(13-18yrs\)/.test(r.title));
    expect(youth?.ageText).toContain('13-18yrs');
    // No structured age fields are emitted here — worker/core/age.ts owns that.
    expect(Object.keys(records[0])).not.toContain('ageMinMonths');
  });

  it('reports a zero-yield calendar as a finding, not an absence', () => {
    const empty: CalendarFetchResult = {
      calendarId: 60,
      calendarName: 'Queer Inclusion',
      centreIds: [],
      centreNames: {},
      centreEvents: [],
      occurrenceCount: 0,
      warnings: [],
    };
    const { warnings } = parseTenantCalendars(VANCOUVER, [empty]);
    expect(warnings.join(' ')).toMatch(/calendar 60 .* returned zero occurrences/);
  });

  it('every emitted record carries a source URL and a start instant', () => {
    const calendars = [
      asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times'),
      asCalendar('vancouver.events.calendar-32.json', 32, '*Kerrisdale Play Palace'),
      asCalendar('burnaby.events.calendar-1.json', 1, 'Badminton'),
    ];
    for (const tenant of [VANCOUVER, VANCOUVER, BURNABY].slice(0, 1)) {
      const { records } = parseTenantCalendars(tenant, calendars, { window: CAPTURE_WINDOW });
      expect(records.length).toBeGreaterThan(20);
      for (const r of records) {
        expect(r.sourceUrl).toMatch(/^https:\/\//);
        expect(r.startDatetimeUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(r.title.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── G-T7R-4 venues ───────────────────────────────────────────────────────────────────

describe('G-T7R-4 venue resolution from centerdetails (no geocoder)', () => {
  it('joins street address + municipality onto every record, and geo from the committed constant', () => {
    const details = fixture<{ body: { center_details: Array<{ id: number }> } }>(
      'vancouver.centerdetails.json'
    ).body.center_details;
    const index = buildVenueIndex(VANCOUVER, details);
    expect(index.size).toBe(36);
    expect(index.get(44)).toMatchObject({
      venueName: 'Hastings Community Centre', // sentinel stripped here too
      venueMunicipalityName: 'Vancouver',
    });
    expect(index.get(44)!.venueAddress).toMatch(/Vancouver, BC/);

    const { records } = parseTenantCalendars(
      VANCOUVER,
      [asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times')],
      { window: CAPTURE_WINDOW }
    );
    const applied = applyVenues(records, index);
    expect(applied.unmappedCentreIds).toEqual([]);
    expect(applied.recordsWithoutAddress).toBe(0);
    // G-VENUE-2: calendar 5 runs entirely at community centres, all of which the
    // constant covers — so geo is attached for every record, with no network call.
    expect(applied.recordsWithoutGeo).toBe(0);
    for (const r of applied.records) {
      expect(r.venueAddress).toBeTruthy();
      expect(r.venueLat, 'geo comes from the committed constant, never a geocoder').toBeTypeOf(
        'number'
      );
      expect(r.venueLng).toBeTypeOf('number');
      expect(r.venueDisplayArea).toBeTruthy();
    }
  });

  it('an unmapped centre surfaces as a warning, never a silent null', () => {
    const { records } = parseTenantCalendars(
      VANCOUVER,
      [asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times')],
      { window: CAPTURE_WINDOW }
    );
    const applied = applyVenues(records, new Map()); // centerdetails resolved nothing
    expect(applied.unmappedCentreIds.length).toBeGreaterThan(0);
    expect(applied.warnings.join(' ')).toMatch(/centerdetails did not resolve/);
    expect(applied.recordsWithoutAddress).toBe(records.length);
  });

  it('Burnaby venues resolve too (different centre naming, same join)', () => {
    const details = fixture<{ body: { center_details: Array<{ id: number }> } }>(
      'burnaby.centerdetails.json'
    ).body.center_details;
    const index = buildVenueIndex(BURNABY, details);
    expect(index.size).toBe(7);
    expect([...index.values()].every((v) => v.venueMunicipalityName === 'Burnaby')).toBe(true);
  });
});

// ── G-T7R-2 client: sequencing, budget, circuit breaker ──────────────────────────────

interface StubCall {
  url: string;
  init?: RequestInit;
}

/** A fetch stub that answers the four endpoints from the captured fixtures. */
function stubPortal(overrides: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: StubCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (overrides.status && overrides.status !== 200) {
      return new Response('{}', { status: overrides.status, headers: overrides.headers });
    }
    let body: unknown = {};
    if (url.includes(ENDPOINTS.calendars)) body = fixture('vancouver.calendars.json');
    else if (url.includes(ENDPOINTS.filters)) body = fixture('vancouver.filters.calendar-5.json');
    else if (url.includes(ENDPOINTS.events)) body = fixture('vancouver.events.calendar-5.json');
    else if (url.includes(ENDPOINTS.centerDetails)) body = fixture('vancouver.centerdetails.json');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, impl };
}

const NO_SLEEP = { sleepImpl: async () => {} };
/** A single-calendar tenant so the stubbed run is small and its request count exact. */
const ONE_CALENDAR_TENANT = { ...VANCOUVER, dropInCalendarIds: [5] };

describe('G-T7R-2 live fetch client', () => {
  it('paginates by calendar × centre-set: 1 calendars + 1 filters + 1 events + 1 centerdetails', async () => {
    const { calls, impl } = stubPortal();
    const budget = new RequestBudget('vancouver', 20);
    const result = await fetchTenant(
      ONE_CALENDAR_TENANT,
      { startDate: '2026-08-03', endDate: '2026-08-09' },
      { budget, fetchImpl: impl, ...NO_SLEEP }
    );

    expect(calls.map((c) => new URL(c.url).pathname.replace('/vancouver/rest', ''))).toEqual([
      ENDPOINTS.calendars,
      ENDPOINTS.filters,
      ENDPOINTS.events,
      ENDPOINTS.centerDetails,
    ]);
    expect(result.requestsUsed).toBe(4);
    expect(result.calendars[0].occurrenceCount).toBeGreaterThan(0);
    expect(result.centreDetails.length).toBe(36);
  });

  it('sends no cookie, no CSRF/anti-forgery token, and an identified bot UA', async () => {
    const { calls, impl } = stubPortal();
    await fetchTenant(
      ONE_CALENDAR_TENANT,
      { startDate: '2026-08-03', endDate: '2026-08-09' },
      { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
    );
    for (const call of calls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      const names = Object.keys(headers).map((k) => k.toLowerCase());
      expect(names).not.toContain('cookie');
      expect(names).not.toContain('authorization');
      expect(names.some((n) => /csrf|verificationtoken/i.test(n))).toBe(false);
      expect(headers['User-Agent'] ?? headers['user-agent']).toMatch(/KidsFunBot/);
      expect(headers['User-Agent'] ?? headers['user-agent']).not.toMatch(/Mozilla/);
      expect((call.init as { credentials?: string } | undefined)?.credentials).not.toBe('include');
    }
  });

  it('enforces the hard per-run request cap', async () => {
    const { impl } = stubPortal();
    await expect(
      fetchTenant(
        VANCOUVER, // all 23 calendars ⇒ ~48 requests
        { startDate: '2026-08-03', endDate: '2026-08-09' },
        { budget: new RequestBudget('vancouver', 5), fetchImpl: impl, ...NO_SLEEP }
      )
    ).rejects.toBeInstanceOf(RequestCapExceededError);
  });

  it('circuit-breaks on 403 without retrying into the block', async () => {
    const { calls, impl } = stubPortal({ status: 403 });
    await expect(
      fetchTenant(
        ONE_CALENDAR_TENANT,
        { startDate: '2026-08-03', endDate: '2026-08-09' },
        { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
      )
    ).rejects.toBeInstanceOf(PortalBlockedError);
    expect(calls.length, 'stopped on the first 403 — no retry storm').toBe(1);
  });

  it('circuit-breaks on 429 and carries Retry-After to the scheduler', async () => {
    const { calls, impl } = stubPortal({ status: 429, headers: { 'retry-after': '120' } });
    const err = await fetchTenant(
      ONE_CALENDAR_TENANT,
      { startDate: '2026-08-03', endDate: '2026-08-09' },
      { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PortalRateLimitedError);
    expect((err as PortalRateLimitedError).retryAfterSeconds).toBe(120);
    expect(calls.length).toBe(1);
  });

  it('backs off then gives up on a persistent 5xx', async () => {
    const { calls, impl } = stubPortal({ status: 503 });
    const slept: number[] = [];
    await expect(
      fetchTenant(
        ONE_CALENDAR_TENANT,
        { startDate: '2026-08-03', endDate: '2026-08-09' },
        {
          budget: new RequestBudget('vancouver', 20),
          fetchImpl: impl,
          sleepImpl: async (ms) => {
            slept.push(ms);
          },
        }
      )
    ).rejects.toThrow(/503/);
    expect(calls.length).toBe(3); // initial + 2 bounded retries, then give up
    // Two interleaved seams sleep here, and both must be present: this module's
    // exponential retry backoff, and politeFetch's 3s-per-request politeness floor
    // (20 rpm for family `activenet`). Asserting both proves the retry never
    // bypasses the rate limiter.
    expect(slept.filter((ms) => ms === 2000 || ms === 4000), 'exponential backoff').toEqual([2000, 4000]);
    expect(
      slept.filter((ms) => ms > 2500 && ms <= 3000).length,
      'the politeness rate limiter still gates every retry'
    ).toBe(2);
  });

  it('a vendor error envelope is a contract violation, not a silent empty run', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ headers: { response_code: '9999', response_message: 'nope' } }), {
        status: 200,
      })) as typeof fetch;
    await expect(
      fetchTenant(
        ONE_CALENDAR_TENANT,
        { startDate: '2026-08-03', endDate: '2026-08-09' },
        { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
      )
    ).rejects.toBeInstanceOf(PortalProtocolError);
  });

  it('detects an unrecognised top-level payload key (shape drift) without crashing', async () => {
    const impl = (async (input: unknown) => {
      const url = String(input);
      const body = url.includes(ENDPOINTS.calendars)
        ? { headers: { response_code: '0000' }, body: { calendars: [], surprise_new_block: [] } }
        : { headers: { response_code: '0000' }, body: {} };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const result = await fetchTenant(
      { ...VANCOUVER, dropInCalendarIds: [] },
      { startDate: '2026-08-03', endDate: '2026-08-09' },
      { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
    );
    expect(result.unrecognisedKeys).toContain('calendars.surprise_new_block');
  });

  it('the real captured payloads produce ZERO unrecognised keys (canary calibration)', async () => {
    // Both tenants, all four endpoints, real bytes. If this ever reports a key, either
    // the vendor moved or the recognised-key set is wrong — both need a human.
    const burnabyStub = (async (input: unknown) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes(ENDPOINTS.calendars)) body = fixture('burnaby.calendars.json');
      else if (url.includes(ENDPOINTS.filters)) body = fixture('burnaby.filters.calendar-1.json');
      else if (url.includes(ENDPOINTS.events)) body = fixture('burnaby.events.calendar-1.json');
      else if (url.includes(ENDPOINTS.centerDetails)) body = fixture('burnaby.centerdetails.json');
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const cases: Array<[typeof VANCOUVER, typeof burnabyStub]> = [
      [ONE_CALENDAR_TENANT, stubPortal().impl],
      [{ ...BURNABY, dropInCalendarIds: [1] }, burnabyStub],
    ];
    for (const [tenant, impl] of cases) {
      const result = await fetchTenant(
        tenant,
        { startDate: '2026-08-03', endDate: '2026-08-09' },
        { budget: new RequestBudget(tenant.tenantKey, 20), fetchImpl: impl, ...NO_SLEEP }
      );
      expect(result.unrecognisedKeys, tenant.tenantKey).toEqual([]);
      expect(result.calendars[0].occurrenceCount).toBeGreaterThan(0);
    }
  });

  it('warns when the portal calendar list drifts from config', async () => {
    const { impl } = stubPortal();
    const result = await fetchTenant(
      { ...VANCOUVER, dropInCalendarIds: [5, 999] },
      { startDate: '2026-08-03', endDate: '2026-08-09' },
      { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
    );
    expect(result.warnings.join(' ')).toMatch(/calendar drift/);
  });

  it('one broken calendar does not empty the municipality', async () => {
    let filtersSeen = 0;
    const impl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes(ENDPOINTS.calendars)) {
        return new Response(JSON.stringify(fixture('vancouver.calendars.json')), { status: 200 });
      }
      if (url.includes(ENDPOINTS.filters)) {
        filtersSeen += 1;
        if (filtersSeen === 1) return new Response('not json at all', { status: 200 });
        return new Response(JSON.stringify(fixture('vancouver.filters.calendar-5.json')), { status: 200 });
      }
      if (url.includes(ENDPOINTS.events)) {
        return new Response(JSON.stringify(fixture('vancouver.events.calendar-5.json')), { status: 200 });
      }
      return new Response(JSON.stringify(fixture('vancouver.centerdetails.json')), { status: 200 });
    }) as typeof fetch;

    const result = await fetchTenant(
      { ...VANCOUVER, dropInCalendarIds: [3, 5] },
      { startDate: '2026-08-03', endDate: '2026-08-09' },
      { budget: new RequestBudget('vancouver', 20), fetchImpl: impl, ...NO_SLEEP }
    );
    expect(result.warnings.join(' ')).toMatch(/calendar 3/);
    expect(result.calendars.find((c) => c.calendarId === 5)!.occurrenceCount).toBeGreaterThan(0);
  });
});

// ── adapter wiring + the env gate ────────────────────────────────────────────────────

describe('T7 REBUILD adapter wiring', () => {
  it('registers one adapter per configured tenant', () => {
    const adapters = loadActiveNetAdapters();
    expect(adapters).toHaveLength(ACTIVENET_TENANTS.length);
    expect(adapters.every((a) => a.family === 'activenet')).toBe(true);
  });

  it('is fixture-only and makes ZERO network calls without the env allow-list', async () => {
    delete process.env.KIDS_FUN_LIVE_ACTIVENET;
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new ActiveNetAdapter(VANCOUVER);
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    const records = adapter.extract(await adapter.fetch());
    expect(spy).not.toHaveBeenCalled();
    expect(records.length).toBeGreaterThan(0);
    expect(adapter.dedupKeys(records[0]).key).toContain('activenet::vancouver::');
  });

  it('the env allow-list is per tenant, and can never enable West Vancouver', () => {
    process.env.KIDS_FUN_LIVE_ACTIVENET = 'vancouver,west_vancouver';
    expect(new ActiveNetAdapter(VANCOUVER).isLiveFetchEnabled()).toBe(true);
    expect(new ActiveNetAdapter(BURNABY).isLiveFetchEnabled()).toBe(false);
    // West Van has no calendars: config keeps it off even when the env names it.
    expect(new ActiveNetAdapter(getTenantConfig('west_vancouver')!).isLiveFetchEnabled()).toBe(false);
  });

  it('builds its fetch window in the tenant local timezone', () => {
    const window = defaultWindow(VANCOUVER, new Date('2026-11-01T06:00:00Z')); // 23:00 PDT Oct 31
    expect(window.startDate).toBe('2026-10-31');
  });
});

// ── G-T7R-6 health ───────────────────────────────────────────────────────────────────

describe('G-T7R-6 health: breakage and thinning are both observable', () => {
  const base = {
    tenantKey: 'vancouver',
    requestsUsed: 48,
    unrecognisedKeys: [] as string[],
    warnings: [] as string[],
    baselineOccurrences: 1000,
  };

  it('a healthy run is a success and does not alert', () => {
    const verdict = assessRunHealth({ ...base, occurrencesParsed: 1100 });
    expect(verdict).toMatchObject({ code: 'ok', status: 'success', alert: false });
  });

  it('yield collapse fails the run rather than reporting a quiet success', () => {
    const verdict = assessRunHealth({ ...base, occurrencesParsed: 1000 * YIELD_COLLAPSE_RATIO - 1 });
    expect(verdict).toMatchObject({ code: 'yield_collapse', status: 'failed', alert: true });
    expect(verdict.detail).toMatch(/trailing baseline 1000/);
  });

  it('a first run with no history is not a collapse', () => {
    expect(assessRunHealth({ ...base, baselineOccurrences: null, occurrencesParsed: 3 }).code).toBe('ok');
  });

  it('shape drift alerts even when the data still parses', () => {
    const verdict = assessRunHealth({
      ...base,
      occurrencesParsed: 1100,
      unrecognisedKeys: ['events.new_block'],
    });
    expect(verdict).toMatchObject({ code: 'shape_drift', status: 'partial', alert: true });
  });

  it('maps 403 / 429 / cap failures onto distinct health codes', () => {
    const cases: Array<[unknown, string]> = [
      [new PortalBlockedError('vancouver', '/rest/x'), 'portal_blocked'],
      [new PortalRateLimitedError('vancouver', '/rest/x', 60), 'portal_rate_limited'],
      [new RequestCapExceededError('vancouver', 48), 'request_cap'],
      [new PortalProtocolError('vancouver', 'bad shape'), 'payload_contract'],
      [new Error('socket hang up'), 'fetch_failed'],
    ];
    for (const [error, code] of cases) {
      const verdict = assessRunHealth({ ...base, occurrencesParsed: 0, error });
      expect(verdict.code, String(code)).toBe(code);
      expect(verdict).toMatchObject({ status: 'failed', alert: true });
    }
  });

  it('assessRun() reports the collapse to the ingest runner — the signal actually fires', async () => {
    // The link that makes G-T7R-6 real: ingestSource calls Adapter.assessRun() with the
    // trailing baseline and turns an alerting verdict into a run error.
    process.env.KIDS_FUN_LIVE_ACTIVENET = 'vancouver';
    const { impl } = stubPortal();
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
    const adapter = new ActiveNetAdapter(ONE_CALENDAR_TENANT);
    vi.useFakeTimers();
    const pending = adapter.fetch();
    await vi.advanceTimersByTimeAsync(120_000);
    const records = adapter.extract(await pending);
    vi.useRealTimers();

    expect(records.length).toBeGreaterThan(0);
    expect(adapter.assessRun(null), 'no history ⇒ not a collapse').toMatchObject({ alert: false });
    const collapsed = adapter.assessRun(records.length * 10);
    expect(collapsed).toMatchObject({ code: 'yield_collapse', alert: true });
    // The stored report is updated too, so the run report and the check run agree.
    expect(adapter.lastRunReport()!.health.code).toBe('yield_collapse');
  });

  it('a fixture dry-run never alerts (it must not be compared to a live baseline)', async () => {
    delete process.env.KIDS_FUN_LIVE_ACTIVENET;
    const adapter = new ActiveNetAdapter(VANCOUVER);
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(5000)).toMatchObject({ code: 'fixture_dry_run', alert: false });
  });

  it('the trailing baseline is the mean of recent successful runs, null on a first run', async () => {
    const fakePool = (rows: Array<{ records_found: number | null }>) =>
      ({ query: async () => ({ rows }) }) as unknown as Parameters<typeof loadYieldBaseline>[0];
    expect(await loadYieldBaseline(fakePool([]), 'src')).toBeNull();
    expect(await loadYieldBaseline(fakePool([{ records_found: null }]), 'src')).toBeNull();
    expect(await loadYieldBaseline(fakePool([{ records_found: 100 }, { records_found: 200 }]), 'src')).toBe(150);
  });

  it('a partial failure keeps whatever was parsed', () => {
    const verdict = assessRunHealth({
      ...base,
      occurrencesParsed: 800,
      error: new PortalRateLimitedError('vancouver', '/rest/x', null),
    });
    expect(verdict.status).toBe('partial');
    expect(verdict.occurrences).toBe(800);
  });
});
