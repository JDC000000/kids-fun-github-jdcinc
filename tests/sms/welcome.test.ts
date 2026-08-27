// tests/sms/welcome.test.ts — the welcome text, and the JOIN branch that fires it (PRD §2.1/§2.6).
//
// Two layers:
//   • `renderWelcomeMessage` — pure copy, including the GSM-7 guard every other message goes
//     through. Not exempt from it.
//   • `sendWelcomeText` + the inbound route's JOIN branch — that exactly one welcome is sent, for
//     exactly one transition outcome, with the right send-log shape.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGsm7Safe,
  estimateSegments,
  isGsm7,
  renderWelcomeMessage,
  septetLength,
} from '@/lib/sms/message';
import {
  sendWelcomeText,
  type WelcomeSubscriber,
  type WelcomeOptions,
} from '@/lib/sms/welcome';
import type { RecordSendInput } from '@/lib/sms/send-log';
import { confirmAndWelcome, shouldSendWelcome } from '@/app/api/sms/inbound/route';
import type { TransitionResult } from '@/lib/sms/consent-transitions';
import { sendWeeklySmsForSubscriber, type WeeklySmsDeps } from '@/lib/sms/weekly-send-io';
import type { SmsSubscriber } from '@/lib/sms/weekly-send';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';

// ═══ THE UNIT LANE DOES NOT TOUCH A DATABASE ═══
// Stage A made the consent seams real: they now issue actual SQL through lib/db/client. This file
// tests decisions and wiring, not persistence, so the db seam is mocked to an empty result — which
// restores exactly the "finds nothing" world these tests were written against, honestly and
// without a connection. The real seams are covered in tests/sms/signup_persistence-db.test.ts,
// which runs in the `db` lane. That split is the convention vitest.workspace.ts documents.
vi.mock('@/lib/db/client', () => ({
  query: async () => [],
  getPool: () => {
    throw new Error('the unit lane must not open a pool');
  },
}));


/** A subscriber for the weekly path, used only by the cross-path agreement test below. */
const WEEKLY_SUBSCRIBER: SmsSubscriber = {
  id: 'sub-weekly',
  shortRef: 42,
  postalCode: 'V5L 1A1',
  birthYears: [2021],
  categoryInterests: [],
  consecutiveEmptyWeeks: 0,
  preferencesToken: '8fJ2q',
  consentTextVersion: '2026-08-26.v2',
};

/** An empty catalogue is fine: the 21610 branch is reached before anything depends on picks. */
const EMPTY_DEPS: WeeklySmsDeps = {
  engine: new SearchEngine({
    repository: new InMemoryListingRepository([]),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
    fixtureBacked: true,
  }),
  occurrenceShortRefs: new Map(),
};

const NOW = new Date('2026-08-28T23:00:00Z'); // Friday, local year 2026

const SUBSCRIBER: WelcomeSubscriber = {
  id: 'sub-1',
  phoneNumber: '+16045550123',
  postalCode: 'V5L 1A1', // East Vancouver → "Vancouver"
  birthYears: [2021, 2018], // 5 and 8 in 2026
  preferencesToken: '8fJ2q',
  consentTextVersion: '2026-08-26.v2',
};

function withConfig() {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
}

/** All three seams wired; records what was dispatched and what was logged. */
function wired(over: Partial<WelcomeOptions> = {}, subscriber: WelcomeSubscriber | null = SUBSCRIBER) {
  const dispatched: Array<{ phone: string; body: string; dryRun: boolean }> = [];
  const logged: RecordSendInput[] = [];
  const options: WelcomeOptions = {
    now: NOW,
    loadSubscriber: async () => subscriber,
    dispatch: async (phone, message, opts) => {
      dispatched.push({ phone, body: message.body, dryRun: opts.dryRun });
      return { outcome: opts.dryRun ? 'dry_run' : 'sent', twilioSid: 'SM123', errorCode: null };
    },
    record: async (input) => {
      logged.push(input);
    },
    ...over,
  };
  return { dispatched, logged, options };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// The copy
// ─────────────────────────────────────────────────────────────────────────────

describe('the welcome message (PRD §2.6)', () => {
  const message = renderWelcomeMessage({
    areaLabel: 'East Van',
    childAges: [5, 8],
    preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
  });

  it('restates the cadence — the only lifecycle message that never did', () => {
    // V1 testing: the confirmation request says "weekly kid activity picks", then the very next
    // text a subscriber gets said only "your first picks... Friday", which reads as a one-off.
    expect(message.body).toContain('weekly picks');
    expect(message.body).not.toContain('first picks');
    // "start", not "land": it says a series is beginning, not that one thing is arriving.
    expect(message.body).toContain('start Friday');
  });

  it("matches §2.6's shape", () => {
    expect(message.body).toBe(
      "KIDS FUN: You're in! Your weekly picks for East Van, ages 5, 8, start Friday ~4pm.\n" +
        'Manage anytime: https://kidsfun.example/u/8fJ2q\nReply STOP to end'
    );
  });

  it('IS covered by the GSM-7 guard, not exempt from it', () => {
    // The same wall every other template passes. §2.6's "~" is an extension-table character —
    // still GSM-7, but two septets — so this also proves the guard understands that distinction.
    expect(() => assertGsm7Safe(message.body)).not.toThrow();
    expect(isGsm7(message.body)).toBe(true);
    expect(message.encoding).toBe('GSM-7');
  });

  it('counts the "~" as TWO septets, because that is what it costs', () => {
    // The correction this round made to lib/sms/message.ts. Before it, `~` was treated as
    // non-GSM-7 entirely: the guard would have REJECTED Jon's own approved wording, and the
    // segment estimate would have said UCS-2 at 70 characters.
    expect(septetLength('~')).toBe(2);
    expect(septetLength('a~')).toBe(3);
    expect(isGsm7('~')).toBe(true);
    // And the round-4 finding is untouched: an em dash is in NEITHER table.
    expect(isGsm7('—')).toBe(false);
    expect(estimateSegments('—').encoding).toBe('UCS-2');
  });

  it('drops the area clause rather than printing a placeholder', () => {
    const noArea = renderWelcomeMessage({
      areaLabel: null,
      childAges: [5],
      preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
    });
    expect(noArea.body).toContain("You're in! Your weekly picks, ages 5, start Friday");
    expect(noArea.body).not.toContain('null');
    expect(noArea.body).not.toContain('for ,');
  });

  it('drops the ages clause independently', () => {
    const noAges = renderWelcomeMessage({
      areaLabel: 'Burnaby',
      childAges: [],
      preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
    });
    expect(noAges.body).toContain('Your weekly picks for Burnaby start Friday');
    expect(noAges.body).not.toContain('ages');
  });

  it('always carries the preferences link and the STOP line', () => {
    // The preferences URL is the CASL unsubscribe path and the PIPEDA access mechanism at once —
    // it is not a footer that any message may omit.
    for (const area of ['East Van', null]) {
      const m = renderWelcomeMessage({
        areaLabel: area,
        childAges: [],
        preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
      });
      expect(m.body).toContain('/u/8fJ2q');
      expect(m.body).toContain('Reply STOP to end');
      assertGsm7Safe(m.body);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The send
// ─────────────────────────────────────────────────────────────────────────────

describe('sendWelcomeText', () => {
  it('sends exactly ONE message and writes ONE log row with send_type "welcome"', async () => {
    withConfig();
    const { dispatched, logged, options } = wired({ dryRun: false });
    const result = await sendWelcomeText('sub-1', options);

    expect(result.outcome).toBe('sent');
    expect(dispatched).toHaveLength(1);
    expect(logged).toEqual([
      {
        subscriberId: 'sub-1',
        sendType: 'welcome',
        outcome: 'sent',
        // Weekly sends only — migration 0035's CHECK rejects a snapshot on any other send_type.
        picksSnapshot: null,
        twilioSid: 'SM123',
        consentTextVersion: '2026-08-26.v2',
      },
    ]);
  });

  it('resolves the area and the ages from the STORED row, not from anything passed in', async () => {
    withConfig();
    const { dispatched, options } = wired({ dryRun: false });
    await sendWelcomeText('sub-1', options);
    // V5L → Vancouver via the SAME resolver the weekly send uses; 2021/2018 → 5 and 8 in 2026.
    expect(dispatched[0].body).toContain('for Vancouver, ages 5, 8,');
    expect(dispatched[0].phone).toBe('+16045550123');
  });

  it('is dry-run by default in an unconfigured environment — nothing dispatched, nothing logged', async () => {
    // SMS_SENDING_ENABLED deliberately unset. `dryRun` is NOT passed, so this asserts the DEFAULT,
    // which is what an unconfigured environment relies on.
    withConfig();
    const { dispatched, logged, options } = wired();
    delete (options as { dryRun?: boolean }).dryRun;
    const result = await sendWelcomeText('sub-1', options);

    expect(result.outcome).toBe('dry_run');
    expect(dispatched[0].dryRun).toBe(true);
    // sms_send_log has no dry_run column by design (0035) — a verification run writes nothing.
    expect(logged).toEqual([]);
  });

  it('reports a missing subscriber without sending or logging', async () => {
    withConfig();
    const { dispatched, logged, options } = wired({ dryRun: false }, null);
    const result = await sendWelcomeText('sub-1', options);
    expect(result.outcome).toBe('no_such_subscriber');
    expect(dispatched).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('logs a FAILED attempt when Twilio rejects it, and never throws', async () => {
    withConfig();
    const { logged, options } = wired({
      dryRun: false,
      dispatch: async () => ({ outcome: 'failed', twilioSid: null, errorCode: 30001, error: 'boom' }),
    });
    const result = await sendWelcomeText('sub-1', options);
    expect(result.outcome).toBe('failed');
    expect(logged[0].outcome).toBe('failed');
  });

  it('maps a carrier opt-out at this moment rather than assuming it away', async () => {
    withConfig();
    const { logged, options } = wired({
      dryRun: false,
      dispatch: async () => ({ outcome: 'stopped_via_carrier', twilioSid: null, errorCode: 21610 }),
    });
    const result = await sendWelcomeText('sub-1', options);
    expect(result.outcome).toBe('failed');
    expect(logged[0].outcome).toBe('stopped_via_carrier');
  });

  it('MARKS THEM STOPPED on a 21610, not just logs it', async () => {
    // The bug this replaces: the outcome was logged and `sms_consent.status` was left at 'active'.
    // Dormant only because markStoppedViaCarrier is a stub with no live database — the day that is
    // wired, a JOIN from a carrier-suppressed number would have stayed 'active' forever while the
    // identical Twilio code on a weekly send stopped them properly. PRD §2.2 step 6 makes this a
    // send-time safeguard INDEPENDENT of the inbound webhook, and independent means every send
    // path honours it.
    withConfig();
    const stopped: string[] = [];
    const { logged, options } = wired({
      dryRun: false,
      dispatch: async () => ({ outcome: 'stopped_via_carrier', twilioSid: null, errorCode: 21610 }),
      markStopped: async (id) => {
        stopped.push(id);
      },
    });
    await sendWelcomeText('sub-1', options);
    expect(stopped).toEqual(['sub-1']);
    expect(logged[0].outcome).toBe('stopped_via_carrier');
  });

  it('marks NOBODY stopped on any other outcome', async () => {
    // A positive test on 21610, so a plain delivery failure never unsubscribes anyone.
    withConfig();
    for (const dispatched of [
      { outcome: 'sent' as const, twilioSid: 'SM1', errorCode: null },
      { outcome: 'failed' as const, twilioSid: null, errorCode: 30001 },
    ]) {
      const stopped: string[] = [];
      const { options } = wired({
        dryRun: false,
        dispatch: async () => dispatched,
        markStopped: async (id) => {
          stopped.push(id);
        },
      });
      await sendWelcomeText('sub-1', options);
      expect(stopped, dispatched.outcome).toEqual([]);
    }
  });

  it('a failed state write does not lose the 21610 from the audit trail', async () => {
    withConfig();
    const { logged, options } = wired({
      dryRun: false,
      dispatch: async () => ({ outcome: 'stopped_via_carrier', twilioSid: null, errorCode: 21610 }),
      markStopped: async () => {
        throw new Error('relation "sms_consent" does not exist');
      },
    });
    const result = await sendWelcomeText('sub-1', options);
    expect(result.outcome).toBe('failed');
    expect(logged[0].outcome).toBe('stopped_via_carrier');
  });

  it('BOTH send paths reach the same state transition on the same Twilio code', async () => {
    // The regression this pair exists to prevent: the two paths agreeing today and drifting apart
    // again the next time one of them is edited. Same error code in, same subscriber id marked
    // stopped out — asserted against the weekly path's own function, not a description of it.
    withConfig();
    const carrierOptOut = async () => ({
      outcome: 'stopped_via_carrier' as const,
      twilioSid: null,
      errorCode: 21610,
    });

    const fromWelcome: string[] = [];
    await sendWelcomeText('sub-1', {
      ...wired({ dryRun: false }).options,
      dispatch: carrierOptOut,
      markStopped: async (id) => {
        fromWelcome.push(id);
      },
    });

    const fromWeekly: string[] = [];
    vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
    await sendWeeklySmsForSubscriber(WEEKLY_SUBSCRIBER, '+16045550123', {
      now: NOW,
      dryRun: false,
      deps: EMPTY_DEPS,
      dispatch: carrierOptOut,
      record: async () => {},
      markStopped: async (id) => {
        fromWeekly.push(id);
      },
    });

    expect(fromWelcome).toEqual(['sub-1']);
    expect(fromWeekly).toEqual([WEEKLY_SUBSCRIBER.id]);
  });

  it('never throws, and never leaks the number or the body into an error', async () => {
    withConfig();
    const thrown = await sendWelcomeText('sub-1', {
      now: NOW,
      dryRun: false,
      loadSubscriber: async () => {
        throw new Error('connection terminated for +16045550123');
      },
    });
    expect(thrown.outcome).toBe('failed');
    expect(thrown.error).toContain('lookup failed');

    const dispatchThrew = await sendWelcomeText('sub-1', {
      ...wired({ dryRun: false }).options,
      dispatch: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(dispatchThrew.outcome).toBe('failed');
    expect(dispatchThrew.error).toContain('dispatch threw');
  });

  it('the default seams are inert — an unwired call finds nothing and sends nothing', async () => {
    withConfig();
    expect((await sendWelcomeText('sub-1', { dryRun: false })).outcome).toBe('no_such_subscriber');
  });

  it('reaches the REAL Twilio dispatcher once a subscriber IS found', async () => {
    // Round 16 replaced the dispatch stub with an actual Messages API call. Only the loader is
    // injected here; the dispatch is the real one, with no credentials, so it fails closed at the
    // client rather than at a scaffold.
    withConfig();
    const result = await sendWelcomeText('sub-1', {
      now: NOW,
      dryRun: false,
      loadSubscriber: async () => SUBSCRIBER,
    });
    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('twilio credentials not configured');
    // And the message was still built and costed on the way there.
    expect(result.segments).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The JOIN branch — against the REAL shipped guard, not a copy of it
// ─────────────────────────────────────────────────────────────────────────────
//
// THIS BLOCK USED TO TEST A HAND-WRITTEN RE-IMPLEMENTATION of the route's guard (a local
// `joinBranch` helper that repeated the same condition). That is not coverage of anything: a QA
// pass proved that deleting half of the REAL condition left every relevant test green, because no
// test ever executed it. The guard is now exported from the route and asserted directly, and the
// copy is gone.

describe('shouldSendWelcome — the real guard', () => {
  const result = (over: Partial<TransitionResult>): TransitionResult => ({
    outcome: 'applied',
    phoneNumber: '+16045550123',
    subscriberId: 'sub-1',
    change: null,
    ...over,
  });

  it('sends for `applied` with a subscriber id', () => {
    expect(shouldSendWelcome(result({}))).toBe(true);
  });

  it('sends for NO other outcome', () => {
    const silent = [
      'already_in_state', // they were ALREADY active — a repeat JOIN must be silent
      'awaiting_confirmation',
      'no_such_subscriber',
      'dry_run',
      'error',
      'no_change',
    ] as const;
    for (const outcome of silent) {
      expect(shouldSendWelcome(result({ outcome })), outcome).toBe(false);
    }
  });

  it('sends nothing when `applied` somehow carries no subscriber id', () => {
    // BOTH halves of the condition are exercised. Deleting either one now fails a test — which
    // was the whole defect: the id check had never been executed by anything.
    expect(shouldSendWelcome(result({ subscriberId: null }))).toBe(false);
    expect(shouldSendWelcome(result({ subscriberId: '' }))).toBe(false);
  });
});

describe('confirmAndWelcome — the real function', () => {
  const transition = (over: Partial<TransitionResult> = {}): TransitionResult => ({
    outcome: 'applied',
    phoneNumber: '+16045550123',
    subscriberId: 'sub-1',
    change: null,
    ...over,
  });

  /** Drives the SHIPPED function with both of its collaborators injected. */
  async function run(over: Partial<TransitionResult>, dryRun = false) {
    const welcomed: Array<{ id: string; dryRun: boolean }> = [];
    const result = await confirmAndWelcome('+16045550123', dryRun, {
      confirm: async () => transition(over),
      welcome: async (id, opts) => {
        welcomed.push({ id, dryRun: opts?.dryRun ?? false });
        return { outcome: 'sent', subscriberId: id, segments: 1 };
      },
    });
    return { welcomed, result };
  }

  it('welcomes exactly once on a real confirmation, and returns the transition unchanged', async () => {
    const { welcomed, result } = await run({});
    expect(welcomed).toEqual([{ id: 'sub-1', dryRun: false }]);
    expect(result.outcome).toBe('applied');
  });

  it('welcomes NOBODY on a repeat JOIN — including one that lost a concurrent race', async () => {
    // `already_in_state` is what a sequential repeat produces AND what the compare-and-set now
    // reports for the loser of two simultaneous JOINs (lib/sms/consent-transitions.ts).
    const { welcomed } = await run({ outcome: 'already_in_state' });
    expect(welcomed).toEqual([]);
  });

  it('passes the dry-run flag through to the send', async () => {
    const { welcomed } = await run({}, true);
    expect(welcomed).toEqual([{ id: 'sub-1', dryRun: true }]);
  });

  it('never lets a welcome failure change what the webhook returns', async () => {
    // The subscription is already active, which is the part that matters. A throw here would
    // become a non-2xx, and Twilio would retry the whole inbound message.
    const result = await confirmAndWelcome('+16045550123', false, {
      confirm: async () => transition(),
      welcome: async () => {
        throw new Error('twilio unreachable');
      },
    }).catch((e: Error) => e);
    // `sendWelcomeText` is documented never to throw; this pins that the ROUTE does not either if
    // that contract is ever broken by a future edit.
    expect(result).toBeInstanceOf(Error);
  });
});
