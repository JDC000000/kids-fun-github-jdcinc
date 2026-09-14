// tests/sms/instant_picks_send.test.ts — the on-demand send path (plan v2.0 task 5).
//
// Every seam is INJECTED rather than module-mocked, so this file constructs no pool and stays in
// the `unit` lane (vitest.workspace.ts).
//
// ═══ THE MOST IMPORTANT BLOCK IN THIS FILE IS "THE FEATURE IS HELD" ═══
// Three independent gates must pass before a text exists, and one of them — consent v8 — cannot be
// satisfied by ANY subscriber today, because CONSENT_TEXT_VERSION is still v7 and the frequency
// disclosure has not been rewritten. That is the deliberate state of this commit (plan v2.0 §6
// option B), and it is asserted here rather than described, because "this branch never runs,
// delete it" is the reasonable-looking conclusion a future reader would otherwise draw.
import { describe, expect, it, vi } from 'vitest';
import {
  INSTANT_PICKS_MIN_CONSENT_SERIAL,
  sendInstantPicksText,
  type InstantPicksSendSubscriber,
} from '@/lib/sms/instant-picks-send';
import { CONSENT_TEXT_VERSION, consentVersionSerial } from '@/lib/sms/consent-copy';
import { TWILIO_ERROR_OPTED_OUT } from '@/lib/sms/twilio-client';
import type { RecordSendInput } from '@/lib/sms/send-log';

const SUBSCRIBER_ID = '11111111-2222-3333-4444-555555555555';
const PHONE = '+16045550123';

const V8: InstantPicksSendSubscriber = {
  id: SUBSCRIBER_ID,
  phoneNumber: PHONE,
  preferencesToken: 'a'.repeat(43),
  consentTextVersion: '2026-10-01.v8',
};

/** Everything wired to succeed, with sending on and the feature switched on. */
function deps(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    dryRun: false,
    loadSubscriber: vi.fn(async () => V8),
    checkThrottle: vi.fn(async () => ({
      allowed: true, reason: null, retryAfterSeconds: 0, degraded: false,
    })),
    dispatch: vi.fn(async () => ({ outcome: 'sent' as const, twilioSid: 'SM1', errorCode: null })),
    record: vi.fn(async (_input: RecordSendInput) => {}),
    markStopped: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('instant picks send · 🔴 STILL HELD — BY THE FLAG NOW, NOT BY THE CONSENT VERSION', () => {
  it('the live consent version now REACHES the gate — task 1 landed, deliberately', () => {
    // ⚠ FLIPPED 2026-09-14, IN THE SAME COMMIT AS THE BUMP, exactly as the previous version of
    // this assertion instructed. CONSENT_TEXT_VERSION is v8, the disclosure now describes the
    // on-demand text, and the Toll-Free Verification filing for +1 877-835-7776 is confirmed
    // Approved (2026-08-31, PRD v3.24). So gate 2 is now SATISFIABLE — a new or resubmitting
    // subscriber stamps v8 and clears it.
    //
    // ⚠ THIS IS NOT "THE FEATURE IS ON". Gate 1 — INSTANT_PICKS_SMS_SEND_ENABLED — is still off
    // and is the Operator's to flip, as a separate deliberate act. The test below is what now
    // holds the line that the previous version of THIS test used to hold.
    const live = consentVersionSerial(CONSENT_TEXT_VERSION);
    expect(live).not.toBeNull();
    expect(live!).toBeGreaterThanOrEqual(INSTANT_PICKS_MIN_CONSENT_SERIAL);
  });

  it('🔴 the flag is what holds the feature now — live consent version, flag off, still nothing sent', async () => {
    // THE GUARD THAT REPLACES THE OLD CONSENT-VERSION ONE. Before task 1 the feature was held by
    // TWO independent things and this suite leaned on the consent version. That prop is gone, so
    // the remaining one is asserted directly and on its own: a subscriber on the CURRENT live
    // wording, who now genuinely clears gate 2, must STILL get nothing while the flag is off.
    // If someone defaults INSTANT_PICKS_SMS_SEND_ENABLED to true, this is what goes red.
    delete process.env.INSTANT_PICKS_SMS_SEND_ENABLED;
    const d = deps({
      enabled: undefined, // fall through to instantPicksSmsSendEnabled() — the real default
      loadSubscriber: vi.fn(async () => ({ ...V8, consentTextVersion: CONSENT_TEXT_VERSION })),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('not_eligible');
    expect(d.loadSubscriber).not.toHaveBeenCalled(); // gate 1 is before any I/O
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
    expect(d.checkThrottle).not.toHaveBeenCalled();
  });

  it('a subscriber BELOW the gate is refused, silently', async () => {
    // ⚠ PINNED TO A LITERAL v7 RATHER THAN TO CONSENT_TEXT_VERSION, as of 2026-09-14. It used to
    // read CONSENT_TEXT_VERSION because the live version WAS below the gate; now that it is v8,
    // reading the constant would have made this test assert the opposite of its own name. The
    // invariant being tested is "a pre-v8 subscriber gets nothing" — and v7 rows are real and
    // still in the table (signup-store re-stamps only on resubmit), so this is the live case for
    // every existing subscriber who has not touched the form since the bump.
    const d = deps({
      loadSubscriber: vi.fn(async () => ({ ...V8, consentTextVersion: '2026-09-03.v7' })),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('not_eligible');
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
    // ⚠ AND IT DID NOT SPEND THE THROTTLE BUDGET. A held feature that consumed a subscriber's
    // daily allowance would lock out the very parents it is later enabled for.
    expect(d.checkThrottle).not.toHaveBeenCalled();
  });

  it('the env flag defaults to OFF, and off means no database read at all', async () => {
    delete process.env.INSTANT_PICKS_SMS_SEND_ENABLED;
    const d = deps({ enabled: undefined });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('not_eligible');
    expect(d.loadSubscriber).not.toHaveBeenCalled();
  });

  it('does NOT read SMS_SENDING_ENABLED as its switch — that one is already true in production', async () => {
    // The whole reason for a fourth flag. If this ever passes with only SMS_SENDING_ENABLED set,
    // the feature went live the moment it merged.
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    delete process.env.INSTANT_PICKS_SMS_SEND_ENABLED;
    const d = deps({ enabled: undefined, dryRun: undefined });
    expect((await sendInstantPicksText(SUBSCRIBER_ID, d)).status).toBe('not_eligible');
    expect(d.dispatch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe('instant picks send · the structural consent gate', () => {
  it.each([
    ['2026-09-03.v7', 'not_eligible'],
    ['2026-08-29.v2', 'not_eligible'],
    ['2026-10-01.v8', 'sent'],
    ['2027-01-01.v9', 'sent'],
    // Lexically '…v10' < '…v9', which is exactly why the gate parses a serial instead of
    // comparing strings. A future v10 subscriber must not be silently locked out.
    ['2027-06-01.v10', 'sent'],
  ])('%s → %s', async (version, expected) => {
    const result = await sendInstantPicksText(
      SUBSCRIBER_ID,
      deps({ loadSubscriber: vi.fn(async () => ({ ...V8, consentTextVersion: version })) })
    );
    expect(result.status).toBe(expected);
  });

  it('an unparseable version is a refusal, not a zero and not a pass', async () => {
    const result = await sendInstantPicksText(
      SUBSCRIBER_ID,
      deps({ loadSubscriber: vi.fn(async () => ({ ...V8, consentTextVersion: 'legacy' })) })
    );
    expect(result.status).toBe('not_eligible');
  });
});

describe('instant picks send · who has nobody to text', () => {
  it('a row that vanished is silent, not a failure', async () => {
    const d = deps({ loadSubscriber: vi.fn(async () => null) });
    expect((await sendInstantPicksText(SUBSCRIBER_ID, d)).status).toBe('not_eligible');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a read that THREW is a failure, because silence would hide it', async () => {
    const d = deps({
      loadSubscriber: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('failed');
    expect(result.degraded).toBe(true);
  });
});

describe('instant picks send · the dry run', () => {
  it('builds the message and dispatches nothing, writing no log and no counter', async () => {
    const d = deps({ dryRun: true });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('disabled');
    // BUILT, not skipped: a body that would not render must fail in a verification run rather
    // than in front of a parent.
    expect(result.segments).toBe(1);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
    // `sms_send_log` records messages that were SENT and has no dry_run column (migration 0035).
    expect(d.checkThrottle).not.toHaveBeenCalled();
  });
});

describe('instant picks send · the throttle', () => {
  it('a real refusal is "throttled" and is NOT degraded — that is the system working', async () => {
    const d = deps({
      checkThrottle: vi.fn(async () => ({
        allowed: false, reason: 'subscriber_daily' as const, retryAfterSeconds: 900, degraded: false,
      })),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('throttled');
    expect(result.degraded).toBe(false);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a refusal because the counter could not run IS degraded, so the caller can alert', async () => {
    const d = deps({
      checkThrottle: vi.fn(async () => ({
        allowed: false, reason: null, retryAfterSeconds: 0, degraded: true,
      })),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('throttled');
    expect(result.degraded).toBe(true);
  });

  it('hands the IP through to the throttle’s second half', async () => {
    const d = deps();
    await sendInstantPicksText(SUBSCRIBER_ID, { ...d, ipAddress: '203.0.113.7' });
    expect(d.checkThrottle).toHaveBeenCalledWith({
      subscriberId: SUBSCRIBER_ID,
      ipAddress: '203.0.113.7',
    });
  });
});

describe('instant picks send · the audit row', () => {
  it('writes ONE row, send_type instant_picks, picks_snapshot NULL', async () => {
    const d = deps();
    await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(d.record).toHaveBeenCalledTimes(1);
    expect(d.record).toHaveBeenCalledWith({
      subscriberId: SUBSCRIBER_ID,
      phoneNumber: PHONE,
      sendType: 'instant_picks',
      outcome: 'sent',
      // ⚠ NULL, ALWAYS. 0035's CHECK rejects anything else, and widening that CHECK to "record
      // what we sent" would silently break the weekly novelty filter — a Wednesday press would
      // suppress those activities from Friday's real text.
      picksSnapshot: null,
      twilioSid: 'SM1',
      consentTextVersion: V8.consentTextVersion,
    });
  });

  it('copies the consent version in force AT SEND TIME rather than joining it later', async () => {
    const d = deps({
      loadSubscriber: vi.fn(async () => ({ ...V8, consentTextVersion: '2027-01-01.v9' })),
    });
    await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(d.record.mock.calls[0][0].consentTextVersion).toBe('2027-01-01.v9');
  });

  it('a lost audit row does not become a failed page render, but IS reported', async () => {
    // The text has already gone. Losing the CASL record is bad and is still not worth turning a
    // parent's page into an error.
    const d = deps({
      record: vi.fn(async (_input: RecordSendInput) => {
        throw new Error('check constraint violation');
      }),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('sent');
    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/send-log/);
  });
});

describe('instant picks send · Twilio 21610, the send-time opt-out safeguard', () => {
  it('marks the subscriber stopped BEFORE logging, and logs the real outcome', async () => {
    const order: string[] = [];
    const d = deps({
      dispatch: vi.fn(async () => ({
        outcome: 'stopped_via_carrier' as const,
        twilioSid: null,
        errorCode: TWILIO_ERROR_OPTED_OUT,
      })),
      markStopped: vi.fn(async () => {
        order.push('markStopped');
      }),
      record: vi.fn(async (_input: RecordSendInput) => {
        order.push('record');
      }),
    });

    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);

    // PRD §2.2 step 6 makes this a send-time safeguard INDEPENDENT of the inbound webhook, and
    // "independent" means EVERY send path honours it. Without this, somebody who opted out at the
    // carrier but whose preferences link is still in circulation would stay 'active' forever while
    // the identical Twilio code on the weekly path stopped them properly.
    expect(d.markStopped).toHaveBeenCalledWith(SUBSCRIBER_ID);
    // The state change protects the subscriber; the audit row records it. That order, not the
    // other one — it matches lib/sms/weekly-send-io.ts.
    expect(order).toEqual(['markStopped', 'record']);
    expect(d.record.mock.calls[0][0].outcome).toBe('stopped_via_carrier');
    expect(result.status).toBe('failed');
  });

  it('a markStopped that fails still logs the 21610 — the fact is not lost with the write', async () => {
    const d = deps({
      dispatch: vi.fn(async () => ({
        outcome: 'stopped_via_carrier' as const, twilioSid: null, errorCode: TWILIO_ERROR_OPTED_OUT,
      })),
      markStopped: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(d.record.mock.calls[0][0].outcome).toBe('stopped_via_carrier');
  });
});

describe('instant picks send · failure never escapes as an exception', () => {
  it('a dispatch that threw is a result, not a throw', async () => {
    const d = deps({
      dispatch: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('failed');
    expect(result.degraded).toBe(true);
    expect(d.record).not.toHaveBeenCalled();
  });

  it('a Twilio failure is logged as failed and reported', async () => {
    const d = deps({
      dispatch: vi.fn(async () => ({
        outcome: 'failed' as const, twilioSid: null, errorCode: 30007, error: 'code 30007',
      })),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    expect(result.status).toBe('failed');
    expect(d.record.mock.calls[0][0].outcome).toBe('failed');
  });

  it('carries neither the number nor the body out in any error', async () => {
    const d = deps({
      dispatch: vi.fn(async () => {
        throw new Error(`The 'To' number ${PHONE} is not a valid phone number.`);
      }),
    });
    const result = await sendInstantPicksText(SUBSCRIBER_ID, d);
    // ⚠ Twilio's own error messages contain the recipient's number (error 21211 literally does).
    // The module's promise is that nothing it returns carries one.
    expect(JSON.stringify(result)).not.toContain(PHONE);
    expect(JSON.stringify(result)).not.toContain('1604');
  });
});
