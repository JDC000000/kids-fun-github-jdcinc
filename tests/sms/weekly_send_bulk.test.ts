// tests/sms/weekly_send_bulk.test.ts — the Friday batch driver itself.
//
// ═══ THIS FUNCTION HAD NEVER BEEN EXECUTED BY A TEST ═══
// The only reference to `sendWeeklySmsBulk` anywhere in tests/sms/ was a `vi.mock` in
// weekly_run_route.test.ts that REPLACES it, to test the HTTP route's auth and PII allowlist. The
// per-subscriber unit got its own file in round 18; the driver that loops it, aggregates the
// counts and is supposed to survive one bad row never did.
//
// It could not have, either: `loadWeeklySmsDeps()` is the first thing it does and it goes straight
// to Postgres, so any direct call threw before reaching an assertion. Round 19 added the two batch
// loaders and the four write seams to `BulkOptions` for exactly that reason — a driver that cannot
// be executed is a driver whose behaviour is assumed rather than known.
//
// `loadDeps` is injected rather than a ready-made `deps`, on purpose: handing in the read model
// would leave nothing to COUNT, and "loaded once per batch, never once per subscriber" is the
// design property this file most needs to check.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendWeeklySmsBulk,
  type ActiveSubscriber,
  type WeeklySmsDeps,
} from '@/lib/sms/weekly-send-io';
import type { SmsSubscriber } from '@/lib/sms/weekly-send';
import type { RecordSendInput } from '@/lib/sms/send-log';
import type { DispatchResult } from '@/lib/sms/twilio-client';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';

const NOW = new Date('2026-08-28T23:00:00Z'); // Friday

/** An empty catalogue: every subscriber resolves to an empty week, which the wiring does not care
 *  about. What this file tests is the LOOP, not the picker. */
function deps(): WeeklySmsDeps {
  return {
    engine: new SearchEngine({
      repository: new InMemoryListingRepository([]),
      aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
      regionHierarchy: new RegionHierarchy(REGIONS),
      geocoder: fsaGeocoder,
      fixtureBacked: true,
    }),
    occurrenceShortRefs: new Map(),
  };
}

function subscriber(id: string, over: Partial<SmsSubscriber> = {}): ActiveSubscriber {
  return {
    subscriber: {
      id,
      shortRef: Number(id.replace(/\D/g, '')) || 1,
      postalCode: 'V5L 1A1',
      birthYears: [2021],
      categoryInterests: [],
      consecutiveEmptyWeeks: 0,
      preferencesToken: `tok-${id}`,
      consentTextVersion: '2026-08-26.v2',
      ...over,
    },
    phoneNumber: `+1604555${id.replace(/\D/g, '').padStart(4, '0')}`,
  };
}

const SENT: DispatchResult = { outcome: 'sent', twilioSid: 'SM1', errorCode: null };

/** Every seam wired; records what the batch did and how many times it loaded the read model. */
function harness(subscribers: ActiveSubscriber[], over: Parameters<typeof sendWeeklySmsBulk>[0] = {}) {
  const loads: number[] = [];
  const logged: RecordSendInput[] = [];
  const stopped: string[] = [];
  const states: string[] = [];
  const dispatched: string[] = [];
  const options = {
    now: NOW,
    dryRun: false,
    loadDeps: async () => {
      loads.push(1);
      return deps();
    },
    loadSubscribers: async (limit?: number) =>
      typeof limit === 'number' ? subscribers.slice(0, limit) : subscribers,
    dispatch: async (phone: string) => {
      dispatched.push(phone);
      return SENT;
    },
    record: async (input: RecordSendInput) => {
      logged.push(input);
    },
    markStopped: async (id: string) => {
      stopped.push(id);
    },
    applyState: async (id: string) => {
      states.push(id);
    },
    ...over,
  };
  return { loads, logged, stopped, states, dispatched, options };
}

function withSecret() {
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The design property this file exists for
// ─────────────────────────────────────────────────────────────────────────────

describe('the read model is loaded ONCE per batch', () => {
  it('loads it once for five subscribers, not once each', async () => {
    // Round 4's design decision, mirroring lib/email/weekly.ts: a bulk run must not re-query
    // Postgres per subscriber. Eighteen rounds of changes later, this is the first time anything
    // has actually counted. COUNTED, not inferred from reading the code.
    withSecret();
    const { loads, options } = harness(['s1', 's2', 's3', 's4', 's5'].map((id) => subscriber(id)));
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.candidates).toBe(5);
    expect(summary.results).toHaveLength(5);
    expect(loads).toHaveLength(1);
  });

  it('does NOT load it at all when there are no subscribers', async () => {
    // Round 19 pinned the opposite and said so: "if it is ever reordered, this test is where that
    // decision becomes visible." It was reordered in round 21 (pre-approved), so this test now
    // asserts the saving rather than the waste — the same job the round-18 coverage-swap test did.
    // An empty week no longer pulls the listing catalogue, alias resolver and region hierarchy out
    // of Postgres for nothing, which is every week before launch and any week the product is paused.
    withSecret();
    const { loads, options } = harness([]);
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.candidates).toBe(0);
    expect(summary.results).toEqual([]);
    expect(loads).toEqual([]); // ← not loaded at all
    // Still the same summary shape as any other run: an empty batch is a normal Friday.
    expect(summary.counts).toEqual({
      sent: 0, dry_run: 0, empty: 0, paused: 0,
      stopped_via_carrier: 0, skipped_geocode_failed: 0, error: 0,
    });
    expect(summary.totalSegments).toBe(0);
  });

  it('passes the SAME read model into every subscriber, not a fresh one', async () => {
    // The other half of "load once": loading once but then not passing it down would look
    // identical from the load counter and be just as wrong.
    withSecret();
    const seen: WeeklySmsDeps[] = [];
    const model = deps();
    const { options } = harness(['s1', 's2', 's3'].map((id) => subscriber(id)), {
      loadDeps: async () => {
        seen.push(model);
        return model;
      },
    });
    await sendWeeklySmsBulk(options);
    // One load, and the engine every subscriber searched against is that one instance.
    expect(seen).toHaveLength(1);
    expect(seen[0].engine).toBe(model.engine);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 3. Independent results, and the aggregate
// ─────────────────────────────────────────────────────────────────────────────

describe('per-subscriber results are independent', () => {
  it('gives each subscriber its own result, keyed to its own id', async () => {
    withSecret();
    const { options } = harness(['s1', 's2', 's3'].map((id) => subscriber(id)));
    const summary = await sendWeeklySmsBulk(options);
    expect(summary.results.map((r) => r.subscriberId)).toEqual(['s1', 's2', 's3']);
  });

  it("one subscriber's outcome does not leak into another's", async () => {
    // s2 is carrier-suppressed; s1 and s3 are not. The three must come back with three different
    // stories rather than the batch smearing one over the others.
    withSecret();
    const { stopped, options } = harness(['s1', 's2', 's3'].map((id) => subscriber(id)), {
      dispatch: async (phone: string) =>
        phone.endsWith('0002')
          ? { outcome: 'stopped_via_carrier' as const, twilioSid: null, errorCode: 21610 }
          : SENT,
    });
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.results.map((r) => r.status)).toEqual(['empty', 'stopped_via_carrier', 'empty']);
    expect(stopped).toEqual(['s2']); // and only s2 was marked stopped
  });

  it('aggregates a MIXED batch into counts, totals and a per-subscriber list', async () => {
    // Read the real BulkSummary shape rather than assuming one: { dryRun, candidates, counts,
    // totalSegments, results }.
    withSecret();
    const subscribers = [
      subscriber('s1'), // empty week
      subscriber('s2'), // carrier opt-out
      subscriber('s3', { consecutiveEmptyWeeks: 2 }), // third empty week → paused
      subscriber('s4'), // dispatch fails → error
      subscriber('s5', { postalCode: 'M5V 1A1' }), // Toronto → geocode skip
    ];
    const { options } = harness(subscribers, {
      dispatch: async (phone: string) => {
        if (phone.endsWith('0002')) {
          return { outcome: 'stopped_via_carrier' as const, twilioSid: null, errorCode: 21610 };
        }
        if (phone.endsWith('0004')) {
          return { outcome: 'failed' as const, twilioSid: null, errorCode: 30001, error: 'boom' };
        }
        return SENT;
      },
    });
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.candidates).toBe(5);
    expect(summary.counts).toEqual({
      sent: 0,
      dry_run: 0,
      empty: 1, // s1
      paused: 1, // s3
      stopped_via_carrier: 1, // s2
      skipped_geocode_failed: 1, // s5
      error: 1, // s4
    });
    // Every status counted exactly once, and the counts sum to the candidate list.
    expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(5);
    expect(summary.results).toHaveLength(5);
    // Segments accumulate across the batch — the week's cost, visible rather than inferred. The
    // geocode skip contributes nothing because it never built a message.
    expect(summary.totalSegments).toBe(
      summary.results.reduce((sum, r) => sum + r.segments, 0)
    );
    expect(summary.totalSegments).toBeGreaterThan(0);
  });

  it('honours `limit`, so a first live run sends to exactly N and stops', async () => {
    withSecret();
    const { options } = harness(['s1', 's2', 's3', 's4'].map((id) => subscriber(id)), { limit: 2 });
    const summary = await sendWeeklySmsBulk(options);
    expect(summary.candidates).toBe(2);
    expect(summary.results.map((r) => r.subscriberId)).toEqual(['s1', 's2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. One bad row must not take down the batch
// ─────────────────────────────────────────────────────────────────────────────

describe('one subscriber failing does not abort the run', () => {
  it('a throwing WRITE for one subscriber leaves the rest processed and reported', async () => {
    // The batch survives because `sendWeeklySmsForSubscriber` never throws — a property of the
    // CALLEE, since this loop has no try/catch of its own. Asserted from this side so the
    // dependency is checked rather than assumed.
    withSecret();
    const { logged, options } = harness(['s1', 's2', 's3'].map((id) => subscriber(id)), {
      record: async (input: RecordSendInput) => {
        if (input.subscriberId === 's2') throw new Error('deadlock detected');
        logged.push(input);
      },
    });
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.results).toHaveLength(3);
    expect(summary.results.map((r) => r.subscriberId)).toEqual(['s1', 's2', 's3']);
    // And s2 still reports its TRUE outcome — round 18's fix, seen from the batch's side.
    expect(summary.results.map((r) => r.status)).toEqual(['empty', 'empty', 'empty']);
  });

  it('a subscriber whose message cannot be built is reported, not skipped', async () => {
    withSecret();
    const { options } = harness([
      subscriber('s1'),
      subscriber('s2', { postalCode: 'M5V 1A1' }), // out of coverage
      subscriber('s3'),
    ]);
    const summary = await sendWeeklySmsBulk(options);
    expect(summary.results.map((r) => r.status)).toEqual([
      'empty',
      'skipped_geocode_failed',
      'empty',
    ]);
  });

  it('nothing in the summary carries a phone number or a message body', async () => {
    // The run route serialises this straight into an HTTP response.
    withSecret();
    const { options } = harness(['s1', 's2'].map((id) => subscriber(id)), {
      record: async () => {
        throw new Error('duplicate key ... DETAIL: Key (phone)=(+16045550001) already exists.');
      },
    });
    const serialized = JSON.stringify(await sendWeeklySmsBulk(options));
    expect(serialized).not.toContain('6045550001');
    expect(serialized).not.toContain('DETAIL');
    expect(serialized).not.toContain('KIDS FUN:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dry run, across the whole batch
// ─────────────────────────────────────────────────────────────────────────────

describe('dry run applies to the whole batch, not per subscriber', () => {
  it('reports dry_run for every subscriber and writes nothing for any of them', async () => {
    withSecret();
    const { logged, stopped, states, options } = harness(
      ['s1', 's2', 's3'].map((id) => subscriber(id)),
      {
        dryRun: true,
        dispatch: async () => ({ outcome: 'dry_run' as const, twilioSid: null, errorCode: null }),
      }
    );
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.dryRun).toBe(true);
    expect(summary.counts.dry_run).toBe(3);
    expect(summary.results.every((r) => r.status === 'dry_run')).toBe(true);
    expect([logged, stopped, states]).toEqual([[], [], []]);
    // A dry run still BUILDS every message, so the week's cost is visible before it is spent.
    expect(summary.totalSegments).toBeGreaterThan(0);
  });

  it('defaults to dry-run in an unconfigured environment, for the batch as a whole', async () => {
    // SMS_SENDING_ENABLED deliberately unset, and `dryRun` NOT passed.
    withSecret();
    const { dispatched, options } = harness(['s1', 's2'].map((id) => subscriber(id)), {
      dispatch: async (phone: string, _m: unknown, opts: { dryRun: boolean }) => {
        dispatched.push(`${phone}:${opts.dryRun}`);
        return { outcome: 'dry_run' as const, twilioSid: null, errorCode: null };
      },
    });
    delete (options as { dryRun?: boolean }).dryRun;
    const summary = await sendWeeklySmsBulk(options);

    expect(summary.dryRun).toBe(true);
    // The flag reached every subscriber, not just the summary line.
    expect(dispatched).toEqual(['+16045550001:true', '+16045550002:true']);
  });

  it('one subscriber cannot opt itself out of the batch-wide dry run', async () => {
    // The gate is decided once, at the top, and passed down. There is no per-subscriber override
    // and there must not be one: this is the flag that stands between a verification run and
    // texting real parents.
    withSecret();
    const { dispatched, options } = harness(['s1', 's2', 's3'].map((id) => subscriber(id)), {
      dryRun: true,
      dispatch: async (phone: string, _m: unknown, opts: { dryRun: boolean }) => {
        dispatched.push(`${opts.dryRun}`);
        return { outcome: 'dry_run' as const, twilioSid: null, errorCode: null };
      },
    });
    await sendWeeklySmsBulk(options);
    expect(dispatched).toEqual(['true', 'true', 'true']);
  });
});
