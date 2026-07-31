// tests/adapters/perfectmind.test.ts — T8 (G-T8-2 … G-T8-6) contract tests for the
// PerfectMind / Xplor BookMe4 drop-in adapter.
//
// The fixtures in worker/adapters/perfectmind/__fixtures__/ are REAL captured payloads
// (NVRC 2026-07-31, Richmond 2026-07-31), trimmed in record count but not in shape. They
// exist so a vendor contract change fails loudly here instead of silently emptying a
// municipality in production.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PerfectMindAdapter,
  PERFECTMIND_TENANTS,
  BOOKME4_ASSET_BUILD_STAMP,
  getPerfectMindTenant,
  ingestableTenants,
} from '../../worker/adapters/perfectmind';
import {
  buildFormBody,
  fetchCalendar,
  selectDropInCalendars,
  unrecognisedClassKeys,
  KNOWN_CLASS_KEYS,
  RequestBudget,
  END_OF_DATA_CURSOR,
  MAX_PAGES_PER_CALENDAR,
  WidgetBlockedError,
  WidgetRateLimitedError,
  type BookMe4Class,
  type BookMe4Category,
  type CalendarFetchResult,
} from '../../worker/adapters/perfectmind/client';
import {
  classifyCost,
  resolveAgeText,
  parseTimeRange,
  parseOccurrenceDate,
  toInstants,
  parseTenantCalendars,
  occurrenceRecordId,
  extractVenue,
} from '../../worker/adapters/perfectmind/parse';
import { assessRunHealth } from '../../worker/adapters/perfectmind/health';
import { parseAgeText } from '../../worker/core/age';
import { clearPolicyState } from '../../worker/health/policy';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  clearPolicyState();
});

const FIXTURES = resolve(process.cwd(), 'worker/adapters/perfectmind/__fixtures__');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T;
}

const nvrc = getPerfectMindTenant('nvrc')!;
const richmond = getPerfectMindTenant('richmond')!;

function classesFixture(name: string): BookMe4Class[] {
  return fixture<{ classes: BookMe4Class[] }>(name).classes;
}

function asCalendar(classes: BookMe4Class[], name = 'Open Gym Schedules'): CalendarFetchResult {
  return {
    calendarId: 'd313e7d8-0d72-4e0b-92c5-98d8017ab64e',
    calendarName: name,
    categoryName: '**Drop-In Schedules',
    classes,
    occurrenceCount: classes.length,
    pagesFetched: 1,
    truncated: false,
    warnings: [],
  };
}

// ── G-T8-2: config ──────────────────────────────────────────────────────────────────

describe('G-T8-2 PerfectMind tenant config', () => {
  it('adding a municipality is a config entry — every tenant carries the full shape', () => {
    expect(PERFECTMIND_TENANTS.length).toBeGreaterThanOrEqual(2);
    for (const t of PERFECTMIND_TENANTS) {
      expect(t.tenantKey, 'tenantKey').toBeTruthy();
      expect(t.host, 'host').toMatch(/^[a-z0-9-]+\.perfectmind\.com$/);
      expect(t.orgId, 'orgId').toMatch(/^\d+$/);
      expect(t.widgetId, 'widgetId is a GUID').toMatch(/^[0-9a-f-]{36}$/i);
      expect(t.timezone, 'explicit IANA zone').toBe('America/Vancouver');
      expect(t.sourceName, 'sourceName ties to the source row').toBeTruthy();
      expect(t.maxRequestsPerRun, 'a hard request cap').toBeGreaterThan(0);
      expect(t.evidenceNote, 'measured evidence, not aspiration').toBeTruthy();
    }
  });

  it('NVRC is the only ingestable tenant; Richmond records a measured ZERO (G-T8-1)', () => {
    expect(ingestableTenants().map((t) => t.tenantKey)).toEqual(['nvrc']);
    // Richmond is deliberately PRESENT and deliberately EMPTY — recording the zero is
    // the point. Deleting the row would hide the finding.
    expect(richmond.dropInCategoryNames).toEqual([]);
    expect(richmond.enabled).toBe(false);
    expect(richmond.evidenceNote).toMatch(/ZERO drop-in coverage/);
    expect(richmond.evidenceNote, 'says plainly what Richmond does publish').toMatch(/PDF/);
  });

  it('the source names match the seeded source rows exactly', () => {
    const seeds = readFileSync(resolve(process.cwd(), 'supabase/seeds/sources.sql'), 'utf8');
    for (const t of PERFECTMIND_TENANTS) {
      expect(seeds, `${t.tenantKey} has a seeded source row`).toContain(`'${t.sourceName}'`);
    }
  });

  it('pins the BookMe4 asset build stamp as a breakage canary', () => {
    expect(BOOKME4_ASSET_BUILD_STAMP.stamp).toBe('07231003');
    expect(BOOKME4_ASSET_BUILD_STAMP.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── G-T8-3: client contract ─────────────────────────────────────────────────────────

describe('G-T8-3 fetch client — form bodies, cursor pagination, circuit breaker', () => {
  it('buildFormBody emits a CLOSED field set and can never carry an anti-forgery token', () => {
    const body = buildFormBody({ widgetId: 'W', calendarId: 'C', page: 0, after: '2026-08-05' });
    const fields = [...new URLSearchParams(body).keys()].sort();
    expect(fields).toEqual(['after', 'calendarId', 'dateString', 'page', 'widgetId']);
    expect(body).not.toMatch(/__RequestVerificationToken|csrf/i);
  });

  it('sends an EMPTY dateString — it is measured to be ignored server-side', () => {
    // Verified by ablation 2026-07-31: dateString=2026-08-06 returned the identical
    // payload to dateString absent. It is sent for contract fidelity only, so it must
    // never be used to bound a window (that is parse.ts's job).
    const params = new URLSearchParams(buildFormBody({ widgetId: 'W', calendarId: 'C' }));
    expect(params.get('dateString')).toBe('');
  });

  it('selectDropInCalendars resolves calendars dynamically by CATEGORY name', () => {
    const categories = fixture<BookMe4Category[]>('nvrc.categories.json');
    const { calendars, warnings } = selectDropInCalendars(nvrc, categories);
    expect(calendars.length, 'NVRC publishes 9 drop-in calendars').toBe(9);
    expect(calendars.map((c) => c.calendarName)).toContain('Open Gym Schedules');
    expect(calendars.every((c) => /^[0-9a-f-]{36}$/i.test(c.calendarId))).toBe(true);
    // The measured finding: one calendar has an empty BookingLink and is FLAGGED, not
    // silently dropped and not silently kept.
    expect(warnings.join(' ')).toMatch(/North Shore Neighbourhood House.*empty BookingLink/);
  });

  it('skips calendars ClassesV2 cannot serve, and says why', () => {
    const categories: BookMe4Category[] = [
      {
        Name: '**Drop-In Schedules',
        Calendars: [
          { Id: 'a'.repeat(36), Name: 'Real Classes', BookingLink: '/x', BookingTypeInfo: { BookingType: 2 } },
          { Id: 'b'.repeat(36), Name: 'Registered Courses', BookingLink: '/y', BookingTypeInfo: { BookingType: 3 } },
        ],
      },
    ];
    const { calendars, warnings } = selectDropInCalendars(nvrc, categories);
    expect(calendars.map((c) => c.calendarName)).toEqual(['Real Classes']);
    expect(warnings.join(' ')).toMatch(/BookingType 3.*not a drop-in schedule/);
  });

  it('warns when a configured drop-in category is ABSENT from the live tree', () => {
    const { calendars, warnings } = selectDropInCalendars(nvrc, [{ Name: 'Something Else', Calendars: [] }]);
    expect(calendars).toEqual([]);
    expect(warnings.join(' ')).toMatch(/"\*\*Drop-In Schedules" is ABSENT/);
  });

  it('paginates by the `after` CURSOR and stops on the end-of-data sentinel', async () => {
    // The corrected contract: `page` is pinned to 0 and `after` carries the cursor.
    // Paginating by `page` was measured to SKIP occurrences (07-31..08-05 then
    // 08-14..08-18, losing 08-06..08-13), so this asserts the fix, not just the loop.
    const page1 = fixture<{ classes: BookMe4Class[]; nextKey: string }>('nvrc.classes.open-gym.page1.json');
    const page2 = fixture<{ classes: BookMe4Class[]; nextKey: string }>('nvrc.classes.open-gym.page2.json');
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_u: unknown, init?: unknown) => {
      bodies.push(String((init as { body?: string })?.body ?? ''));
      const payload =
        call++ === 0 ? page1 : { ...page2, nextKey: END_OF_DATA_CURSOR };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Open Gym Schedules', categoryName: '**Drop-In Schedules' },
      { budget: new RequestBudget('nvrc', 10), fetchImpl, sleepImpl: async () => {} }
    );

    expect(result.pagesFetched).toBe(2);
    expect(result.occurrenceCount).toBe(page1.classes.length + page2.classes.length);
    expect(result.truncated).toBe(false);
    // Page 1 asks with an empty cursor; page 2 carries page 1's nextKey. `page` never moves.
    expect(new URLSearchParams(bodies[0]).get('after')).toBe('');
    expect(new URLSearchParams(bodies[1]).get('after')).toBe(page1.nextKey);
    expect(bodies.every((b) => new URLSearchParams(b).get('page') === '0')).toBe(true);
  });

  it('stops when the cursor does not ADVANCE — a vendor echoing a fixed key cannot loop us', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ classes: [{ EventId: 'x' }], nextKey: '2026-08-05' }), {
        status: 200,
      })) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Stuck', categoryName: 'c' },
      { budget: new RequestBudget('nvrc', 50), fetchImpl, sleepImpl: async () => {} }
    );
    // First page sets the cursor; second returns the SAME key, which stops the walk.
    expect(result.pagesFetched).toBe(2);
    expect(result.pagesFetched).toBeLessThan(MAX_PAGES_PER_CALENDAR);
    expect(result.warnings.join(' ')).toMatch(/cursor did not advance/);
  });

  it('reports a TRUNCATED slice rather than implying completeness', async () => {
    let day = 1;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          classes: [{ EventId: 'x' }],
          nextKey: `2026-09-${String(day++).padStart(2, '0')}`,
        }),
        { status: 200 }
      )) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Endless', categoryName: 'c' },
      { budget: new RequestBudget('nvrc', 100), fetchImpl, sleepImpl: async () => {} }
    );
    expect(result.pagesFetched).toBe(MAX_PAGES_PER_CALENDAR);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/slice may be incomplete/);
  });

  it('403 and 429 circuit-break the run instead of retrying into a block', async () => {
    for (const [status, ErrorType] of [
      [403, WidgetBlockedError],
      [429, WidgetRateLimitedError],
    ] as const) {
      clearPolicyState();
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return new Response('', { status });
      }) as typeof fetch;

      await expect(
        fetchCalendar(
          nvrc,
          { calendarId: 'CAL', calendarName: 'Blocked', categoryName: 'c' },
          { budget: new RequestBudget('nvrc', 10), fetchImpl, sleepImpl: async () => {} }
        )
      ).rejects.toBeInstanceOf(ErrorType);
      expect(calls, `HTTP ${status} is never retried in-run`).toBe(1);
    }
  });

  it('the per-run request cap is hard', async () => {
    // The cursor ADVANCES every page, so nothing else stops this walk — only the budget
    // can. (An earlier version of this test returned a constant nextKey and was stopped
    // by the non-advancing-cursor guard instead, proving that guard rather than the cap.)
    let day = 1;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          classes: [{ EventId: 'x' }],
          nextKey: `2026-12-${String(day++).padStart(2, '0')}`,
        }),
        { status: 200 }
      )) as typeof fetch;
    const budget = new RequestBudget('nvrc', 3);
    await expect(
      fetchCalendar(
        nvrc,
        { calendarId: 'CAL', calendarName: 'Greedy', categoryName: 'c' },
        { budget, fetchImpl, sleepImpl: async () => {} }
      )
    ).rejects.toThrow(/request cap/i);
    expect(budget.spent).toBe(3);
  });
});

// ── G-T8-4: parse ───────────────────────────────────────────────────────────────────

describe('G-T8-4 time parsing — two display fields into one correct instant', () => {
  it('parses the vendor date and 12-hour clock forms', () => {
    expect(parseOccurrenceDate('20260814')).toBe('2026-08-14');
    expect(parseOccurrenceDate('2026-08-14')).toBeUndefined();
    expect(parseOccurrenceDate('20261314'), 'month 13 is rejected, not guessed').toBeUndefined();
    expect(parseTimeRange('06:00 am - 08:00 am')).toEqual({ start: '06:00', end: '08:00' });
    expect(parseTimeRange('12:00 pm - 01:30 pm')).toEqual({ start: '12:00', end: '13:30' });
    expect(parseTimeRange('12:00 am - 12:30 am'), 'midnight is 00:00, not 12:00').toEqual({
      start: '00:00',
      end: '00:30',
    });
    expect(parseTimeRange('not a time')).toBeUndefined();
  });

  it('converts local wall clock to UTC across BOTH sides of a DST transition', () => {
    // PDT (UTC-7) in August, PST (UTC-8) in December. A fixed offset would break one of
    // these; worker/core/time.ts resolves the offset in force at the instant.
    const summer = toInstants('2026-08-14', { start: '06:00', end: '08:00' }, 'America/Vancouver')!;
    expect(summer.startDatetimeUtc).toBe('2026-08-14T13:00:00.000Z');
    expect(summer.endDatetimeUtc).toBe('2026-08-14T15:00:00.000Z');

    const winter = toInstants('2026-12-14', { start: '06:00', end: '08:00' }, 'America/Vancouver')!;
    expect(winter.startDatetimeUtc).toBe('2026-12-14T14:00:00.000Z');
  });

  it('rolls a midnight-crossing session onto the next day', () => {
    const r = toInstants('2026-08-14', { start: '22:00', end: '00:30' }, 'America/Vancouver')!;
    expect(r.startDatetimeUtc).toBe('2026-08-15T05:00:00.000Z');
    expect(r.endDatetimeUtc, 'end rolls to the 15th, not backwards to the 14th').toBe(
      '2026-08-15T07:30:00.000Z'
    );
    expect(Date.parse(r.endDatetimeUtc!)).toBeGreaterThan(Date.parse(r.startDatetimeUtc));
  });

  it('a fixture week parses to correct instants', () => {
    const parsed = parseTenantCalendars(nvrc, [asCalendar(classesFixture('nvrc.classes.open-gym.page1.json'))]);
    expect(parsed.records.length).toBeGreaterThan(0);
    for (const r of parsed.records) {
      expect(r.startDatetimeUtc, 'every record carries an instant').toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      if (r.endDatetimeUtc) {
        expect(Date.parse(r.endDatetimeUtc)).toBeGreaterThan(Date.parse(r.startDatetimeUtc!));
      }
    }
    expect(parsed.stats.skippedUnparseableTime).toBe(0);
    expect(parsed.stats.skippedUnparseableDate).toBe(0);
  });
});

describe('G-T8-4 cost honesty — the price field is not trusted', () => {
  const openGym: BookMe4Class = {
    EventName: '$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm',
    Details: 'Practice your favourite sport. Regular admission fees apply.',
    PriceRange: 'No fee',
  };

  it('"$3 Open Gym" with PriceRange "No fee" is NOT free', () => {
    const verdict = classifyCost(openGym);
    expect(verdict.costStatus, 'never free').not.toBe('free');
    expect(verdict.costStatus).toBe('known');
    expect(verdict.costMinCad).toBe(3);
    expect(verdict.reason).toMatch(/fee language/);
  });

  it('EVERY record in the real captured fixture resolves to a non-free status', () => {
    // The measured reality: 50/50 NVRC Open Gym records carry PriceRange "No fee" while
    // every one of them costs $3. A parser that reported these as free would be telling
    // parents something untrue about every single listing on the calendar.
    const classes = classesFixture('nvrc.classes.open-gym.page1.json');
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.every((c) => c.PriceRange === 'No fee'), 'fixture pins the trap').toBe(true);
    for (const c of classes) {
      expect(classifyCost(c).costStatus, `"${c.EventName}" must not be reported free`).not.toBe('free');
    }
  });

  it('fee language beats a free price field even with no inline amount', () => {
    const verdict = classifyCost({
      EventName: 'Open Gym',
      Details: 'Regular admission rates apply.',
      PriceRange: 'No fee',
    });
    expect(verdict.costStatus).toBe('check_source');
  });

  it('a genuine amount or span with no fee language is reported as known', () => {
    expect(classifyCost({ EventName: 'Yoga', PriceRange: '$11.15' })).toMatchObject({
      costStatus: 'known',
      costMinCad: 11.15,
      costMaxCad: 11.15,
    });
    expect(classifyCost({ EventName: 'Cycle Fit', PriceRange: '$0.00 - $8.75' })).toMatchObject({
      costStatus: 'known',
      costMinCad: 0,
      costMaxCad: 8.75,
    });
  });

  it("'free' requires TWO corroborating signals — the price field alone is never enough", () => {
    expect(classifyCost({ EventName: 'Open Gym', PriceRange: 'No fee' }).costStatus).toBe('check_source');
    expect(classifyCost({ EventName: 'Free Family Skate', PriceRange: '' }).costStatus).toBe('check_source');
    expect(
      classifyCost({ EventName: 'Free Family Skate', Details: 'No charge.', PriceRange: 'No fee' }).costStatus
    ).toBe('free');
  });

  it('an unreadable or absent price is never coerced to zero', () => {
    expect(classifyCost({ EventName: 'X', PriceRange: 'Check details' }).costStatus).toBe('check_source');
    expect(classifyCost({ EventName: 'X' }).costStatus).toBe('unknown');
  });
});

describe('G-T8-4 deterministic ages from the STRUCTURED fields', () => {
  /** The end-to-end contract that matters: the phrase this adapter emits must be
   *  resolvable by T13's existing normaliser, because that is what the ingest pipeline
   *  actually runs. Asserting the phrase alone would prove nothing. */
  function resolvedMonths(record: BookMe4Class) {
    const verdict = resolveAgeText(record);
    return { verdict, age: parseAgeText(verdict.ageText) };
  }

  it('"$3 Open Gym 8yrs+" yields an 8+ age band, deterministically', () => {
    const { verdict, age } = resolvedMonths({
      EventName: '$3 Open Gym 8yrs+ Delbrook',
      MinAge: 8,
      MinAgeMonths: null,
      MaxAge: null,
      MaxAgeMonths: null,
      NoAgeRestriction: false,
      DisplayableRestrictionsForCourses: 'Age: 8+',
    });
    expect(verdict.deterministic, 'from structured fields, not the display string').toBe(true);
    expect(verdict.reason).toMatch(/structured MinAge/);
    expect(age.resolved).toBe(true);
    expect(age.ageMinMonths).toBe(96);
    expect(age.ageMaxMonths).toBeNull();
  });

  it('a bounded range resolves to both bounds under T13’s convention', () => {
    const { age } = resolvedMonths({ MinAge: 5, MaxAge: 12, NoAgeRestriction: false });
    expect(age.resolved).toBe(true);
    expect(age.ageMinMonths).toBe(60);
    // "5 to 12" includes 12-year-olds → exclusive max at 13 years.
    expect(age.ageMaxMonths).toBe(156);
  });

  it('handles the vendor’s "N y 12m" and "to 0" quirks without emitting nonsense', () => {
    // Measured: MinAge 7 + MinAgeMonths 12 renders as "7 y 12m to 0" — i.e. 8+, no max.
    const quirk = resolvedMonths({
      MinAge: 7,
      MinAgeMonths: 12,
      MaxAge: 0,
      MaxAgeMonths: 0,
      NoAgeRestriction: false,
      DisplayableRestrictionsForCourses: 'Age: 7 y 12m to 0',
    });
    expect(quirk.verdict.deterministic).toBe(true);
    expect(quirk.age.ageMinMonths, '7y12m is 8 years').toBe(96);
    expect(quirk.age.ageMaxMonths, 'max 0/0 means no maximum, not a maximum of zero').toBeNull();

    // Measured: "12 to 17 y 11m" means "under 18".
    const teen = resolvedMonths({ MinAge: 12, MaxAge: 17, MaxAgeMonths: 11, NoAgeRestriction: false });
    expect(teen.age.ageMinMonths).toBe(144);
    expect(teen.age.ageMaxMonths).toBe(216);
  });

  it('NoAgeRestriction resolves to all-ages', () => {
    const { verdict, age } = resolvedMonths({ NoAgeRestriction: true });
    expect(verdict.deterministic).toBe(true);
    expect(age.resolved).toBe(true);
    expect(age.ageMinMonths).toBe(0);
    expect(age.ageMaxMonths).toBeNull();
  });

  it('falls back to the display string ONLY when the structured fields are unusable', () => {
    const verdict = resolveAgeText({ DisplayableRestrictionsForCourses: 'Age: 8+' });
    expect(verdict.deterministic, 'flagged as non-deterministic so the report is honest').toBe(false);
    expect(verdict.reason).toBe('DisplayableRestrictionsForCourses');
    expect(parseAgeText(verdict.ageText).ageMinMonths).toBe(96);
  });

  it('every age in the real captured fixture resolves through T13', () => {
    const classes = classesFixture('nvrc.classes.open-gym.page1.json');
    const unresolved = classes.filter((c) => !parseAgeText(resolveAgeText(c).ageText).resolved);
    expect(unresolved.map((c) => c.EventName)).toEqual([]);
  });
});

describe('G-T8-4 venue, identity and record shape', () => {
  it('takes the venue — including coordinates — straight off the record', () => {
    const cls = classesFixture('nvrc.classes.open-gym.page1.json')[0];
    const venue = extractVenue(cls);
    expect(venue.venueName).toBeTruthy();
    expect(venue.venueAddress).toMatch(/,/);
    expect(typeof venue.venueLat).toBe('number');
    expect(typeof venue.venueLng).toBe('number');
  });

  it('treats a (0,0) coordinate as unset rather than the Gulf of Guinea', () => {
    const venue = extractVenue({ Address: { AddressTag: 'X', Latitude: 0, Longitude: 0 } });
    expect(venue.venueLat).toBeUndefined();
    expect(venue.venueLng).toBeUndefined();
  });

  it('occurrence ids are distinct across the real fixture', () => {
    const classes = classesFixture('nvrc.classes.open-gym.page1.json');
    const ids = classes.map((c) => occurrenceRecordId(c, parseTimeRange(c.EventTimeDescription)?.start));
    expect(new Set(ids).size, 'EventId alone repeats; id+date+time+facility does not').toBe(ids.length);
  });

  it('skips closure notices and all-day markers, and counts them', () => {
    const parsed = parseTenantCalendars(nvrc, [
      asCalendar([
        { EventName: 'CLOSED - Pool Maintenance', OccurrenceDate: '20260814', EventTimeDescription: '09:00 am - 10:00 am' },
        { EventName: 'Civic Holiday', OccurrenceDate: '20260814', AllDayEvent: true, EventTimeDescription: '' },
        { EventName: 'Open Gym', OccurrenceDate: '20260814', EventTimeDescription: '09:00 am - 10:00 am', PriceRange: '$3.00' },
      ]),
    ]);
    expect(parsed.stats.skippedClosures).toBe(1);
    expect(parsed.stats.skippedAllDay).toBe(1);
    expect(parsed.stats.recordsEmitted).toBe(1);
  });

  it('applies the client-side window, because the vendor’s own date parameter is ignored', () => {
    const classes = classesFixture('nvrc.classes.open-gym.page1.json');
    const parsed = parseTenantCalendars(nvrc, [asCalendar(classes)], {
      window: { startDate: '1999-01-01', endDate: '1999-01-02' },
    });
    expect(parsed.records).toHaveLength(0);
    expect(parsed.stats.skippedOutsideWindow).toBe(classes.length);
  });
});

// ── G-T8-5: breakage detection ──────────────────────────────────────────────────────

describe('G-T8-5 contract fixtures + breakage detection', () => {
  it('the fixtures still match the shape the parser depends on', () => {
    const classes = classesFixture('nvrc.classes.open-gym.page1.json');
    for (const field of ['EventId', 'EventName', 'OccurrenceDate', 'EventTimeDescription', 'PriceRange']) {
      expect(classes[0], `fixture retains ${field}`).toHaveProperty(field);
    }
  });

  it('an UNRECOGNISED payload key is detected — the shape-drift canary', () => {
    expect(unrecognisedClassKeys(classesFixture('nvrc.classes.open-gym.page1.json'))).toEqual([]);
    expect(unrecognisedClassKeys([{ EventId: 'x', SomethingBrandNew: 1 } as BookMe4Class])).toEqual([
      'SomethingBrandNew',
    ]);
    expect(KNOWN_CLASS_KEYS).toContain('DisplayableRestrictionsForCourses');
  });

  it('a MUTATED fixture fails the parser rather than degrading quietly', () => {
    // The mutation this is really guarding: the vendor renaming or reformatting the time
    // field. A parser that shrugged and emitted midnight would be worse than one that
    // reports the loss.
    const mutated = classesFixture('nvrc.classes.open-gym.page1.json').map((c) => ({
      ...c,
      EventTimeDescription: '0600-0800',
    }));
    const parsed = parseTenantCalendars(nvrc, [asCalendar(mutated)]);
    expect(parsed.records).toHaveLength(0);
    expect(parsed.stats.skippedUnparseableTime).toBe(mutated.length);
    expect(parsed.warnings.join(' ')).toMatch(/unparseable EventTimeDescription/);
  });

  it('shape drift and yield collapse both ALERT on the health board', () => {
    const base = {
      tenantKey: 'nvrc',
      occurrencesParsed: 100,
      requestsUsed: 10,
      baselineOccurrences: null,
      unrecognisedKeys: [] as string[],
      warnings: [] as string[],
    };
    expect(assessRunHealth(base)).toMatchObject({ code: 'ok', alert: false, status: 'success' });
    expect(assessRunHealth({ ...base, unrecognisedKeys: ['classes[].NewThing'] })).toMatchObject({
      code: 'shape_drift',
      alert: true,
    });
    expect(assessRunHealth({ ...base, occurrencesParsed: 10, baselineOccurrences: 100 })).toMatchObject({
      code: 'yield_collapse',
      alert: true,
      status: 'failed',
    });
    // A first run has no baseline and must not be called a collapse.
    expect(assessRunHealth({ ...base, occurrencesParsed: 0, baselineOccurrences: null }).alert).toBe(false);
  });

  it('a BUMPED asset build stamp alerts — the vendor-bundle canary', () => {
    const verdict = assessRunHealth({
      tenantKey: 'nvrc',
      occurrencesParsed: 100,
      requestsUsed: 10,
      baselineOccurrences: null,
      unrecognisedKeys: [],
      warnings: [],
      observedAssetBuildStamp: '08010001',
      expectedAssetBuildStamp: BOOKME4_ASSET_BUILD_STAMP.stamp,
    });
    expect(verdict).toMatchObject({ code: 'asset_build_drift', alert: true, status: 'partial' });
    expect(verdict.detail).toMatch(/07231003/);
    expect(verdict.detail).toMatch(/08010001/);
  });

  it('the circuit-breaker errors map onto health codes', () => {
    const diag = {
      tenantKey: 'nvrc',
      occurrencesParsed: 0,
      requestsUsed: 1,
      baselineOccurrences: null,
      unrecognisedKeys: [],
      warnings: [],
    };
    expect(assessRunHealth({ ...diag, error: new WidgetBlockedError('nvrc', '/x') })).toMatchObject({
      code: 'widget_blocked',
      alert: true,
      status: 'failed',
    });
    expect(assessRunHealth({ ...diag, error: new WidgetRateLimitedError('nvrc', '/x', 60) })).toMatchObject({
      code: 'widget_rate_limited',
      alert: true,
    });
  });

  it('Richmond’s captured payload is REGISTERED VISITS, not drop-in — the G-T8-1 evidence', () => {
    // Kept as a fixture precisely so the null result is falsifiable: if Richmond ever
    // does publish drop-in occurrences, re-capturing this file is how we would find out.
    const classes = classesFixture('richmond.classes.registered-visits.json');
    expect(classes.length).toBeGreaterThan(0);
    expect(
      classes.every((c) => /registered visit|booking/i.test(c.EventName ?? '')),
      'every Richmond record is a book-ahead registered visit'
    ).toBe(true);
    const parsed = parseTenantCalendars(richmond, [asCalendar(classes, 'Minoru Centre for Active Living')]);
    // They parse fine — the point is that Richmond is NOT configured to ingest them.
    expect(parsed.records.length).toBeGreaterThan(0);
    expect(richmond.dropInCategoryNames, 'and config keeps them out').toEqual([]);
  });
});

// ── G-T8-3/6: the adapter end to end ────────────────────────────────────────────────

describe('T8 adapter — triple gate, dry-run default, honest reporting', () => {
  it('is fixture-only and makes ZERO network calls with the env var unset', async () => {
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new PerfectMindAdapter(nvrc);
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    const records = adapter.extract(await adapter.fetch());
    expect(spy).not.toHaveBeenCalled();
    expect(records.length).toBeGreaterThan(0);
    expect(adapter.lastRunReport()?.live).toBe(false);
  });

  it('the dry-run fixture exercises the same honesty rules as a live record', async () => {
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    const adapter = new PerfectMindAdapter(nvrc);
    const [record] = adapter.extract(await adapter.fetch());
    // The synthetic record carries the same "$3 / No fee" trap the live payload does, so
    // a dry run cannot pass while the honesty rules are broken.
    expect(record.costStatus).not.toBe('free');
    expect(record.costStatus).toBe('known');
    expect(parseAgeText(record.ageText).ageMinMonths).toBe(96);
    expect(record.categoryHint).toBe('open_gym');
    expect(record.sourceUrl).toMatch(/^https:\/\/nvrc\.perfectmind\.com\//);
  });

  it('a fixture dry-run never alerts on the health board', async () => {
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    const adapter = new PerfectMindAdapter(nvrc);
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(10_000)).toMatchObject({ code: 'fixture_dry_run', alert: false });
  });

  it('dedup keys are tenant-scoped and family-scoped', async () => {
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    const adapter = new PerfectMindAdapter(nvrc);
    const [record] = adapter.extract(await adapter.fetch());
    expect(adapter.dedupKeys(record).key).toMatch(/^perfectmind::nvrc::/);
    expect(adapter.family).toBe('perfectmind');
  });

  it('env alone cannot enable a tenant config says has nothing (Richmond)', () => {
    process.env.KIDS_FUN_LIVE_PERFECTMIND = 'richmond,nvrc';
    expect(new PerfectMindAdapter(richmond).isLiveFetchEnabled()).toBe(false);
    expect(new PerfectMindAdapter(nvrc).isLiveFetchEnabled()).toBe(true);
  });

  it('the run report counts truncated calendars so partial coverage is visible', async () => {
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    const adapter = new PerfectMindAdapter(nvrc);
    adapter.extract(await adapter.fetch());
    const report = adapter.lastRunReport()!;
    expect(report.calendarsFetched).toBe(1);
    expect(report.calendarsTruncated).toBe(0);
    expect(report.parse.costStatusCounts.free, 'the fixture is honestly not free').toBe(0);
  });
});
