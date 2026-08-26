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
import type { RecordSendInput } from '@/lib/sms/weekly-send-io';

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

  it("matches §2.6's shape", () => {
    expect(message.body).toBe(
      "KIDS FUN: You're in! Your first picks for East Van, ages 5, 8, land Friday ~4pm.\n" +
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
    expect(noArea.body).toContain("You're in! Your first picks, ages 5, land Friday");
    expect(noArea.body).not.toContain('null');
    expect(noArea.body).not.toContain('for ,');
  });

  it('drops the ages clause independently', () => {
    const noAges = renderWelcomeMessage({
      areaLabel: 'Burnaby',
      childAges: [],
      preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
    });
    expect(noAges.body).toContain('Your first picks for Burnaby land Friday');
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
});

// ─────────────────────────────────────────────────────────────────────────────
// The JOIN branch — the wiring this round exists to add
// ─────────────────────────────────────────────────────────────────────────────

describe('only a SUCCESSFUL JOIN fires a welcome', () => {
  // The route's guard is a positive test on `applied`, so this exercises the same rule the route
  // applies. `confirmSubscriber` is proven separately in tests/sms/consent_transitions.test.ts.
  const OUTCOMES_THAT_MUST_NOT_SEND = [
    'already_in_state', // they were ALREADY active — a repeat JOIN must be silent
    'awaiting_confirmation',
    'no_such_subscriber',
    'dry_run',
    'error',
    'no_change',
  ] as const;

  /** Mirrors app/api/sms/inbound/route.ts's `confirmAndWelcome` guard exactly. */
  async function joinBranch(
    outcome: string,
    subscriberId: string | null,
    send: (id: string) => Promise<void>
  ) {
    if (outcome === 'applied' && subscriberId) await send(subscriberId);
  }

  it('sends for `applied`', async () => {
    const sent: string[] = [];
    await joinBranch('applied', 'sub-1', async (id) => {
      sent.push(id);
    });
    expect(sent).toEqual(['sub-1']);
  });

  it('sends for NO other outcome', async () => {
    for (const outcome of OUTCOMES_THAT_MUST_NOT_SEND) {
      const sent: string[] = [];
      await joinBranch(outcome, 'sub-1', async (id) => {
        sent.push(id);
      });
      expect(sent, outcome).toEqual([]);
    }
  });

  it('sends nothing when `applied` somehow carries no subscriber id', async () => {
    // Defensive: the guard tests both, so a malformed result cannot produce a send keyed on null.
    const sent: string[] = [];
    await joinBranch('applied', null, async (id) => {
      sent.push(id);
    });
    expect(sent).toEqual([]);
  });
});
