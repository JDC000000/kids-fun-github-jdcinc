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
  defaultWindow,
  windowDays,
  shortfallCalendarsFor,
  DEFAULT_WINDOW_DAYS,
} from '../../worker/adapters/perfectmind';
import {
  buildFormBody,
  fetchCalendar,
  selectDropInCalendars,
  unrecognisedClassKeys,
  KNOWN_CLASS_KEYS,
  RequestBudget,
  END_OF_STRIDE_CURSOR,
  MAX_PAGES_PER_STRIDE,
  MAX_EMPTY_STRIDES_IN_A_ROW,
  STRIDE_DAYS,
  stridesForWindow,
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
    stridesWalked: 2,
    truncated: false,
    warnings: [],
  };
}

/**
 * A faithful stand-in for the real portal, built from the measured walk in client.ts's
 * header: `page` selects a 14-day stride, `after` walks a cursor inside it, and the
 * "0001-01-01" sentinel means END OF STRIDE, not end of data.
 */
function fakePortal(opts: { days: number; perDay: number; pageSize: number; startDate: string }) {
  const bodies: string[] = [];
  const start = Date.parse(`${opts.startDate}T00:00:00Z`);
  const dayOf = (i: number) => new Date(start + i * 86_400_000).toISOString().slice(0, 10);
  // Faithful enough to survive parse.ts, not just the client: a record with no
  // EventTimeDescription is (correctly) dropped by the parser, so a fake without one
  // cannot be used to assert anything end-to-end.
  const all = Array.from({ length: opts.days }, (_, d) =>
    Array.from({ length: opts.perDay }, (_, n) => ({
      EventId: `e${d}-${n}`,
      EventName: `$3 Open Gym 8yrs+ slot ${n}`,
      OccurrenceDate: dayOf(d).replace(/-/g, ''),
      EventTimeDescription: `${String(9 + n).padStart(2, '0')}:00 am - ${String(10 + n).padStart(2, '0')}:00 am`,
      PriceRange: 'No fee',
      MinAge: 8,
      NoAgeRestriction: false,
      Facility: 'Gymnasium',
      Location: 'Fixture Recreation Centre',
      date: dayOf(d),
    }))
  ).flat();

  const fetchImpl = (async (_u: unknown, init?: unknown) => {
    const body = String((init as { body?: string })?.body ?? '');
    bodies.push(body);
    const params = new URLSearchParams(body);
    const stride = Number(params.get('page') ?? '0');
    const after = params.get('after') || '';

    const strideStart = dayOf(stride * STRIDE_DAYS);
    const strideEnd = dayOf((stride + 1) * STRIDE_DAYS - 1);
    const inStride = all.filter((r) => r.date >= strideStart && r.date <= strideEnd);
    const remaining = after ? inStride.filter((r) => r.date > after) : inStride;

    if (remaining.length === 0) {
      return new Response(
        JSON.stringify({ classes: [], classesMaxEndDateString: null, nextKey: '0001-01-01' }),
        { status: 200 }
      );
    }
    // The portal returns whole days up to roughly pageSize records.
    const batch: typeof remaining = [];
    for (const r of remaining) {
      if (batch.length >= opts.pageSize && r.date !== batch[batch.length - 1].date) break;
      batch.push(r);
    }
    // `date` is this fake's own bookkeeping, NOT part of the vendor contract — strip it
    // before it goes on the wire. (Leaving it in trips the unrecognised-key canary, which
    // is the canary working correctly: it caught a foreign field in a test fixture.)
    const wire = batch.map(({ date: _date, ...rest }) => rest);
    return new Response(JSON.stringify({ classes: wire, nextKey: batch[batch.length - 1].date }), {
      status: 200,
    });
  }) as typeof fetch;

  return { fetchImpl, bodies, all };
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

  it('the declared window spans EXACTLY DEFAULT_WINDOW_DAYS days (QA C1)', () => {
    // The off-by-one QA measured: the window used to be [today, today + 28] INCLUSIVE =
    // 29 days, while 2 strides only cover 28 — so the last declared day was never
    // fetched (41 real occurrences on that day, live). Asserting the SPAN rather than the
    // end date is what makes this catch a regression regardless of how the date is built.
    const window = defaultWindow(nvrc, new Date('2026-07-31T12:00:00Z'));
    expect(window.startDate).toBe('2026-07-31');
    expect(windowDays(window), 'declared span equals the constant').toBe(DEFAULT_WINDOW_DAYS);
    // And the depth bought is exactly the depth declared — no lost tail, no wasted stride.
    expect(stridesForWindow(windowDays(window)) * STRIDE_DAYS).toBe(DEFAULT_WINDOW_DAYS);
    expect(window.endDate, 'day 27, not day 28').toBe('2026-08-27');
  });

  it('windowDays counts inclusively and degrades safely on nonsense', () => {
    expect(windowDays({ startDate: '2026-07-31', endDate: '2026-07-31' })).toBe(1);
    expect(windowDays({ startDate: '2026-07-31', endDate: '2026-08-27' })).toBe(28);
    // An inverted or unparseable window falls back to the constant rather than yielding
    // 0 strides (which would fetch nothing at all while looking successful).
    expect(windowDays({ startDate: '2026-08-27', endDate: '2026-07-31' })).toBe(DEFAULT_WINDOW_DAYS);
    expect(windowDays({ startDate: 'nonsense', endDate: 'nonsense' })).toBe(DEFAULT_WINDOW_DAYS);
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

  it('derives crawl depth from the ingest window', () => {
    expect(STRIDE_DAYS).toBe(14);
    expect(stridesForWindow(28), 'a 28-day window needs 2 strides').toBe(2);
    expect(stridesForWindow(14)).toBe(1);
    expect(stridesForWindow(15), 'a partial stride still has to be walked').toBe(2);
    expect(stridesForWindow(0), 'never zero — always fetch something').toBe(1);
  });

  it('ACCEPTANCE (QA B1): a real walk covers the FULL declared window, not one stride', async () => {
    // THE BUG THIS EXISTS TO CATCH. The first build pinned `page: 0`, so it could never
    // see past day 13 of a declared 28-day window — and it reported truncated:false with
    // no warnings while doing it. QA proved it against the live portal. The bar here is
    // not "a pagination test passes"; it is "the returned records actually span the whole
    // window", which is the only assertion the old implementation cannot satisfy.
    const WINDOW_DAYS = 28;
    const portal = fakePortal({ days: WINDOW_DAYS, perDay: 9, pageSize: 50, startDate: '2026-07-31' });

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Open Gym Schedules', categoryName: '**Drop-In Schedules' },
      { budget: new RequestBudget('nvrc', 140), fetchImpl: portal.fetchImpl, sleepImpl: async () => {} },
      undefined,
      stridesForWindow(WINDOW_DAYS)
    );

    const dates = [...new Set(result.classes.map((c) => c.OccurrenceDate))].sort();
    expect(dates[0], 'starts at the window start').toBe('20260731');
    expect(dates[dates.length - 1], 'reaches the window END — day 27, not day 13').toBe('20260827');
    expect(dates.length, 'every day in the window is represented').toBe(WINDOW_DAYS);
    expect(result.occurrenceCount, 'nothing dropped between strides').toBe(portal.all.length);
    expect(result.stridesWalked).toBe(2);
    expect(result.truncated).toBe(false);

    // And the mechanism: `page` DID advance, and the cursor reset at each stride boundary.
    const pages = portal.bodies.map((b) => new URLSearchParams(b).get('page'));
    expect(new Set(pages), '`page` is a stride selector and must move').toEqual(new Set(['0', '1']));
    const firstOfStride1 = portal.bodies.find((b) => new URLSearchParams(b).get('page') === '1')!;
    expect(
      new URLSearchParams(firstOfStride1).get('after'),
      'the cursor RESETS when the stride advances'
    ).toBe('');
  });

  it('the sentinel ends a STRIDE, not the walk — stride 1 is still fetched after it', async () => {
    const portal = fakePortal({ days: 28, perDay: 9, pageSize: 50, startDate: '2026-07-31' });
    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Open Gym Schedules', categoryName: '**Drop-In Schedules' },
      { budget: new RequestBudget('nvrc', 140), fetchImpl: portal.fetchImpl, sleepImpl: async () => {} },
      undefined,
      2
    );
    // Stride 0 hands back the sentinel at day 13; the walk must continue into stride 1.
    expect(result.classes.some((c) => c.OccurrenceDate === '20260813')).toBe(true);
    expect(result.classes.some((c) => c.OccurrenceDate === '20260814')).toBe(true);
    expect(END_OF_STRIDE_CURSOR).toBe('0001-01-01');
  });

  it('a stride ending with DATA + the sentinel still advances to the next stride', async () => {
    // FOUND BY MUTATION, not by design. The `fakePortal` above only ever emits the
    // sentinel on an EMPTY response, so `if (batch.length === 0) break` always fired
    // first and the sentinel branch was never actually executed — a mutation that turned
    // that branch into `return result` (i.e. "sentinel = end of ALL data", the original
    // B1 bug in its second form) left the whole suite green.
    //
    // The live portal happens to send the sentinel alone today, but nothing in the
    // contract promises that, and a vendor that starts attaching it to the final
    // populated page would silently re-introduce the half-window bug. So this drives the
    // sentinel arriving WITH records.
    const fetchImpl = (async (_u: unknown, init?: unknown) => {
      const params = new URLSearchParams(String((init as { body?: string })?.body ?? ''));
      const stride = Number(params.get('page') ?? '0');
      if (stride > 1) {
        return new Response(JSON.stringify({ classes: [], nextKey: END_OF_STRIDE_CURSOR }), { status: 200 });
      }
      // Data AND the end-of-stride sentinel in the same response.
      return new Response(
        JSON.stringify({
          classes: [{ EventId: `s${stride}`, OccurrenceDate: stride === 0 ? '20260805' : '20260819' }],
          nextKey: END_OF_STRIDE_CURSOR,
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Open Gym Schedules', categoryName: '**Drop-In Schedules' },
      { budget: new RequestBudget('nvrc', 20), fetchImpl, sleepImpl: async () => {} },
      undefined,
      2
    );

    expect(result.stridesWalked, 'the sentinel ends the STRIDE, not the walk').toBe(2);
    expect(result.classes.map((c) => c.OccurrenceDate)).toEqual(['20260805', '20260819']);
  });

  it('walks the `after` cursor WITHIN a stride, carrying the previous nextKey', async () => {
    const page1 = fixture<{ classes: BookMe4Class[]; nextKey: string }>('nvrc.classes.open-gym.page1.json');
    const page2 = fixture<{ classes: BookMe4Class[]; nextKey: string }>('nvrc.classes.open-gym.page2.json');
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_u: unknown, init?: unknown) => {
      bodies.push(String((init as { body?: string })?.body ?? ''));
      const payload = call++ === 0 ? page1 : { classes: [], nextKey: END_OF_STRIDE_CURSOR };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;

    await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Open Gym Schedules', categoryName: '**Drop-In Schedules' },
      { budget: new RequestBudget('nvrc', 10), fetchImpl, sleepImpl: async () => {} },
      undefined,
      1
    );
    expect(new URLSearchParams(bodies[0]).get('after'), 'first page has no cursor').toBe('');
    expect(new URLSearchParams(bodies[1]).get('after'), 'second carries the first nextKey').toBe(
      page1.nextKey
    );
    expect(page2.classes.length, 'fixture page 2 is real cursor-walked data').toBeGreaterThan(0);
  });

  it('gives up after two consecutive EMPTY strides', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ classes: [], nextKey: END_OF_STRIDE_CURSOR }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Quiet', categoryName: 'c' },
      { budget: new RequestBudget('nvrc', 50), fetchImpl, sleepImpl: async () => {} },
      undefined,
      12
    );
    expect(result.stridesWalked, 'stops after 2 empty strides, not all 12').toBe(2);
    expect(calls).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('an EARLY exit on empty strides WARNS when window remains (QA Q1)', async () => {
    // The defect QA found, and it is B1's signature relocated: the early return used to
    // be silent, on the argument that a short calendar ending is normal. It IS normal —
    // when it happens on the last stride. Ending EARLY with window left is a run that
    // covered less than it declared and said nothing.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ classes: [], nextKey: END_OF_STRIDE_CURSOR }), {
        status: 200,
      })) as typeof fetch;

    const early = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Quiet', categoryName: 'c' },
      { budget: new RequestBudget('nvrc', 50), fetchImpl, sleepImpl: async () => {} },
      undefined,
      6 // six strides asked for; it will stop after two empty ones
    );
    expect(early.stridesWalked, 'stops where it actually stopped').toBe(2);
    expect(early.warnings.join(' ')).toMatch(/4 stride\(s\) of the declared window never fetched/);

    // ...and stays QUIET when the walk ends on the last stride anyway, so a genuinely
    // short calendar does not generate noise on every run.
    const complete = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Quiet', categoryName: 'c' },
      { budget: new RequestBudget('nvrc', 50), fetchImpl, sleepImpl: async () => {} },
      undefined,
      2
    );
    expect(complete.stridesWalked).toBe(2);
    expect(complete.warnings, 'no window left unfetched — nothing to report').toEqual([]);
  });

  it('MAX_EMPTY_STRIDES_IN_A_ROW is load-bearing at 2 — an empty stride 0 is real', async () => {
    // QA's live sweep: NVRC's Skate Schedules has a genuinely EMPTY stride 0 with all its
    // records in stride 1. Tolerating only ONE empty stride would silently drop that whole
    // calendar today. Pinned so nobody "tidies" the constant down.
    expect(MAX_EMPTY_STRIDES_IN_A_ROW).toBe(2);
    const fetchImpl = (async (_u: unknown, init?: unknown) => {
      const stride = Number(new URLSearchParams(String((init as { body?: string })?.body ?? '')).get('page'));
      if (stride === 0) {
        return new Response(JSON.stringify({ classes: [], nextKey: END_OF_STRIDE_CURSOR }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ classes: [{ EventId: 'skate' }], nextKey: END_OF_STRIDE_CURSOR }),
        { status: 200 }
      );
    }) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Skate Schedules', categoryName: '**Drop-In Schedules' },
      { budget: new RequestBudget('nvrc', 50), fetchImpl, sleepImpl: async () => {} },
      undefined,
      2
    );
    expect(result.occurrenceCount, 'stride 1 data survives an empty stride 0').toBe(1);
  });

  it('stops when the cursor does not ADVANCE — a vendor echoing a fixed key cannot loop us', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ classes: [{ EventId: 'x' }], nextKey: '2026-08-05' }), {
        status: 200,
      })) as typeof fetch;

    const result = await fetchCalendar(
      nvrc,
      { calendarId: 'CAL', calendarName: 'Stuck', categoryName: 'c' },
      { budget: new RequestBudget('nvrc', 50), fetchImpl, sleepImpl: async () => {} },
      undefined,
      1
    );
    // First page sets the cursor; second returns the SAME key, which ends that stride.
    expect(result.pagesFetched).toBe(2);
    expect(result.pagesFetched).toBeLessThan(MAX_PAGES_PER_STRIDE);
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
      { budget: new RequestBudget('nvrc', 100), fetchImpl, sleepImpl: async () => {} },
      undefined,
      1
    );
    expect(result.pagesFetched).toBe(MAX_PAGES_PER_STRIDE);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/this stride may be incomplete/);
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
          { budget: new RequestBudget('nvrc', 10), fetchImpl, sleepImpl: async () => {} },
          undefined,
          1
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
        { budget, fetchImpl, sleepImpl: async () => {} },
        undefined,
        1
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

  it('SEAM PIN (QA C2): a LIVE adapter run covers the full declared window', async () => {
    // WHAT THIS CLOSES. B1's acceptance test drove fetchCalendar() directly with an
    // explicitly-passed stride count, so it proved the WALK but not the WIRING. QA showed
    // that hard-coding `strides = 1` at this call site left the entire suite green —
    // silently reinstating the exact bug B1 fixed, one layer up.
    //
    // So this drives the real PerfectMindAdapter.fetch() end to end, env-enabled, against
    // a portal fake spanning the whole window, and asserts on the RECORDS: they must
    // reach the last day the window declares. Any hard-coded stride count fails it, and
    // so does a window/depth mismatch — it is behavioural, so it cannot be satisfied by
    // wiring that merely looks right.
    process.env.KIDS_FUN_LIVE_PERFECTMIND = 'nvrc';
    const adapter = new PerfectMindAdapter(nvrc);
    expect(adapter.isLiveFetchEnabled()).toBe(true);

    const window = defaultWindow(nvrc);
    const portal = fakePortal({
      days: DEFAULT_WINDOW_DAYS + 7, // the portal holds MORE than we ask for
      perDay: 6,
      pageSize: 50,
      startDate: window.startDate,
    });
    // One drop-in calendar in the tree, then the classes walk.
    const categories = JSON.stringify([
      {
        Name: '**Drop-In Schedules',
        Calendars: [
          {
            Id: '11111111-2222-3333-4444-555555555555',
            Name: 'Open Gym Schedules',
            BookingLink: '/x',
            BookingTypeInfo: { BookingType: 2 },
          },
        ],
      },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: unknown) => {
      if (String(url).includes('GetCategoriesDataV2')) {
        return new Response(categories, { status: 200 });
      }
      return portal.fetchImpl(url as string, init as RequestInit);
    }) as typeof fetch);

    vi.useFakeTimers();
    const pending = adapter.fetch();
    await vi.advanceTimersByTimeAsync(1_200_000);
    const raw = await pending;
    vi.useRealTimers();

    const records = adapter.extract(raw);
    const dates = [...new Set(records.map((r) => r.startDatetimeUtc!.slice(0, 10)))].sort();
    expect(dates[0], 'covers the first declared day').toBe(window.startDate);
    expect(dates[dates.length - 1], 'covers the LAST declared day — C1 + C2 together').toBe(
      window.endDate
    );
    expect(dates.length, 'every day of the declared window is present').toBe(DEFAULT_WINDOW_DAYS);

    // The window is still enforced: the portal held 7 extra days and none leaked in.
    expect(records.every((r) => r.startDatetimeUtc!.slice(0, 10) <= window.endDate)).toBe(true);

    const report = adapter.lastRunReport()!;
    expect(report.minStridesWalked).toBe(report.stridesRequired);
    expect(report.truncatedCalendars).toEqual([]);
    expect(report.health.alert, 'full coverage is not an alert').toBe(false);
  });

  it('SEAM PIN, structural: depth derives from the WINDOW, never from the constant', () => {
    // Behavioural tests cannot catch this one, and saying so is more useful than
    // pretending otherwise. `stridesForWindow(windowDays(window))` and
    // `stridesForWindow(DEFAULT_WINDOW_DAYS)` are indistinguishable TODAY, because
    // defaultWindow() is built from that same constant — a mutation swapping one for the
    // other leaves every behavioural test green (verified by hand).
    //
    // They stop being equivalent the moment the window becomes per-tenant, configurable,
    // or seasonal — at which point depth would silently follow the constant while the
    // window moved, which is C1 all over again. So the derivation is pinned at the SOURCE
    // level, the same technique tests/compliance/no-bypass.test.ts uses to pin endpoint
    // path literals.
    const src = readFileSync(resolve(process.cwd(), 'worker/adapters/perfectmind/index.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const call = /fetchTenant\([^)]*\{\s*budget\s*\}\s*,\s*([^)]+)\)/.exec(code);
    expect(call, 'fetchTenant is called with an explicit stride depth').not.toBeNull();
    expect(call![1], 'depth is derived from the run window, not a constant or a literal').toContain(
      'windowDays('
    );
    expect(call![1], 'a bare constant here would silently decouple depth from the window')
      .not.toMatch(/DEFAULT_WINDOW_DAYS|^\s*\d+\s*$/);
  });

  it('a TRUNCATED calendar ALERTS on the health board (QA C2)', () => {
    // The other half of C2: the run report carried coverage numbers that nothing acted
    // on. Truncation — not a low stride count — is the signal that genuinely means "there
    // was more data and we stopped asking", so that is what alerts.
    const base = {
      tenantKey: 'nvrc',
      occurrencesParsed: 500,
      requestsUsed: 40,
      baselineOccurrences: null,
      unrecognisedKeys: [] as string[],
      warnings: [] as string[],
    };
    expect(assessRunHealth(base).alert).toBe(false);
    const verdict = assessRunHealth({ ...base, truncatedCalendars: ['Open Gym Schedules'] });
    expect(verdict).toMatchObject({ code: 'coverage_truncated', alert: true, status: 'partial' });
    expect(verdict.detail).toMatch(/Open Gym Schedules/);
    expect(assessRunHealth({ ...base, truncatedCalendars: [] }).alert).toBe(false);
  });

  it('coverage_shortfall requires PRODUCED DATA, then a short stop (QA predicate fix)', () => {
    // The predicate is the design. Three positions were held on this; the first two were
    // measurably wrong, and each wrong case is asserted here so neither can come back.
    const base = {
      tenantKey: 'nvrc',
      occurrencesParsed: 1061,
      requestsUsed: 47,
      baselineOccurrences: null,
      unrecognisedKeys: [] as string[],
      warnings: [] as string[],
    };

    // THE REAL SIGNAL: a calendar that produced data and then stopped short.
    const verdict = assessRunHealth({ ...base, shortfallCalendars: ['Open Gym Schedules'] });
    expect(verdict).toMatchObject({ code: 'coverage_shortfall', alert: true, status: 'partial' });
    expect(verdict.detail).toMatch(/produced data and then stopped short/);
    expect(verdict.detail).toMatch(/Open Gym Schedules/);

    // NOT a shortfall: nothing qualified. This is the state a FAILED calendar
    // (stridesWalked 0, occurrenceCount 0) and a legitimately EMPTY one both reduce to
    // under the corrected predicate — the old one alerted on both.
    expect(assessRunHealth({ ...base, shortfallCalendars: [] }).alert).toBe(false);

    // Truncation still takes precedence — it is the less ambiguous signal.
    expect(
      assessRunHealth({ ...base, shortfallCalendars: ['A'], truncatedCalendars: ['B'] }).code
    ).toBe('coverage_truncated');
  });

  it('a FAILED calendar is labelled a failure, NOT a coverage problem (live bug, QA)', async () => {
    // MEASURED, not hypothetical. Under the old predicate a per-calendar fetch failure was
    // recorded with stridesWalked:0, which satisfied `minStridesWalked < stridesRequired`
    // and produced coverage_shortfall — mislabelling a payload-contract failure as a
    // coverage problem, while the correct label sat unreachable. This drives the real
    // adapter through that exact path.
    process.env.KIDS_FUN_LIVE_PERFECTMIND = 'nvrc';
    const adapter = new PerfectMindAdapter(nvrc);
    const categories = JSON.stringify([
      {
        Name: '**Drop-In Schedules',
        Calendars: [
          { Id: 'a'.repeat(36), Name: 'Broken Calendar', BookingLink: '/x', BookingTypeInfo: { BookingType: 2 } },
        ],
      },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      if (String(url).includes('GetCategoriesDataV2')) return new Response(categories, { status: 200 });
      return new Response('<html>not json</html>', { status: 200 });
    }) as typeof fetch);

    vi.useFakeTimers();
    const pending = adapter.fetch();
    await vi.advanceTimersByTimeAsync(600_000);
    const raw = await pending;
    vi.useRealTimers();
    adapter.extract(raw);

    const report = adapter.lastRunReport()!;
    expect(report.minStridesWalked, 'a failed calendar records zero strides walked').toBe(0);
    expect(report.minStridesWalked).toBeLessThan(report.stridesRequired);
    // ...and precisely BECAUSE it produced nothing, it is NOT a coverage shortfall.
    expect(report.shortfallCalendars, 'produced no data — not a coverage problem').toEqual([]);
    expect(report.health.code).not.toBe('coverage_shortfall');
    expect(report.warnings.join(' '), 'the real failure is still reported').toMatch(/non-JSON|contract/i);
  });

  it('the shortfall PREDICATE itself, exercised directly (unreachable via fetch today)', () => {
    // WHY THIS IS A DIRECT UNIT TEST AND NOT AN ADAPTER-LEVEL ONE: at the current 28-day
    // window the condition cannot occur through fetch() at all — 2 strides, and the only
    // path yielding stridesWalked:0 is a fetch failure, which the occurrenceCount half
    // now excludes. That means NO behavioural test can distinguish "guard present" from
    // "guard deleted", and a mutation removing the guard entirely passed silently until
    // the predicate was pulled out where it could be exercised. Logic that is unreachable
    // today still has to be provably correct for the day the window widens, or it is
    // decoration that someone will trust later.
    const required = 6;
    const cal = (name: string, occurrenceCount: number, stridesWalked: number) => ({
      calendarName: name, calendarId: 'id-' + name, occurrenceCount, stridesWalked,
    });

    expect(
      shortfallCalendarsFor(
        [
          cal('Producing then stopped', 120, 3), // THE signal
          cal('Failed fetch', 0, 0),             // v1 mislabelled this as coverage
          cal('Legitimately empty (NSNH)', 0, 2), // v1 would alert forever at a wide window
          cal('Complete', 400, 6),               // walked the whole window
        ],
        required
      ),
      'only "produced data AND THEN stopped short" qualifies'
    ).toEqual(['Producing then stopped']);

    // Boundary: walking exactly the required strides is not a shortfall.
    expect(shortfallCalendarsFor([cal('Exact', 10, required)], required)).toEqual([]);
    // Boundary: one stride short WITH data is.
    expect(shortfallCalendarsFor([cal('OneShort', 10, required - 1)], required)).toEqual(['OneShort']);
    // Falls back to the id when a calendar has no name.
    expect(
      shortfallCalendarsFor([{ calendarName: undefined, calendarId: 'guid-1', occurrenceCount: 5, stridesWalked: 1 }], required)
    ).toEqual(['guid-1']);
  });

  it('a legitimately EMPTY calendar never alerts (NVRC North Shore Neighbourhood House)', () => {
    // The config already documents NSNH as "expected to yield nothing" (empty
    // BookingLink). Under the old predicate it would have alerted on every single run at
    // any widened window, while 1,061 occurrences ingested correctly around it.
    expect(nvrc.evidenceNote).toMatch(/North Shore Neighbourhood House/);
    const shortfall = [{ calendarName: 'North Shore Neighbourhood House Schedules', occurrenceCount: 0, stridesWalked: 2 }]
      .filter((c) => c.occurrenceCount > 0 && c.stridesWalked < 6)
      .map((c) => c.calendarName);
    expect(shortfall, 'zero-yield drops out of the population entirely').toEqual([]);
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
    expect(report.truncatedCalendars).toEqual([]);
    expect(report.parse.costStatusCounts.free, 'the fixture is honestly not free').toBe(0);
    // QA C2: the previous version of this compared two copies of the SAME expression, so
    // it could not fail. Both sides are now independent LITERALS derived by hand from the
    // measured contract: a 28-day window at a 14-day stride is 2 strides, full stop.
    expect(report.stridesRequired, '28-day window / 14-day stride').toBe(2);
    expect(report.minStridesWalked).toBe(2);
  });
});
