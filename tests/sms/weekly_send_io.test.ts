// tests/sms/weekly_send_io.test.ts — sendWeeklySmsForSubscriber's own behaviour.
//
// THIS FUNCTION HAD ALMOST NO DIRECT COVERAGE. It was mocked wholesale by
// tests/sms/weekly_run_route.test.ts and touched once, obliquely, by the round-17 cross-path test.
// A QA pass had to write its own ad-hoc probe to reach it at all. Its branch wiring — which
// send_type goes with which outcome, what a write failure does to the reported status, what
// reaches the error string — is what this file covers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadRecentlySent,
  loadSeriesIdsForOccurrences,
  sendWeeklySmsForSubscriber,
  type RecentlySent,
  type WeeklySmsDeps,
} from '@/lib/sms/weekly-send-io';
import type { SmsSubscriber } from '@/lib/sms/weekly-send';
import type { RecordSendInput } from '@/lib/sms/send-log';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { ListingRecord } from '@/lib/search/types';

const NOW = new Date('2026-08-28T23:00:00Z'); // Friday
const PHONE = '+16045550123';

const SUBSCRIBER: SmsSubscriber = {
  id: 'sub-1',
  shortRef: 42,
  postalCode: 'V5L 1A1',
  birthYears: [2021],
  categoryInterests: [],
  consecutiveEmptyWeeks: 0,
  preferencesToken: '8fJ2q',
  consentTextVersion: '2026-08-26.v2',
};

/** An empty catalogue: every send is an empty week, which is enough to exercise the wiring. */
const DEPS: WeeklySmsDeps = {
  engine: new SearchEngine({
    repository: new InMemoryListingRepository([]),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
    fixtureBacked: true,
  }),
  occurrenceShortRefs: new Map(),
};

function withSecret() {
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
}

/** All four seams wired, each recording what it saw. */
function wired(over: Parameters<typeof sendWeeklySmsForSubscriber>[2] = {}) {
  const logged: RecordSendInput[] = [];
  const stopped: string[] = [];
  const states: string[] = [];
  const options = {
    now: NOW,
    dryRun: false,
    deps: DEPS,
    dispatch: async () => ({ outcome: 'sent' as const, twilioSid: 'SM1', errorCode: null }),
    record: async (input: RecordSendInput) => {
      logged.push(input);
    },
    markStopped: async (id: string) => {
      stopped.push(id);
    },
    applyState: async (id: string) => {
      states.push(id);
    },
    // P6: active, confirmed, at the number under test — so these tests exercise what follows the
    // consent assertion. The assertion's own cases are in weekly_send_consent.test.ts.
    loadConsent: async () => ({ status: 'active' as const, confirmedTimestamp: NOW, phoneNumber: PHONE }),
    ...over,
  };
  return { logged, stopped, states, options };
}

const THROWS = (message: string) => async () => {
  throw new Error(message);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// An audit-write failure must not rewrite what happened to the subscriber
// ─────────────────────────────────────────────────────────────────────────────

describe('a failing post-dispatch write', () => {
  it('does NOT turn a real send into an error', async () => {
    // The message went. A failure to write the row that says so is our bookkeeping problem, and
    // reporting `error` would discard the one fact that matters — that the subscriber was texted.
    withSecret();
    const { states, options } = wired({ record: THROWS('duplicate key value violates unique constraint') });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);

    expect(result.status).toBe('empty'); // the TRUE outcome for an empty catalogue
    expect(result.error).toBeUndefined();
    // And the following write still ran — one failure must not skip the next step.
    expect(states).toEqual(['sub-1']);
  });

  it('does NOT turn a detected carrier opt-out into an error', async () => {
    withSecret();
    const { stopped, options } = wired({
      dispatch: async () => ({ outcome: 'stopped_via_carrier' as const, twilioSid: null, errorCode: 21610 }),
      record: THROWS('deadlock detected'),
    });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);

    expect(result.status).toBe('stopped_via_carrier');
    expect(result.error).toBeUndefined();
    expect(stopped).toEqual(['sub-1']); // the state change still happened
  });

  it('does not lose the send when the STATE write is the one that fails', async () => {
    withSecret();
    const { logged, options } = wired({ applyState: THROWS('could not serialize access') });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('empty');
    expect(result.error).toBeUndefined();
    expect(logged).toHaveLength(1);
  });

  it('does not lose the opt-out when markStopped is the one that fails', async () => {
    withSecret();
    const { logged, options } = wired({
      dispatch: async () => ({ outcome: 'stopped_via_carrier' as const, twilioSid: null, errorCode: 21610 }),
      markStopped: THROWS('connection terminated'),
    });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('stopped_via_carrier');
    // The 21610 is still in the audit trail even though the state write failed.
    expect(logged[0].outcome).toBe('stopped_via_carrier');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nothing a write throws may reach the HTTP response
// ─────────────────────────────────────────────────────────────────────────────

describe('a write failure never leaks', () => {
  it('puts no phone number and no driver text in the result', async () => {
    // app/api/sms/weekly/run/route.ts passes `r.error` through to the response unfiltered, and a
    // constraint-violation message commonly echoes the offending row's values back. These three
    // writes are the only calls in the function that hand a phone number to a database.
    withSecret();
    const leaky = `duplicate key value violates unique constraint "sms_send_log_pkey" DETAIL: Key (phone)=(${PHONE}) already exists.`;
    for (const over of [
      { record: THROWS(leaky) },
      { markStopped: THROWS(leaky), dispatch: async () => ({ outcome: 'stopped_via_carrier' as const, twilioSid: null, errorCode: 21610 }) },
      { applyState: THROWS(leaky) },
    ]) {
      const { options } = wired(over);
      const serialized = JSON.stringify(await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options));
      expect(serialized).not.toContain('6045550123');
      expect(serialized).not.toContain('duplicate key');
      expect(serialized).not.toContain('DETAIL');
    }
  });

  it('redacts the number as a BACKSTOP if one ever reaches the outer catch', async () => {
    // Nothing that holds the number can land there any more — that is what wrapping the writes
    // achieved. This pins the second barrier for the case where that reasoning is wrong: the
    // deps load is the one remaining thrower, so it stands in for "something unexpected threw".
    withSecret();
    const { options } = wired({
      deps: undefined,
      // loadWeeklySmsDeps will be called and will fail without a database.
    });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('6045550123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The branch wiring itself
// ─────────────────────────────────────────────────────────────────────────────

describe('branch wiring', () => {
  it('an empty catalogue sends the empty-week text and advances the counter', async () => {
    withSecret();
    const { logged, states, options } = wired();
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('empty');
    expect(logged[0].sendType).toBe('empty_week');
    expect(logged[0].outcome).toBe('empty');
    expect(logged[0].picksSnapshot).toBeNull(); // 0035's CHECK: weekly sends only
    expect(states).toEqual(['sub-1']);
  });

  it('the THIRD empty week sends the pause notice instead, and reports paused', async () => {
    withSecret();
    const { logged, options } = wired();
    const result = await sendWeeklySmsForSubscriber(
      { ...SUBSCRIBER, consecutiveEmptyWeeks: 2 },
      PHONE,
      options
    );
    expect(result.status).toBe('paused');
    expect(logged[0].sendType).toBe('pause_notice');
    expect(logged[0].outcome).toBe('paused');
  });

  it('a dry run writes nothing at all', async () => {
    withSecret();
    const { logged, stopped, states, options } = wired({ dryRun: true, dispatch: async () => ({ outcome: 'dry_run' as const, twilioSid: null, errorCode: null }) });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('dry_run');
    expect([logged, stopped, states]).toEqual([[], [], []]);
  });

  it('a failed dispatch logs the attempt but does NOT advance the counter', async () => {
    // Otherwise a Twilio outage would pause subscribers three weeks later.
    withSecret();
    const { logged, states, options } = wired({
      dispatch: async () => ({ outcome: 'failed' as const, twilioSid: null, errorCode: 30001, error: 'boom' }),
    });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('error');
    expect(logged[0].outcome).toBe('failed');
    expect(states).toEqual([]);
  });

  it('an out-of-area postal code sends nothing and changes nothing', async () => {
    withSecret();
    const { logged, states, options } = wired();
    const result = await sendWeeklySmsForSubscriber(
      { ...SUBSCRIBER, postalCode: 'M5V 1A1' }, // Toronto
      PHONE,
      options
    );
    expect(result.status).toBe('skipped_geocode_failed');
    expect([logged, states]).toEqual([[], []]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — the novelty window: occurrence ids AND their series, and how each read fails
// ─────────────────────────────────────────────────────────────────────────────

const SENT_A = '11111111-1111-4111-8111-111111111111';
const SENT_B = '22222222-2222-4222-8222-222222222222';

describe('loadRecentlySent — composing the two reads', () => {
  it('resolves series for exactly the occurrence ids the snapshot held', async () => {
    const seen: string[][] = [];
    const recent = await loadRecentlySent('sub-1', {
      loadPickIds: async () => new Set([SENT_A, SENT_B]),
      resolveSeries: async (ids) => {
        seen.push([...ids]);
        return new Set(['series-a', 'series-b']);
      },
    });
    expect(seen).toEqual([[SENT_A, SENT_B]]);
    expect(recent).toEqual({
      occurrenceIds: new Set([SENT_A, SENT_B]),
      seriesIds: new Set(['series-a', 'series-b']),
      seriesResolved: true,
    });
  });

  it('a failed SERIES read keeps the occurrence ids — degrades to the pre-D5 filter, never to none', async () => {
    const recent = await loadRecentlySent('sub-1', {
      loadPickIds: async () => new Set([SENT_A]),
      resolveSeries: THROWS('connection terminated unexpectedly'),
    });
    expect(recent.occurrenceIds).toEqual(new Set([SENT_A]));
    expect(recent.seriesIds).toEqual(new Set());
    expect(recent.seriesResolved).toBe(false);
  });

  it('a failed SNAPSHOT read throws through — the caller owns "no novelty this week"', async () => {
    await expect(
      loadRecentlySent('sub-1', { loadPickIds: THROWS('relation does not exist'), resolveSeries: async () => new Set() })
    ).rejects.toThrow('relation does not exist');
  });
});

describe('loadSeriesIdsForOccurrences — the uuid guard', () => {
  it('sends NO query when nothing is uuid-shaped (this lane has no database, so a query would throw)', async () => {
    expect(await loadSeriesIdsForOccurrences([])).toEqual(new Set());
    expect(await loadSeriesIdsForOccurrences(['not-a-uuid', 'occ-7', ''])).toEqual(new Set());
  });
});

describe('sendWeeklySmsForSubscriber — the series arm reaches the text', () => {
  // A real catalogue this time (the file's DEPS is empty), placed in the subscriber's FSA.
  const HOME = fsaGeocoder.geocodePostal(SUBSCRIBER.postalCode)!;
  const at = (hour: number) => `2026-08-29T${String(hour + 7).padStart(2, '0')}:00:00Z`;
  const NAMES = ['Splash Time', 'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers'];
  const listings: ListingRecord[] = NAMES.map((name, i) =>
    makeListing({
      id: `occ-${i}`,
      activityName: name,
      venueName: `${name} Centre`,
      statusState: 'confirmed',
      ageMinMonths: 24,
      ageMaxMonths: 120,
      ageBandMatches: ['2-4', '5-9'],
      geo: { lat: HOME.lat + i * 0.002, lng: HOME.lng },
      startDatetimeUtc: at(9 + i),
      endDatetimeUtc: at(10 + i),
      primaryCategoryKey: 'general',
    })
  );
  const CATALOGUE: WeeklySmsDeps = {
    engine: new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
      regionHierarchy: new RegionHierarchy(REGIONS),
      geocoder: fsaGeocoder,
      fixtureBacked: true,
    }),
    occurrenceShortRefs: new Map(listings.map((l, i) => [l.id, 1000 + i])),
  };
  const recentWith = (over: Partial<RecentlySent>) => async (): Promise<RecentlySent> => ({
    occurrenceIds: new Set(['occ-0-last-week']),
    seriesIds: new Set(['occ-0-series']),
    seriesResolved: true,
    ...over,
  });

  it("excludes this week's sitting of last week's series, and reports no degradation", async () => {
    withSecret();
    const { logged, options } = wired({ deps: CATALOGUE, loadRecentlySent: recentWith({}) });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('sent');
    expect(result.pickCount).toBe(5);
    expect(result.novelExcluded).toBe(1);
    expect(result.noveltyDegraded).toBeUndefined();
    expect(logged[0].picksSnapshot!.map((p) => p.occurrence_id)).not.toContain('occ-0');
  });

  it("reports 'occurrence_only' when the series read failed — and still sends the week", async () => {
    withSecret();
    const { options } = wired({
      deps: CATALOGUE,
      loadRecentlySent: recentWith({ seriesIds: new Set(), seriesResolved: false }),
    });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('sent');
    expect(result.pickCount).toBe(6); // the series arm was unavailable, so occ-0 is back
    expect(result.noveltyDegraded).toBe('occurrence_only');
  });

  it("reports 'unavailable' when the history could not be read at all — and still sends the week", async () => {
    withSecret();
    const { options } = wired({ deps: CATALOGUE, loadRecentlySent: THROWS('pool exhausted') });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('sent');
    expect(result.pickCount).toBe(6);
    expect(result.noveltyDegraded).toBe('unavailable');
    expect(result.error).toBeUndefined();
  });
});
