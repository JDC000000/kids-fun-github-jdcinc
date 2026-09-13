// tests/adapters/activenet-activity-age.test.ts — the source's own age beats our reading of its
// marketing copy.
//
// Every `age_description` / `age_min_*` / `age_max_*` tuple below is VERBATIM from ActiveNet's
// own API (/rest/activity/detail/<id> and /rest/activities/list, fetched 2026-09-12), not
// invented. The prose beside them is the real catalog_description that was being trusted instead.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { activityAgeToBounds, ActivityAgeResolver, isFatalPortalError } from '../../worker/adapters/activenet/activity-age';
import { resolveRecordAge } from '../../worker/core/age';
import { allAgesInPlay } from '../../worker/adapters/activenet/parse';
import { ActiveNetAdapter } from '../../worker/adapters/activenet';
import { getTenantConfig } from '../../worker/adapters/activenet/config';
import type { StructuredRecord } from '../../worker/core/adapter';
import { clearPolicyState } from '../../worker/health/policy';

const VANCOUVER = getTenantConfig('vancouver')!;
const NO_SLEEP = { sleepImpl: async () => {} };

// The portal circuit-breaker is MODULE-level state keyed by tenant, so one test's 403 trips it
// and every later test in this file is short-circuited before it makes a request — which is
// exactly how three passing assertions here turned into "expected undefined" once a 403 test was
// added above them. Reset it per test so each one exercises the path it claims to.
beforeEach(() => clearPolicyState());

/** A portal stub that answers activity/detail/<id> from a table and counts the calls. */
function stubDetails(table: Record<number, Record<string, unknown> | null>) {
  const calls: number[] = [];
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const id = Number(url.pathname.split('/').pop());
    calls.push(id);
    const detail = table[id];
    if (detail === undefined) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ headers: { response_code: '0000' }, body: { detail } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('activityAgeToBounds — the vendor age shapes that actually occur', () => {
  const cases: Array<[string, Record<string, unknown>, { minMonths: number; maxMonths: number | null; notes?: string } | null]> = [
    [
      'open-ended minimum ("19 yrs +,") — Bootcamp Circuits 622738, Karate (Adults) 622061',
      { age_description: '19 yrs +,', age_min_year: 19, age_max_year: 0, age_max_month: 0 },
      { minMonths: 228, maxMonths: null, notes: undefined },
    ],
    [
      'seniors minimum ("50 yrs +,") — Wu\'s Tai Chi 617239',
      { age_description: '50 yrs +,', age_min_year: 50, age_max_year: 0 },
      { minMonths: 600, maxMonths: null, notes: undefined },
    ],
    [
      'genuine all-ages ("All ages,") — |Public Skate|, 120 of the 227',
      { age_description: 'All ages,', age_min_year: 0, age_max_year: 0 },
      { minMonths: 0, maxMonths: null, notes: 'all-ages' },
    ],
    [
      'ceiling only ("Age less than 6 yrs,") — Gym Bugs Drop In 622896',
      { age_description: 'Age less than 6 yrs,', age_min_year: 0, age_max_year: 6 },
      { minMonths: 0, maxMonths: 72, notes: undefined },
    ],
    [
      'closed range — Tae Kwon Do Level 1 & Level 2 622404, a CHILDREN\'S class',
      { age_description: 'Age at least 6 yrs but less than 13y 11m 4w,', age_min_year: 6, age_max_year: 13, age_max_month: 11, age_max_week: 4 },
      { minMonths: 72, maxMonths: 167, notes: undefined },
    ],
    [
      '99y sentinel is open-ended — Ukulele - Jam Circle (All ages), a 55+ group',
      { age_description: 'Age at least 55 yrs but less than 99y 11m,', age_min_year: 55, age_max_year: 99, age_max_month: 11 },
      { minMonths: 660, maxMonths: null, notes: undefined },
    ],
    [
      'months granularity — Music With Marnie - Babies (2 mo-18 mo)',
      { age_description: 'Age at least 2m but less than 1y 5m,', age_min_year: 0, age_min_month: 2, age_max_year: 1, age_max_month: 5 },
      { minMonths: 2, maxMonths: 17, notes: undefined },
    ],
    ['no structured age at all', { age_min_year: 19 }, null],
    ['null detail', null as unknown as Record<string, unknown>, null],
    [
      'a range this system cannot express is refused, not invented',
      { age_description: 'broken,', age_min_year: 10, age_max_year: 5 },
      null,
    ],
  ];
  for (const [label, detail, expected] of cases) {
    it(label, () => {
      const got = activityAgeToBounds(detail as never);
      if (expected === null) expect(got).toBeNull();
      else expect(got).toEqual(expected);
    });
  }

  it('never widens a bound: weeks are dropped downward, never rounded up', () => {
    // "less than 13y 11m 4w" -> 167 months, not 168. Under-admitting by <1 month is the safe
    // direction; over-admitting is the direction that puts a child in an adult class.
    const got = activityAgeToBounds({
      age_description: 'Age at least 6 yrs but less than 13y 11m 4w,',
      age_min_year: 6, age_max_year: 13, age_max_month: 11, age_max_week: 4,
    } as never);
    expect(got!.maxMonths).toBe(167);
  });
});

describe('allAgesInPlay — the lookup gate', () => {
  it('fires when the TITLE claims it (the case the carve-out gets wrong)', () => {
    expect(allAgesInPlay({ title: 'Ukulele - Jam Circle (All ages)', description: '' })).toBe(true);
  });
  it('fires when only the DESCRIPTION says it (the |Public Skate| recovery)', () => {
    expect(allAgesInPlay({ title: '|Public Skate|', description: '<p>Open skate for all ages</p>' })).toBe(true);
  });
  it('fires on the 19+ karate prose, so the contradiction can be caught', () => {
    expect(allAgesInPlay({ title: 'Karate - Ku Yu Kai Go-Ju Ryu (Adults)', description: '<p>teaches classes for all ages and levels</p>' })).toBe(true);
  });
  it('does NOT fire on ordinary copy — the overwhelming majority pay nothing', () => {
    expect(allAgesInPlay({ title: 'Bootcamp Circuits', description: '<p>Bring your own mat. Drop in $9.</p>' })).toBe(false);
    expect(allAgesInPlay({ title: 'Youth Basketball', description: '<p>Youth drop-in.</p>' })).toBe(false);
  });
});

describe('ActivityAgeResolver', () => {
  it('asks once per activity, however many occurrences share it', async () => {
    const { calls, impl } = stubDetails({ 622061: { age_description: '19 yrs +,', age_min_year: 19 } });
    const r = new ActivityAgeResolver(VANCOUVER, { budget: new (await import('../../worker/adapters/activenet/client')).RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    for (let i = 0; i < 5; i += 1) expect(await r.resolve(622061)).toEqual({ minMonths: 228, maxMonths: null, notes: undefined });
    expect(calls).toEqual([622061]);
  });

  it('remembers a miss too, so a silent source is not re-asked all run', async () => {
    const { calls, impl } = stubDetails({ 1: { activity_name: 'no age here' } });
    const r = new ActivityAgeResolver(VANCOUVER, { budget: new (await import('../../worker/adapters/activenet/client')).RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    expect(await r.resolve(1)).toBeNull();
    expect(await r.resolve(1)).toBeNull();
    expect(calls).toEqual([1]);
  });

  it('a non-fatal failure is UNDEFINED — "no answer", never "no age"', async () => {
    // The distinction is load-bearing downstream: the backfill planner maps null to
    // LEAVE_SOURCE_SILENT (the source confidently has no age) and undefined to AMBIGUOUS.
    // Returning null here would make a row we never successfully asked about look verified.
    const { impl } = stubDetails({});
    const r = new ActivityAgeResolver(VANCOUVER, { budget: new (await import('../../worker/adapters/activenet/client')).RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    await expect(r.resolve(999)).resolves.toBeUndefined();
    expect(r.stats.failures).toBe(1);
  });

  it('NULL is reserved for "the source answered and has no age"', async () => {
    const { impl } = stubDetails({ 5: { activity_name: 'answered, but no age field' } });
    const r = new ActivityAgeResolver(VANCOUVER, { budget: new (await import('../../worker/adapters/activenet/client')).RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    await expect(r.resolve(5)).resolves.toBeNull();
    expect(r.stats.failures).toBe(0);
  });

  it('caches an UNDEFINED result too — the .has() check, not get() !== undefined', async () => {
    // With `get(id) !== undefined` as the membership test, a cached undefined is indistinguishable
    // from a cache miss and the resolver re-asks the portal on every occurrence of that activity.
    const { calls, impl } = stubDetails({});
    const r = new ActivityAgeResolver(VANCOUVER, { budget: new (await import('../../worker/adapters/activenet/client')).RequestBudget('v', 50), fetchImpl: impl, ...NO_SLEEP });
    await r.resolve(777);
    await r.resolve(777);
    await r.resolve(777);
    expect(calls).toEqual([777]);
  });

  describe('fatal portal errors must interrupt, not be folded into a result', () => {
    const status = (code: number) =>
      (async () => new Response('no', { status: code })) as unknown as typeof fetch;

    it('classifies only the stop-the-run errors as fatal', async () => {
      const { PortalBlockedError, PortalRateLimitedError, RequestCapExceededError, PortalProtocolError } =
        await import('../../worker/adapters/activenet/client');
      expect(isFatalPortalError(new RequestCapExceededError('v', 10))).toBe(true);
      expect(isFatalPortalError(new PortalBlockedError('v', 'activityDetail'))).toBe(true);
      expect(isFatalPortalError(new PortalRateLimitedError('v', 'activityDetail', 30))).toBe(true);
      expect(isFatalPortalError(new PortalProtocolError('v', 'weird body'))).toBe(false);
      expect(isFatalPortalError(new Error('something else'))).toBe(false);
    });

    it('rethrows a 403 block instead of reporting it as "no age"', async () => {
      const { RequestBudget } = await import('../../worker/adapters/activenet/client');
      const r = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 50), fetchImpl: status(403), ...NO_SLEEP });
      await expect(r.resolve(1)).rejects.toThrow();
    });

    it('rethrows a 429 rate-limit instead of reporting it as "no age"', async () => {
      const { RequestBudget } = await import('../../worker/adapters/activenet/client');
      const r = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 50), fetchImpl: status(429), ...NO_SLEEP });
      await expect(r.resolve(1)).rejects.toThrow();
    });

    it('rethrows budget exhaustion — the runner\'s break can only work if this propagates', async () => {
      const { RequestBudget } = await import('../../worker/adapters/activenet/client');
      const { impl } = stubDetails({ 1: { age_description: '19 yrs +,', age_min_year: 19 } });
      const r = new ActivityAgeResolver(VANCOUVER, { budget: new RequestBudget('v', 0), fetchImpl: impl, ...NO_SLEEP });
      await expect(r.resolve(1)).rejects.toThrow(/budget|cap/i);
    });
  });
});

describe('normalizeHook — the source overrides our reading', () => {
  // WITHOUT THIS THE WHOLE BLOCK IS VACUOUS. normalizeHook returns early unless
  // isLiveFetchEnabled(), which reads this allow-list — unset in the test env, so every
  // assertion below would pass by never running. Found by checking, not by assuming.
  const ALLOW = 'KIDS_FUN_LIVE_ACTIVENET';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[ALLOW];
    process.env[ALLOW] = 'vancouver';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[ALLOW];
    else process.env[ALLOW] = previous;
  });

  it('the guard above is doing its job (this block is not silently skipped)', () => {
    expect(new ActiveNetAdapter(VANCOUVER).isLiveFetchEnabled()).toBe(true);
  });

  const record = (title: string, description: string, id: number, ageText?: string): StructuredRecord =>
    ({ sourceRecordId: `${id}:x`, title, ageText, raw: { title, description, event_item_id: id } }) as StructuredRecord;

  async function hook(table: Record<number, Record<string, unknown> | null>, rec: StructuredRecord) {
    const { calls, impl } = stubDetails(table);
    const adapter = new ActiveNetAdapter(VANCOUVER, { fetchImpl: impl, ...NO_SLEEP });
    return { out: await adapter.normalizeHook(rec), calls };
  }

  it('replaces a title-attributed all-ages claim with the real 55+ bound (Ukulele)', async () => {
    const { out } = await hook(
      { 700: { age_description: 'Age at least 55 yrs but less than 99y 11m,', age_min_year: 55, age_max_year: 99, age_max_month: 11 } },
      record('Ukulele - Jam Circle (All ages)', '', 700, 'Ukulele - Jam Circle (All ages)')
    );
    expect(out.ageBounds).toEqual({ minMonths: 660, maxMonths: null, notes: undefined });
  });

  it('restores |Public Skate| — all-ages, now attributable to the source', async () => {
    const { out } = await hook(
      { 800: { age_description: 'All ages,', age_min_year: 0, age_max_year: 0 } },
      record('|Public Skate|', '<p>Open skate for all ages</p>', 800)
    );
    expect(out.ageBounds).toEqual({ minMonths: 0, maxMonths: null, notes: 'all-ages' });
  });

  it('gives the 19+ karate class its real floor instead of nothing', async () => {
    const { out } = await hook(
      { 622061: { age_description: '19 yrs +,', age_min_year: 19, age_max_year: 0 } },
      record('Karate - Ku Yu Kai Go-Ju Ryu (Adults)', '<p>teaches classes for all ages and levels</p>', 622061)
    );
    expect(out.ageBounds).toEqual({ minMonths: 228, maxMonths: null, notes: undefined });
  });

  it('spends nothing when no all-ages claim is in play', async () => {
    const { out, calls } = await hook({}, record('Bootcamp Circuits', '<p>Bring your own mat.</p>', 1));
    expect(calls).toEqual([]);
    expect(out.ageBounds).toBeUndefined();
  });

  it('a FATAL portal error does not fail the ingest run, and stops further asking', async () => {
    // Opposite policy to the backfill runner, deliberately: an ingest run must not lose a
    // municipality's drop-in listings over an age verification, so it degrades to silence.
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response('blocked', { status: 403 });
    }) as unknown as typeof fetch;
    const adapter = new ActiveNetAdapter(VANCOUVER, { fetchImpl: impl, ...NO_SLEEP });
    const first = await adapter.normalizeHook(record('|Public Skate|', '<p>all ages</p>', 900));
    expect(first.ageBounds).toBeUndefined();
    // and it does not keep hammering a portal that just refused
    const second = await adapter.normalizeHook(record('|Public Skate|', '<p>all ages</p>', 901));
    expect(second.ageBounds).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('a failed lookup leaves the record exactly as parsed — never upgrades it', async () => {
    const { out } = await hook({}, record('|Public Skate|', '<p>Open skate for all ages</p>', 404));
    expect(out.ageBounds).toBeUndefined();
  });
});

describe('resolveRecordAge — authority ordering (no database needed)', () => {
  it('the source\'s own numbers beat our reading of its prose', () => {
    // The exact shape that caused the incident: prose says "all ages", the field says 19+.
    expect(
      resolveRecordAge({
        ageBounds: { minMonths: 228, maxMonths: null },
        ageText: 'all ages',
      })
    ).toEqual({ ageMinMonths: 228, ageMaxMonths: null, resolved: true, notes: undefined });
  });

  it('the source\'s own numbers beat its own tag taxonomy too', () => {
    expect(
      resolveRecordAge({
        ageBounds: { minMonths: 0, maxMonths: 72, notes: undefined },
        ageAudienceLabels: ['Adults'],
      })
    ).toMatchObject({ ageMinMonths: 0, ageMaxMonths: 72, resolved: true });
  });

  it('carries an attributable all-ages note through unchanged', () => {
    expect(resolveRecordAge({ ageBounds: { minMonths: 0, maxMonths: null, notes: 'all-ages' } })).toEqual({
      ageMinMonths: 0,
      ageMaxMonths: null,
      resolved: true,
      notes: 'all-ages',
    });
  });

  it('falls back to tags, then to prose, then to no claim', () => {
    expect(resolveRecordAge({ ageAudienceLabels: ['Toddlers'] })).toMatchObject({ resolved: true });
    expect(resolveRecordAge({ ageText: 'ages 5-7' })).toMatchObject({ ageMinMonths: 60, ageMaxMonths: 96 });
    expect(resolveRecordAge({})).toBeNull();
  });
});
