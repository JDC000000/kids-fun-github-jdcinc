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
  DEFAULT_WINDOW_DAYS,
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
  extractAgeText,
} from '../../worker/adapters/activenet/parse';
import { parseAgeText } from '../../worker/core/age';
import {
  buildVenueIndex,
  applyVenues,
  normaliseVenuePhone,
} from '../../worker/adapters/activenet/venues';
import {
  assessRunHealth,
  loadYieldBaseline,
  YIELD_COLLAPSE_RATIO,
  PHONE_REJECTION_ALERT_RATIO,
} from '../../worker/adapters/activenet/health';
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

  // ── the title is not an age claim ────────────────────────────────────────────────
  //
  // `extractAgeText` used to prepend the title unconditionally, so an activity NAME
  // containing an age-adjacent word became `ageText` even when the description said nothing
  // about age at all. Downstream that is indistinguishable from wording the source actually
  // published: parseAgeText resolves it, marks resolved:true, and ingest writes bounds, band
  // matches and an `age_min_months` provenance fact. These tests pin the boundary in BOTH
  // directions, because the cheap fix (drop the title) silently discards the real title-stated
  // ages below, which this platform genuinely publishes.

  it('does not manufacture an age claim from a kid-coded title when the description is age-silent', () => {
    // Shaped like a real ActiveNet event: age-adjacent title word, age-silent description.
    const ageSilent = {
      title: 'Youth Basketball',
      description: '<p>Drop in at the community centre. Bring your own ball. No registration.</p>',
    };
    expect(extractAgeText(ageSilent)).toBeUndefined();
    // …and therefore nothing downstream to resolve into bands.
    expect(parseAgeText(extractAgeText(ageSilent)).resolved).toBe(false);
  });

  it('drops the title-only age claim on the REAL captured events that carried one', () => {
    // Both are verbatim captured records whose descriptions never mention age. Before this
    // fix "Play Palace - Baby Time" published as under-2s and "Family Play Time" as all five
    // bands, each on the strength of one word in its own name.
    const { records } = parseTenantCalendars(
      VANCOUVER,
      [
        asCalendar('vancouver.events.calendar-1.json', 1, '*Parent and Tot Activities'),
        asCalendar('vancouver.events.calendar-32.json', 32, '*Kerrisdale Play Palace'),
      ],
      { window: CAPTURE_WINDOW }
    );
    for (const title of ['Family Play Time', 'Play Palace - Baby Time']) {
      const record = records.find((r) => r.title === title);
      expect(record, `${title} missing from the fixture`).toBeDefined();
      expect(record!.ageText).toBeUndefined();
    }
  });

  it('still captures a genuine age phrase stated in the DESCRIPTION', () => {
    const stated = {
      title: 'Basketball Drop-in',
      description: '<p>Open gym for ages 8-12. Bring your own ball.</p>',
    };
    const ageText = extractAgeText(stated);
    expect(ageText).toContain('ages 8-12');
    expect(parseAgeText(ageText)).toMatchObject({ ageMinMonths: 96, ageMaxMonths: 156, resolved: true });
  });

  it('still uses a title that STATES an age, on the real records that state one', () => {
    // The disqualifier is the age-adjacent WORD, not the title: an explicit range or minimum
    // in the name is the source asserting an age, and dropping it would lose a correct claim.
    const { records } = parseTenantCalendars(
      VANCOUVER,
      [asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times')],
      { window: CAPTURE_WINDOW }
    );
    const adult = records.find((r) => r.title === 'Adult Open Gym (19+)');
    expect(adult?.ageText).toContain('19+');
    expect(parseAgeText(adult?.ageText)).toMatchObject({ ageMinMonths: 228, resolved: true });

    const youth = records.find((r) => /^Youth \(13-18yrs\)/.test(r.title));
    expect(parseAgeText(youth?.ageText)).toMatchObject({ ageMinMonths: 156, ageMaxMonths: 228, resolved: true });
  });

  it('reads the SINGULAR "preschooler" in a description, not just the plural', () => {
    // AGE_PHRASE_KEYWORD anchors every alternative between \b, so `\bpreschool(?:ers)?\b` could
    // not match "preschooler" at all: \b fails after "preschool" and the "ers" branch needs the
    // plural. An age-silent title plus a description whose only age word was the singular
    // emitted NO ageText and produced no occurrence_age row, while the plural resolved to 2-4.
    // That asymmetry is the bug, so both spellings are asserted.
    for (const [body, expected] of [
      ['<p>A weekly session for every preschooler.</p>', 'preschooler'],
      ['<p>A weekly session for preschoolers.</p>', 'preschoolers'],
    ] as const) {
      const ageText = extractAgeText({ title: 'Drop-In Play', description: body });
      expect(ageText, body).toBe(expected);
      expect(parseAgeText(ageText), body).toMatchObject({ ageMinMonths: 36, ageMaxMonths: 60, resolved: true });
    }
  });

  it('reads no age out of a title number that is a clock time, a rating or a price', () => {
    // The numbers rec-centre titles actually carry. Each must leave the title unused, not
    // resolve to an age — the same three mistakes worker/core/age.ts already paid for.
    for (const title of ['Open Gym 6:00-8:00pm', 'Pickleball 3.0-4.0', 'Drop-in Badminton $5+']) {
      const ageText = extractAgeText({ title, description: '<p>All welcome at the gym.</p>' });
      expect(ageText, `${title} leaked into ageText`).toBeUndefined();
    }
  });

  // ── the unit token between the number and its connector ──────────────────────────
  //
  // The first version of the gate required the number to be IMMEDIATELY followed by its `+`
  // or `-`, so "19+" passed and "19yrs+" did not. Measured on 17,209 live Vancouver + Burnaby
  // records (2026-08-18): 86 records across 16 programmes state an age in their own title that
  // the gate threw away. Every title below is verbatim from that pull, and every description
  // here is age-silent on purpose — the title is the only claim there is, so a gate that drops
  // it publishes nothing at all for these records.
  const AGE_SILENT = '<p>Drop in at the community centre. No registration needed.</p>';

  it('uses a title whose age carries a unit between the number and its connector', () => {
    const stated: Array<[string, number, number | null]> = [
      ['Reserve In Advance: Table Tennis 18yrs+', 216, null],
      ['Ball Hockey - Men (40yrs+) SUN', 480, null],
      ['Chinese Folk Dance (55yrs+)', 660, null],
      ['Reserve In Advance: Figure Skating 16yrs+ (Star 2)', 192, null],
      // Published as 1–3 years before this fix, inferred from "Toddlers" in its description,
      // while its own name said six months to five years.
      ['Parent and Tot Gym (6 mo-5 yrs)', 6, 72],
      ['Jump into Music (6months-4yrs)', 6, 60],
      ['Brit Gymnastics - Dynamic Duo A (18mo-3yrs)', 18, 48],
    ];
    for (const [title, ageMinMonths, ageMaxMonths] of stated) {
      const ageText = extractAgeText({ title, description: AGE_SILENT });
      expect(ageText, `${title} was rejected by the title gate`).toBe(title);
      expect(parseAgeText(ageText), title).toMatchObject({ ageMinMonths, ageMaxMonths, resolved: true });
    }
  });

  it('reads no age out of a title date range or a grade label', () => {
    // The other half of the same regex, and the direction that publishes a WRONG age rather
    // than none: 14 records across 3 programmes in the same pull. The tennis camp is a
    // children's camp whose description says "going into Grade 1 or be 6 years old"; it was
    // published as ages 17–22 and 24–29 off its own dates. "Gr. 6-7" is grades, i.e. roughly
    // 11–13 years, and was published as ages 6–8.
    for (const title of [
      'Art of Tennis Summer Camp - Aug 17-21 - Garden Park',
      'Art of Tennis Summer Camp - Aug 24-28 - Garden Park',
      'Future Bounce Basketball (Gr. 6-7)',
    ]) {
      const ageText = extractAgeText({ title, description: AGE_SILENT });
      expect(ageText, `${title} published its dates/grades as an age`).toBeUndefined();
    }
  });

  it('does not let the date guard eat a real age that merely looks like a month', () => {
    // "Novice" begins with "Nov" and "March Break" begins with "Mar". The month guard is
    // anchored so neither costs a genuine title-stated age — an unanchored draft lost both.
    for (const [title, ageMinMonths] of [
      ['Wushu Beginner/Novice 15+', 180],
      ['March Break Camp (5-12yrs)', 60],
    ] as Array<[string, number]>) {
      const ageText = extractAgeText({ title, description: AGE_SILENT });
      expect(ageText, `${title} was swallowed by the date guard`).toBe(title);
      expect(parseAgeText(ageText), title).toMatchObject({ ageMinMonths, resolved: true });
    }
  });

  // ── the description states a number AND a vaguer word ────────────────────────────
  //
  // `AGE_PHRASE_RE` is first-position-wins, and on this platform the vaguer word usually
  // comes first: "for pre-teens and youth ages 8-18" published as 12–18 off `teens`,
  // excluding the 8–11-year-olds the sentence names. Measured on the same 17,209 live
  // records: 153 records / 25 programmes are that shape.
  //
  // The SAME regex space is what correctly refuses 1,088 supervision-rule records — "children
  // 6-12 years must be accompanied by a participating adult" would narrow an all-ages public
  // badminton to a 6–12 programme — so the two directions are tested together, deliberately,
  // and every description below is verbatim from that pull. A precedence change alone breaks
  // the second set; the disqualifying anchor is what separates them.

  it('prefers the stated range over the vaguer word that happens to come first', () => {
    const recovered: Array<[string, string, string, number, number | null]> = [
      [
        'Games Room Drop-in - Youth',
        'This free designated Games Room drop-in time is for pre-teens and youth ages 8-18. Come by afterschool and check out the Games Room with your friends! We have a pool table, table tennis, and foosball available! Please ask a staff member for equipment. No drop-in sessions on statutory holidays.',
        'ages 8-18',
        96,
        228,
      ],
      [
        // "Toddlers" published this as 1–3 years while the sentence after it says 2 to 5.
        'Little Movers Gymnastics',
        'Our Little Movers program is specially designed for curious toddlers who love to jump, climb, and explore! In this playful and safe environment, children ages 2 to 5 develop their motricity, coordination, and balance through engaging movement activities. Parents are welcome to join the class to help their little ones. No sess Oct 12. $30 Drop-In',
        'ages 2 to 5',
        24,
        72,
      ],
      [
        'Games Room - Friday',
        'Games Room drop-in is open to youth ages 10-18! Come hang out and chat with the youth leader, play some games, or do your homework! No registration required. No session Friday, October 30th due to Special Event.',
        'ages 10-18',
        120,
        228,
      ],
      [
        'Mandarin Play Club',
        'Mandarin Play Club is an immersive, play-based Mandarin Chinese program for preschoolers ages 3 to 5. In each 60 minute drop-off class, children build early listening and speaking confidence through movement activities, interactive games, music, stories, and dramatic play. No sess Oct 13.',
        'ages 3 to 5',
        36,
        72,
      ],
      [
        'Red Cross Babysitting Course',
        'This course offers basic first aid and caregiving skills for youth 11-15 years old. Participants learn how to provide care to children in a variety of age groups, and how to prevent and respond to emergencies.',
        '11-15 years',
        132,
        192,
      ],
    ];
    for (const [title, description, phrase, ageMinMonths, ageMaxMonths] of recovered) {
      const ageText = extractAgeText({ title, description: `<p>${description}</p>` });
      expect(ageText, title).toBe(phrase);
      expect(parseAgeText(ageText), title).toMatchObject({ ageMinMonths, ageMaxMonths, resolved: true });
    }
  });

  it('does not promote a number that is a rule about supervision, money or paperwork', () => {
    // One per FALSE_* class in the scope document's §2 taxonomy, each description verbatim and
    // each expectation the value this adapter produced BEFORE the precedence change — these
    // records are the 1,681 the extractor already gets right, and the whole risk of this fix is
    // converting them into narrowed age claims.
    const unchanged: Array<[string, string, string, string | undefined]> = [
      [
        'FALSE_SUPERVISION (participating adult)',
        'Reserve In Advance: Table Tennis All Ages',
        'Please arrive early to claim your reservation. For all ages programs, children 6-12 years must be accompanied by a participating adult. Customers with a 10 Visit Be Active Pass will be required to pay the drop-in rate at the time of registration for a reserve in advance activity.',
        'Reserve In Advance: Table Tennis All Ages — all ages',
      ],
      [
        'FALSE_SUPERVISION (supervised on the ice)',
        '|Public Skate|',
        'Date & Time Sundays, 1:45-3:15pm Sessions June 28 - August 30, 2026 Open skate for all ages Children under 8 years MUST be supervised on the ice by an individual 16 years old or over *Monthly Flexipass and 10-Visit passes are accepted for this program .',
        'all ages',
      ],
      [
        // The "range" here is a row of the admission fee table, not an audience.
        'FALSE_PRICE (fee table)',
        'Play Palace - 0-12yrs',
        'Date &amp; Time Monday - Thursday, 12:00pm - 4:30pm Sessions April 10 - Aug 21, 2026 All Ages No Pre Registration Required Admission Fees Age 1 Visit 10-visit card Under 6mos FREE FREE 6-23mos $4.94 $44.92 2-5yrs $6.35 $57.17 6-12yrs $7.06 $63.50 For detailed admission fees, rental fee and discount information please visit: Vancouver.ca/PlayPalace',
        'Play Palace - 0-12yrs — All Ages',
      ],
      [
        'FALSE_PRICE (under-N is free)',
        'Gym Bugs Drop In',
        'Come and play, climb and run with your child on Sunday mornings. Parent participation required. A great place to meet other families! No class Nov 4. Drop-in price is per child $3.25. Children 12 months and under are free.',
        undefined,
      ],
      [
        'FALSE_PASS (pass duration)',
        'Group Fitness: Classic Stretch w/ Ferial',
        'Please bring your own mat. Registration not required. This class is part of the KCCA Fit Card. A 10-visit, 1 month Fit Card can be used. Drop-in $6.00, space permitting.',
        undefined,
      ],
      [
        'FALSE_REGPRIORITY (early-registration privilege)',
        'Luk Tung Kuen Association',
        'Luk Tung Kuen is a set of health exercises which consist of 36 forms. No session Oct 12. Space Permitting - Drop-in $2 Adults 19yrs+ can register into this program 1 week prior to program start date, if spaces available.',
        undefined,
      ],
      [
        'FALSE_WAIVER (paperwork threshold)',
        'Basketball (Adults) - Monday',
        'Recreational 3 on 3 basketball - Games are organized by the players. In person drop-in sign up starts 30 minutes before start time. Completed waiver forms required for participants under 19 years. $6.50 drop in, if space permits. No session Oct 12.',
        undefined,
      ],
      [
        'FALSE_GRADE_MUSIC (conservatory grade)',
        'Piano',
        "Musical Expressions takes on a creative and intuitive approach to music learning. Each class session is 30 minutes long. If you're learning at a grade 5 level or above, please book two half hour sessions to ensure enough time for the lesson.",
        undefined,
      ],
    ];
    for (const [label, title, description, expected] of unchanged) {
      expect(extractAgeText({ title, description: `<p>${description}</p>` }), label).toBe(expected);
    }
  });

  it('keeps the disqualifier windowed, so ordinary "free"/"registration" copy still recovers', () => {
    // The scope document proposed a bare `free` (and `fee`, `registration`, `pass`, `staff`)
    // as disqualifiers. Measured, each blocks a real recovery: this platform writes "this free
    // basketball drop-in is for youth (ages 13-18)" and "No registration required" as ordinary
    // copy in the very descriptions the fix exists to read.
    const ageText = extractAgeText({
      title: 'Friday Youth Basketball Drop-In',
      description:
        '<p>Dribble and shoot! A Friday afternoon favourite, this free basketball drop-in is for youth (ages 13-18) to come and play basketball in a relaxed setting. No registration necessary. Be sure to sign-in with a Youth Staff upon arrival.</p>',
    });
    expect(ageText).toBe('ages 13-18');
    expect(parseAgeText(ageText)).toMatchObject({ ageMinMonths: 156, ageMaxMonths: 228, resolved: true });
  });

  it('leaves the record alone when the description states more than one age', () => {
    // Two sittings, two ranges: the programme is genuinely 11–18 and neither range is its age.
    // Picking whichever came first would drop the 14–18s, which is a different wrong answer
    // rather than a fix, so the existing answer stands. The only such record in the pull.
    const ageText = extractAgeText({
      title: 'Youth Gym Drop-In',
      description:
        '<p>Looking for something to do on Friday nights? Younger youth, aged 11-13 years are welcome to join from 3:30pm - 5pm. Older youth, aged 13-18 years are welcome to join from 5:00pm -7:45pm.</p>',
    });
    expect(ageText).toBe('youth');
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

// ── venue phone (0024): the number was already fetched, and used to be discarded ─────
//
// The regression this pins is not "phone parses" — it always parsed. It is that the
// parsed value REACHES StructuredRecord, which is the exact boundary it silently fell
// off before migration 0024 wired the field through.
describe('venue phone capture from centerdetails', () => {
  function vancouverDetails() {
    return fixture<{ body: { center_details: Array<{ id: number; phone?: string }> } }>(
      'vancouver.centerdetails.json'
    ).body.center_details;
  }

  it('every Vancouver centre in the captured roster carries a phone number', () => {
    const index = buildVenueIndex(VANCOUVER, vancouverDetails());
    const withPhone = [...index.values()].filter((v) => v.venuePhone);
    expect(index.size).toBe(36);
    expect(withPhone.length, '36/36 measured live 2026-08-01, identical to the fixture').toBe(36);
  });

  it('the phone reaches the record — the boundary it used to fall off', () => {
    const index = buildVenueIndex(VANCOUVER, vancouverDetails());
    const { records } = parseTenantCalendars(
      VANCOUVER,
      [asCalendar('vancouver.events.calendar-5.json', 5, '*Open Gym Times')],
      { window: CAPTURE_WINDOW }
    );
    const applied = applyVenues(records, index);

    expect(applied.records.length).toBeGreaterThan(0);
    for (const r of applied.records) {
      expect(r.venuePhone, 'calendar 5 runs entirely at centres that publish a phone').toBeTruthy();
    }
    // Hastings Community Centre (centre 44) — the value this file already pins address
    // and name against, so the three assertions cannot drift apart.
    expect(index.get(44)!.venuePhone).toBe('(604) 718-6222');
  });

  it('stores the source rendering verbatim, including the one non-conforming value', () => {
    const index = buildVenueIndex(VANCOUVER, vancouverDetails());
    // 35 of 36 render as "(604) NNN-NNNN"; False Creek (43) publishes a +1 prefix. Both
    // are stored exactly as published — canonicalising is a display decision, and there
    // is no display layer for this yet. See supabase/migrations/0024_venue_phone.sql.
    expect(index.get(43)!.venuePhone).toBe('+1 (604) 257-8195');
    const shapes = new Set(
      [...index.values()].map((v) => (v.venuePhone ?? '').replace(/\d/g, 'N'))
    );
    expect(shapes).toEqual(new Set(['(NNN) NNN-NNNN', '+N (NNN) NNN-NNNN']));
  });

  it('Burnaby carries phone numbers on the same wire', () => {
    const details = fixture<{ body: { center_details: Array<{ id: number }> } }>(
      'burnaby.centerdetails.json'
    ).body.center_details;
    const index = buildVenueIndex(BURNABY, details);
    expect([...index.values()].filter((v) => v.venuePhone).length).toBe(7);
    expect(index.get(63)!.venuePhone, 'Bonsor Recreation Complex').toBe('(604) 297-4597');
  });

  it('a centre that publishes no phone yields undefined, never an empty string', () => {
    const index = buildVenueIndex(VANCOUVER, [
      { id: 999, name: '*Phoneless Centre', address1: '1 Nowhere St', city: 'Vancouver' },
      { id: 998, name: '*Blank Phone Centre', phone: '   ', city: 'Vancouver' },
    ]);
    expect(index.get(999)!.venuePhone).toBeUndefined();
    expect(index.get(998)!.venuePhone).toBeUndefined();
  });

  describe('normaliseVenuePhone drops what it cannot stand behind', () => {
    it('keeps every real shape the source has ever published', () => {
      for (const good of [
        '(604) 718-8222',
        '+1 (604) 257-8195',
        '604-987-4471 ext. 8175',
        '604-987-4471 x8175',
        '718-5800', // bare local, no area code — the 7-digit floor must not reject it
        '  (604) 718-5800  ', // trimmed, not otherwise touched
      ]) {
        expect(normaliseVenuePhone(good)).toBe(good.trim());
      }
    });

    it('keeps 43/43 of the real values across both tenants', () => {
      const phones = ['vancouver.centerdetails.json', 'burnaby.centerdetails.json'].flatMap((f) =>
        fixture<{ body: { center_details: Array<{ phone?: string }> } }>(f)
          .body.center_details.map((d) => d.phone)
          .filter((p): p is string => Boolean(p && p.trim()))
      );
      expect(phones.length).toBe(43);
      expect(phones.filter((p) => normaliseVenuePhone(p)).length).toBe(43);
    });

    it('drops prose, sentinels and short junk rather than storing a callable-looking lie', () => {
      for (const bad of [
        undefined,
        '',
        '   ',
        'call the centre',
        'see website',
        'n/a',
        '123456', // six digits — below the shortest real NANP subscriber number
        'Please contact the front desk during business hours to enquire about drop-in times',
      ]) {
        expect(normaliseVenuePhone(bad), `should drop: ${String(bad)}`).toBeUndefined();
      }
    });

    // QA F2: the digit-count guard alone kept all of these — every one is digit-BEARING
    // prose, which is exactly the class a count cannot distinguish from a number.
    it('drops digit-bearing prose, which a digit count alone cannot catch', () => {
      for (const bad of [
        'Mon-Fri 9:00-17:00, Sat 10:00-14:00',
        'Closed 2026-08-01 to 2026-09-01',
        'Ages 0-5, 6-12, 13-18, 19-64, 65+',
        'TTY 711 / Interpretation 1-800-555-0199',
        'See www.vancouver.ca/2026/08/01/2026',
        '1234567890123456789012345678901234567', // 37 digits, no upper bound before
      ]) {
        expect(normaliseVenuePhone(bad), `should drop: ${bad}`).toBeUndefined();
      }
    });

    // The mirror of the above, and the reason BOTH checks exist: every one of these
    // satisfies the shape pattern's 7–24 character bound while containing no digits at
    // all, so the pattern alone would keep them. The digit floor is what refuses them.
    it('drops digit-free punctuation, which the shape pattern alone would keep', () => {
      for (const bad of ['(((((((', '..........', '- - - - - - -', '(  )  .-  ()', '()()()()()()']) {
        expect(normaliseVenuePhone(bad), `should drop: ${bad}`).toBeUndefined();
      }
    });

    // PINS A DELIBERATE COST, NOT A BUG. These five carry a genuinely callable number and
    // are still refused, because the pattern is fully anchored. None occurs in ActiveNet's
    // data today (QA pre-validated all five against live payloads, 2026-08-01). They are
    // pinned so the trade-off cannot be silently reversed: "fixing" this by allowing a
    // bounded trailing label reopens the digit-bearing-prose hole directly above — there
    // is no principled line between `, press 2` and `, Sat 10:00-14:00`. The last two hold
    // TWO numbers, which a scalar column cannot honestly represent at all.
    //
    // If a future change intends to accept these, it must ALSO keep the prose test above
    // green. Deleting this test to make a change pass is the wrong move; see
    // normaliseVenuePhone's docstring for the full reasoning.
    it('drops label-bearing and multi-number strings — a deliberate cost of anchoring', () => {
      for (const dropped of [
        'Tel: (604) 718-8222',
        '(604) 718-8222 (front desk)',
        '(604) 718-8222, press 2',
        '(604) 718-8222 / TTY 711',
        '604-718-8222 or 604-718-8223',
      ]) {
        expect(
          normaliseVenuePhone(dropped),
          `deliberately dropped (see docstring): ${dropped}`
        ).toBeUndefined();
      }
    });

    it('a dropped phone costs the record nothing else — fail soft on the field, not the run', () => {
      const index = buildVenueIndex(VANCOUVER, [
        {
          id: 44,
          name: '*Hastings Community Centre',
          address1: '3096 Hastings Street East',
          city: 'Vancouver',
          state: 'BC',
          zip_code: 'V5K 2A5',
          phone: 'call the centre',
        },
      ]);
      const venue = index.get(44)!;
      expect(venue.venuePhone).toBeUndefined();
      expect(venue.venueName).toBe('Hastings Community Centre');
      expect(venue.venueAddress).toMatch(/Vancouver, BC/);
      expect(venue.geo, 'geo is unaffected by a rejected phone').toBeDefined();
    });
  });

  // ── F-8: a rejected phone is COUNTED, NAMED and ALERTED, never silent ───────────────
  //
  // The flag this closes was measured, not theorised: feeding the full 36-centre roster
  // through with every value switched to a rejected-but-still-callable form produced
  // coverage 0/36, `warnings: []`, `unmappedCentreIds: []` and records still emitted.
  // Re-rated low → medium on 2026-08-01 when the number began rendering on the
  // parent-facing detail page, i.e. when the silent loss became a silent loss OF
  // SOMETHING PARENTS SEE. These tests re-run that exact measurement and require the
  // opposite outcome.
  describe('F-8 phone rejections are observable', () => {
    /** The 36-centre Vancouver roster, every phone rewritten to a form we refuse. */
    function rosterWithRewrittenPhones(rewrite: (phone: string, i: number) => string) {
      return fixture<{ body: { center_details: Array<{ id: number; phone?: string }> } }>(
        'vancouver.centerdetails.json'
      ).body.center_details.map((d, i) => ({
        ...d,
        phone: d.phone ? rewrite(d.phone, i) : d.phone,
      }));
    }

    it('the healthy baseline reads zero — the signal is only worth having if it is quiet', () => {
      const details = fixture<{ body: { center_details: Array<{ id: number }> } }>(
        'vancouver.centerdetails.json'
      ).body.center_details;
      const applied = applyVenues([], buildVenueIndex(VANCOUVER, details));
      expect(applied.phonesOffered).toBe(36);
      expect(applied.phonesRejected).toBe(0);
      expect(applied.venuesWithRejectedPhone).toEqual([]);
      expect(applied.warnings.filter((w) => /phone/i.test(w))).toEqual([]);
    });

    it('records the refused VALUE on the entry, not merely a flag', () => {
      const index = buildVenueIndex(VANCOUVER, [
        { id: 44, name: '*Hastings Community Centre', phone: 'Tel: (604) 718-8222' },
        { id: 45, name: '*Kerrisdale Community Centre', phone: '(604) 257-8100' },
        { id: 46, name: '*Phoneless Centre' },
        { id: 47, name: '*Blank Phone Centre', phone: '   ' },
      ]);
      expect(index.get(44)!.venuePhoneRejected).toBe('Tel: (604) 718-8222');
      expect(index.get(44)!.venuePhone).toBeUndefined();
      expect(index.get(45)!.venuePhoneRejected, 'accepted ⇒ nothing to report').toBeUndefined();
      expect(index.get(46)!.venuePhoneRejected, 'never offered ≠ refused').toBeUndefined();
      expect(index.get(47)!.venuePhoneRejected, 'whitespace is not an offer').toBeUndefined();
    });

    it('THE MEASURED CASE: a wholesale vendor format change is no longer silent', () => {
      const details = rosterWithRewrittenPhones((p) => `Tel: ${p}`);
      const applied = applyVenues([], buildVenueIndex(VANCOUVER, details));

      // Exactly the old measurement — coverage really is 0/36 …
      expect(applied.phonesOffered).toBe(36);
      expect(applied.phonesRejected).toBe(36);
      expect(applied.venuesWithRejectedPhone.length).toBe(36);

      // … and it is now SAID OUT LOUD, with the new shape quoted so an operator can see
      // what moved without opening the payload.
      const warning = applied.warnings.find((w) => /unusable phone/i.test(w));
      expect(warning, 'the run must not stay silent').toBeDefined();
      expect(warning).toMatch(/36 of 36/);
      expect(warning).toMatch(/Tel: \(604\)/);

      // Fail-soft is preserved: the run still produced its venue index and its records.
      expect(buildVenueIndex(VANCOUVER, details).size).toBe(36);
      expect(applied.unmappedCentreIds).toEqual([]);
    });

    it('separates "vendor stopped publishing" from "we refused it" — only the second counts', () => {
      const applied = applyVenues(
        [],
        buildVenueIndex(VANCOUVER, [
          { id: 44, name: '*A', phone: 'Tel: (604) 718-8222' },
          { id: 45, name: '*B', phone: '(604) 257-8100' },
          { id: 46, name: '*C' }, // no phone at all — a vendor coverage gap, not our doing
        ])
      );
      expect(applied.phonesOffered, 'the centre with no phone is not in the denominator').toBe(2);
      expect(applied.phonesRejected).toBe(1);
      expect(applied.venuesWithRejectedPhone).toEqual(['A']);
    });

    it('names the affected facilities, sorted, and caps the quoted examples at three', () => {
      const applied = applyVenues(
        [],
        buildVenueIndex(
          VANCOUVER,
          ['*Zulu', '*Alpha', '*Mike', '*Bravo'].map((name, i) => ({
            id: 100 + i,
            name,
            phone: '(604) 718-8222, press 2',
          }))
        )
      );
      expect(applied.venuesWithRejectedPhone).toEqual(['Alpha', 'Bravo', 'Mike', 'Zulu']);
      const warning = applied.warnings.find((w) => /unusable phone/i.test(w))!;
      expect(warning.match(/press 2/g)!.length, 'capped at 3 quoted examples').toBe(3);
      expect(warning).toMatch(/, …$/);
    });

    it('is derived from the roster, so a quiet facility still raises it on the first run', () => {
      // Zero records — the format change lands on a centre with no occurrences this week.
      // venuesWithoutGeo already works this way; the phone signal must not be weaker.
      const applied = applyVenues(
        [],
        buildVenueIndex(VANCOUVER, [{ id: 44, name: '*Hastings Community Centre', phone: 'see website' }])
      );
      expect(applied.records).toEqual([]);
      expect(applied.phonesRejected).toBe(1);
    });
  });
});

// ── G-T7R-2 client: sequencing, budget, circuit breaker ──────────────────────────────

interface StubCall {
  url: string;
  init?: RequestInit;
}

/** A fetch stub that answers the four endpoints from the captured fixtures. */
function stubPortal(
  overrides: {
    status?: number;
    headers?: Record<string, string>;
    /** Swap the centerdetails payload — the seam F-8's induced-spike test drives. */
    centreDetails?: unknown;
  } = {}
) {
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
    else if (url.includes(ENDPOINTS.centerDetails))
      body = overrides.centreDetails ?? fixture('vancouver.centerdetails.json');
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

/**
 * The wall clock is the one input to these captured fixtures that nobody controls, and it
 * broke two tests silently. Every `fetchTenant` call above is handed an explicit window,
 * but `ActiveNetAdapter.fetch()` builds its own from `new Date()` — and parse.ts drops
 * every occurrence outside it. The captured events run 2026-07-27…2026-08-07, so from
 * 2026-08-08 the two adapter-level runs below parsed all 24 events and emitted 0 records
 * (`stats.skippedOutsideWindow: 24`). Nothing was wrong with the adapter or the alerting
 * path; the harness had simply lost the ability to stage the scenario, and the assertions
 * those tests exist for — the collapse signal fires, an induced phone-format change comes
 * out of ingestSource as an alerting verdict — stopped being reached at all.
 *
 * So pin the clock to the fixtures' OWN first day instead of to today. DERIVED FROM THE
 * CAPTURED BYTES, not written down beside them: re-capturing the fixtures moves it
 * automatically, where a fresh hard-coded date would just rot again on the next capture.
 * (worker/adapters/perfectmind's equivalent test avoids this by generating its fake portal
 * relative to the window; ActiveNet asserts on real captured payloads, so it pins instead.)
 */
function fixtureEraStart(...names: string[]): Date {
  const days = names
    .flatMap((n) => readFileSync(join(FIXTURES, n), 'utf8').match(/\d{4}-\d{2}-\d{2}(?=[ T]\d{2}:)/g) ?? [])
    .sort();
  if (days.length === 0) throw new Error(`no event datetimes found in ${names.join(', ')}`);
  // Noon UTC on that day is 05:00 in every North American tenant zone, so the window's
  // LOCAL start date is that same day and the whole capture sits inside it.
  const first = Date.parse(`${days[0]}T12:00:00Z`);
  const spanDays = (Date.parse(`${days[days.length - 1]}T12:00:00Z`) - first) / 86_400_000;
  if (spanDays > DEFAULT_WINDOW_DAYS) {
    // A re-capture wider than one window needs a deliberate second pin, not a silent gap.
    throw new Error(
      `${names[0]} spans ${spanDays}d — wider than the ${DEFAULT_WINDOW_DAYS}d default window`
    );
  }
  return new Date(first);
}

/** The clock the stubbed-portal runs below execute under. */
const FIXTURE_ERA_CLOCK = fixtureEraStart('vancouver.events.calendar-5.json');

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
    vi.setSystemTime(FIXTURE_ERA_CLOCK); // fetch() windows on new Date() — see fixtureEraStart
    const pending = adapter.fetch();
    await vi.advanceTimersByTimeAsync(120_000);
    const records = adapter.extract(await pending);
    vi.useRealTimers();

    expect(records.length).toBeGreaterThan(0);
    // F-8 rides along here rather than in a second adapter+timer harness: this is already
    // the healthy-roster E2E run, so the `alert: false` below IS the phone signal's
    // false-alarm guard — a rejection miscount on 36 good numbers fails this line.
    expect(adapter.lastRunReport()!.phonesRejected, 'no phone was refused on a clean roster').toBe(0);
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

  // ── F-8 ────────────────────────────────────────────────────────────────────────────
  describe('F-8 phone_rejection_spike', () => {
    const healthy = { ...base, occurrencesParsed: 1100 };

    // DELIBERATELY ASYMMETRIC (12 of 36, six names, five shown). A 36-of-36 wholesale case
    // reads better as a story but cannot detect a swapped numerator and denominator — QA
    // demonstrated that an inverted `${offered} of ${rejected}` survives every symmetric
    // assertion in this file. Every count here is distinct for that reason: 12 ≠ 36, and
    // 6 named ≠ 5 shown, so a transposition anywhere in the detail string fails a line.
    it('alerts when a fifth of the published numbers become undialable', () => {
      const verdict = assessRunHealth({
        ...healthy,
        phonesOffered: 36,
        phonesRejected: 12,
        venuesWithRejectedPhone: ['Britannia', 'Dunbar', 'Hastings', 'Kerrisdale', 'Killarney', 'Kitsilano'],
      });
      expect(verdict).toMatchObject({ code: 'phone_rejection_spike', status: 'partial', alert: true });
      expect(verdict.detail, 'rejected of offered, in that order').toMatch(
        /12 of 36 published phone number\(s\) were unusable/
      );
      expect(verdict.detail, 'names, not a percentage').toMatch(/affected: Britannia, Dunbar/);
      expect(verdict.detail, 'and says how many it did not name').toMatch(/\+1 more/);
      // partial, not failed: the occurrences are good and must still land.
      expect(verdict.occurrences).toBe(1100);
    });

    it('does not fire on a single rejection — one centre adding a label is not a contract change', () => {
      const verdict = assessRunHealth({ ...healthy, phonesOffered: 3, phonesRejected: 1 });
      expect(verdict, 'an alarm that cries wolf gets muted').toMatchObject({ code: 'ok', alert: false });
    });

    it('holds the ratio boundary in both directions', () => {
      // 7/36 = 19.4% — under. 8/36 = 22.2% — over. Both carry >= 2 rejections, so the
      // ratio is the only thing being tested here.
      expect(assessRunHealth({ ...healthy, phonesOffered: 36, phonesRejected: 7 }).code).toBe('ok');
      expect(assessRunHealth({ ...healthy, phonesOffered: 36, phonesRejected: 8 }).code).toBe(
        'phone_rejection_spike'
      );
      // EXACTLY on the line, because neither case above sits on it — 2/10 is 0.2 to the
      // bit, so this is the only assertion that distinguishes `>=` from `>`. QA found that
      // relaxing the comparison passed the whole suite without it.
      expect(2 / 10 === PHONE_REJECTION_ALERT_RATIO, 'exact-boundary premise').toBe(true);
      expect(
        assessRunHealth({ ...healthy, phonesOffered: 10, phonesRejected: 2 }).code,
        'the threshold is inclusive — at the line IS a spike'
      ).toBe('phone_rejection_spike');
      // Burnaby's 7-centre roster must be able to alert at all — a floor tuned to
      // Vancouver would have made the smaller tenant permanently unwatchable.
      expect(assessRunHealth({ ...healthy, phonesOffered: 7, phonesRejected: 2 }).code).toBe(
        'phone_rejection_spike'
      );
      expect(assessRunHealth({ ...healthy, phonesOffered: 7, phonesRejected: 1 }).code).toBe('ok');
    });

    it('a run that publishes no phones at all is not a spike (0/0 is not 100%)', () => {
      expect(assessRunHealth({ ...healthy, phonesOffered: 0, phonesRejected: 0 }).code).toBe('ok');
      // …and an adapter that never supplies the fields behaves exactly as before.
      expect(assessRunHealth(healthy).code).toBe('ok');
    });

    it('yields to the codes above it — a spike never masks a collapse or drift', () => {
      const spiking = { phonesOffered: 36, phonesRejected: 36 };
      expect(
        assessRunHealth({ ...base, ...spiking, occurrencesParsed: 1 }).code,
        'an empty municipality is the bigger story'
      ).toBe('yield_collapse');
      expect(
        assessRunHealth({ ...healthy, ...spiking, unrecognisedKeys: ['events.new_block'] }).code,
        'if the payload moved, say THAT — phones are one field of it'
      ).toBe('shape_drift');
      expect(
        assessRunHealth({ ...healthy, ...spiking, error: new PortalBlockedError('vancouver', '/x') }).code
      ).toBe('portal_blocked');
    });

    it('END TO END: an induced format change reaches ingestSource as an alerting verdict', async () => {
      // The test the whole flag is about. Everything above checks a part; this drives a
      // real run through fetch → extract → assessRun with nothing but the vendor's phone
      // FORMAT changed, and requires the signal to come out the far end — the one place
      // ingestSource actually looks (`if (verdict?.alert) errors.push(...)`).
      const roster = fixture<{ body: { center_details: Array<{ phone?: string }> } }>(
        'vancouver.centerdetails.json'
      );
      const mutated = {
        ...roster,
        body: {
          ...roster.body,
          center_details: roster.body.center_details.map((d) => ({
            ...d,
            // Still a perfectly callable number to a human, which is the whole trap:
            // nothing else in the run has any reason to complain.
            phone: d.phone ? `Tel: ${d.phone}` : d.phone,
          })),
        },
      };

      process.env.KIDS_FUN_LIVE_ACTIVENET = 'vancouver';
      const { impl } = stubPortal({ centreDetails: mutated });
      vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
      const adapter = new ActiveNetAdapter(ONE_CALENDAR_TENANT);
      vi.useFakeTimers();
      vi.setSystemTime(FIXTURE_ERA_CLOCK); // fetch() windows on new Date() — see fixtureEraStart
      const pending = adapter.fetch();
      await vi.advanceTimersByTimeAsync(120_000);
      const records = adapter.extract(await pending);
      vi.useRealTimers();

      // The run looks entirely healthy by every pre-F-8 measure …
      expect(records.length, 'occurrences are fine').toBeGreaterThan(0);
      const report = adapter.lastRunReport()!;
      expect(report.unmappedCentreIds).toEqual([]);
      expect(report.unrecognisedKeys).toEqual([]);
      expect(records.every((r) => r.venuePhone === undefined), 'every phone was dropped').toBe(true);

      // … and it now reports the loss instead of passing as green.
      expect(report.phonesOffered).toBe(36);
      expect(report.phonesRejected).toBe(36);
      const verdict = adapter.assessRun(null);
      expect(verdict, 'this is what ingestSource turns into a run error').toMatchObject({
        code: 'phone_rejection_spike',
        alert: true,
      });
      // THE DETAIL STRING IS THE PAYLOAD, so assert it, not just the code. QA found the
      // 4th mutation here: deleting the `venuesWithRejectedPhone` re-feed in index.ts left
      // the whole suite green while stripping every facility name out of the only text an
      // operator ever sees — because nothing asserted a verdict's `detail`. The same hole
      // let a blanked detail, an inverted "36 of 8", and an off-by-one threshold survive.
      expect(verdict!.detail, 'names the facilities, quantified, not just a code').toMatch(
        /36 of 36 published phone number\(s\) were unusable/
      );
      expect(verdict!.detail).toMatch(/affected: .+ Community Centre/);
      expect(verdict!.detail, 'and says how many it did not name').toMatch(/\+31 more/);
      expect(report.warnings.some((w) => /unusable phone/i.test(w))).toBe(true);
      // The stored report is updated too, so lastRunReport() and the check run agree.
      expect(adapter.lastRunReport()!.health.code).toBe('phone_rejection_spike');
    });
  });
});
