// tests/sms/weekly_send_consent.test.ts — the consent assertion inside sendWeeklySmsForSubscriber.
//
// ═══ WHY (P6, 2026-09-24) ═══
// QA of the Instant Picks CASL fix (a5a863a, probe P6) showed that `sendWeeklySmsForSubscriber`
// had no consent check of its own: it texted whatever subscriber and number its caller handed it.
// Every caller today picks them out of `loadActiveSubscribers`, but a new route with its own row
// lookup could have texted a PENDING subscriber. The function now re-reads the row itself and
// refuses — as a result, never a throw — unless it is active, confirmed, and at the number given.
//
// No database: the consent read is an injected seam. The real SQL is covered by
// tests/sms/weekly_send_consent-db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFUSED_CONSENT_ERROR,
  sendWeeklySmsForSubscriber,
  weeklySendConsentRefusal,
  type WeeklySendConsentRow,
  type WeeklySmsDeps,
} from '@/lib/sms/weekly-send-io';
import { hasConfirmedActiveConsent } from '@/lib/sms/instant-picks-send';
import type { ConsentStatus } from '@/lib/sms/consent-transitions';
import type { SmsSubscriber } from '@/lib/sms/weekly-send';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';

const NOW = new Date('2026-08-28T23:00:00Z'); // Friday
const PHONE = '+16045550123';
const OTHER_PHONE = '+16045559999';
const E164 = /\+[1-9]\d{7,14}/;

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

const row = (over: Partial<WeeklySendConsentRow> = {}): WeeklySendConsentRow => ({
  status: 'active',
  confirmedTimestamp: NOW,
  phoneNumber: PHONE,
  ...over,
});

/** Every seam recorded. `deps` is deliberately NOT injected: a refusal must return before the
 *  read model is needed, and if it did not, the real loader would be reached and fail loudly. */
function harness(consent: () => Promise<WeeklySendConsentRow | null>, over: Record<string, unknown> = {}) {
  const calls = { consent: [] as string[], recent: 0, dispatch: 0, record: 0, markStopped: 0, applyState: 0 };
  const options = {
    now: NOW,
    dryRun: false,
    loadConsent: async (id: string) => {
      calls.consent.push(id);
      return consent();
    },
    loadRecentlySent: async () => {
      calls.recent += 1;
      return { occurrenceIds: new Set<string>(), seriesIds: new Set<string>(), seriesResolved: true };
    },
    // Mirrors dispatchSms: a dry run returns `dry_run` and sends nothing.
    dispatch: async (_to: string, _message: unknown, opts?: { dryRun?: boolean }) => {
      calls.dispatch += 1;
      return opts?.dryRun
        ? { outcome: 'dry_run' as const, twilioSid: null, errorCode: null }
        : { outcome: 'sent' as const, twilioSid: 'SM1', errorCode: null };
    },
    record: async () => {
      calls.record += 1;
    },
    markStopped: async () => {
      calls.markStopped += 1;
    },
    applyState: async () => {
      calls.applyState += 1;
    },
    ...over,
  };
  return { calls, options };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// The rule itself
// ─────────────────────────────────────────────────────────────────────────────

describe('weeklySendConsentRefusal — the truth table', () => {
  const cases: Array<[string, WeeklySendConsentRow | null, string, string | null]> = [
    ['active, confirmed, same number', row(), PHONE, null],
    ['pending', row({ status: 'pending', confirmedTimestamp: null }), PHONE, 'status_pending'],
    ['pending with a stale confirmation (resubmitted)', row({ status: 'pending' }), PHONE, 'status_pending'],
    ['paused (confirmed, system-paused)', row({ status: 'paused' }), PHONE, 'status_paused'],
    ['stopped', row({ status: 'stopped' }), PHONE, 'status_stopped'],
    ['active WITHOUT a confirmation (pending → STOP → START)', row({ confirmedTimestamp: null }), PHONE, 'active_unconfirmed'],
    ['no such row', null, PHONE, 'not_found'],
    ['purged (number NULLed)', row({ status: 'stopped', phoneNumber: null }), PHONE, 'purged'],
    ['active and confirmed, but a DIFFERENT number was handed in', row(), OTHER_PHONE, 'number_mismatch'],
  ];
  for (const [label, r, phone, expected] of cases) {
    it(`${label} → ${expected ?? 'send'}`, () => {
      expect(weeklySendConsentRefusal(r, phone)).toBe(expected);
    });
  }

  it('fails closed on a status outside 0034’s CHECK', () => {
    expect(weeklySendConsentRefusal(row({ status: 'weird' as ConsentStatus }), PHONE)).not.toBeNull();
  });

  it('agrees with Instant Picks’ hasConfirmedActiveConsent on every status × confirmation today', () => {
    // Deliberately two predicates (see the doc comment on weeklySendConsentRefusal): if Jon lets
    // PAUSED subscribers request Instant Picks, THIS test is where the divergence is recorded —
    // the weekly rule keeps refusing paused. Until then they must agree.
    for (const status of ['pending', 'active', 'paused', 'stopped'] as const) {
      for (const confirmedTimestamp of [NOW, null]) {
        const weeklyOk = weeklySendConsentRefusal(row({ status, confirmedTimestamp }), PHONE) === null;
        expect(weeklyOk, `${status}/${confirmedTimestamp ? 'confirmed' : 'unconfirmed'}`).toBe(
          hasConfirmedActiveConsent({ status, confirmedTimestamp })
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The send honours it
// ─────────────────────────────────────────────────────────────────────────────

describe('sendWeeklySmsForSubscriber refuses anyone the rule refuses', () => {
  const refused: Array<[string, WeeklySendConsentRow | null, string]> = [
    ['pending', row({ status: 'pending', confirmedTimestamp: null }), PHONE],
    ['paused', row({ status: 'paused' }), PHONE],
    ['stopped', row({ status: 'stopped' }), PHONE],
    ['active but unconfirmed', row({ confirmedTimestamp: null }), PHONE],
    ['missing row', null, PHONE],
    ['purged', row({ status: 'stopped', phoneNumber: null }), PHONE],
    ['number mismatch', row(), OTHER_PHONE],
  ];

  for (const [label, r, phone] of refused) {
    it(`${label}: refused_consent, and NOTHING read, built, sent, logged or changed after the check`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { calls, options } = harness(async () => r);

      const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, phone, options);

      expect(result).toEqual({
        subscriberId: SUBSCRIBER.id,
        status: 'refused_consent',
        pickCount: 0,
        segments: 0,
        error: REFUSED_CONSENT_ERROR,
      });
      expect(calls.consent).toEqual([SUBSCRIBER.id]);
      expect(calls).toMatchObject({ recent: 0, dispatch: 0, record: 0, markStopped: 0, applyState: 0 });
    });
  }

  it('a DRY RUN of a pending subscriber reports refused_consent, not dry_run', async () => {
    // A dry run is a fidelity check. Reporting "would have sent" for someone we must not text
    // would misstate what the real run does.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, options } = harness(async () => row({ status: 'pending', confirmedTimestamp: null }), {
      dryRun: true,
    });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('refused_consent');
    expect(calls.dispatch).toBe(0);
  });

  it('a consent read that THROWS refuses (fail closed), does not throw, and does not leak the driver text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { calls, options } = harness(async () => {
      throw new Error(`connection reset while reading row for ${PHONE}`);
    });

    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);

    expect(result.status).toBe('refused_consent');
    expect(result.error).toBe(REFUSED_CONSENT_ERROR);
    expect(JSON.stringify(result)).not.toMatch(E164);
    expect(calls.dispatch).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('reason=consent_read_failed');
    expect(String(errors.mock.calls[0][0])).not.toMatch(E164);
  });

  it('logs expected races as warnings and bad-data refusals as errors — never with a number', async () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, harness(async () => row({ status: 'stopped' })).options);
    await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, harness(async () => row({ confirmedTimestamp: null })).options);
    await sendWeeklySmsForSubscriber(SUBSCRIBER, OTHER_PHONE, harness(async () => row()).options);

    expect(warns.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('reason=status_stopped'),
    ]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('reason=active_unconfirmed'),
      expect.stringContaining('reason=number_mismatch'),
    ]);
    for (const call of [...warns.mock.calls, ...errors.mock.calls]) {
      expect(String(call[0])).not.toMatch(E164);
    }
  });
});

describe('a subscriber the rule allows is unaffected', () => {
  it('checks once, by id, then proceeds to dispatch as before', async () => {
    vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
    const { calls, options } = harness(async () => row(), { deps: DEPS });

    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);

    expect(result.status).not.toBe('refused_consent');
    expect(calls.consent).toEqual([SUBSCRIBER.id]);
    expect(calls.dispatch).toBe(1);
  });

  it('a dry run of an allowed subscriber is still a dry run', async () => {
    vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
    const { calls, options } = harness(async () => row(), { deps: DEPS, dryRun: true });
    const result = await sendWeeklySmsForSubscriber(SUBSCRIBER, PHONE, options);
    expect(result.status).toBe('dry_run');
    expect(calls.record).toBe(0);
  });
});
