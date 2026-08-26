// tests/sms/confirm_request.test.ts — the confirmation request: the FIRST message this product
// ever sends (PRD §1.4, §2.1, §2.6).
//
// WHY THIS FILE EXISTS AT ALL. Until round 12 this message had never been built. §2.6's approved
// body sat in a doc comment on `sendConfirmationRequest`, whose non-dry-run branch returned a
// hardcoded `not implemented` error — so the one template that goes to a number which has NOT yet
// consented was also the one template that had never been through the GSM-7 guard. Round 11 found
// a real bug in that guard by implementing a message against it; this is the same exercise on the
// message with the highest CASL exposure.
//
// Two layers, matching tests/sms/welcome.test.ts:
//   • `renderConfirmRequestMessage` — pure copy, §2.6 verbatim, and the encoding wall.
//   • `sendConfirmationRequest` — that exactly one message is dispatched, that a dry run writes
//     nothing, and that the area is resolved by the SAME resolver the welcome text uses.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGsm7Safe,
  estimateSegments,
  renderConfirmRequestMessage,
} from '@/lib/sms/message';
import {
  sendConfirmationRequest,
  type ConfirmationSendOptions,
} from '@/lib/sms/signup-store';
import { areaLabelForPostal, REGION_LABEL } from '@/lib/geo/postal-fsa';
import { parseSmsSignupBody, type SmsSignup } from '@/lib/sms/signup-validate';
import type { RecordSendInput } from '@/lib/sms/weekly-send-io';

const NOW = new Date('2026-08-26T19:00:00Z');

const SIGNUP: SmsSignup = {
  phoneNumber: '+16045550123',
  postalCode: 'V5L 1A1', // East Vancouver → "Vancouver"
  regionId: 'van',
  birthYears: [2021, 2018],
  categoryInterests: [],
  consentMethod: 'web_form',
  consentTextVersion: '2026-08-26.v2',
};

/** All seams wired; records what was dispatched and what was logged. */
function wired(over: Partial<ConfirmationSendOptions> = {}) {
  const dispatched: Array<{ phone: string; body: string; dryRun: boolean }> = [];
  const logged: RecordSendInput[] = [];
  const options: ConfirmationSendOptions = {
    subscriberId: 'sub-1',
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

describe('the confirmation request (PRD §2.6)', () => {
  it("is §2.6's wording VERBATIM", () => {
    expect(renderConfirmRequestMessage('Vancouver').body).toBe(
      'KIDS FUN: Reply JOIN to confirm weekly kid activity picks for Vancouver. ' +
        'Msg&data rates may apply. Reply STOP to opt out anytime.'
    );
  });

  it('says JOIN and never YES', () => {
    // YES is a Twilio Advanced Opt-Out keyword and can be intercepted at the carrier layer before
    // our webhook sees it, leaving a parent who did everything right stuck at `pending`.
    const body = renderConfirmRequestMessage('Vancouver').body;
    expect(body).toContain('Reply JOIN to confirm');
    expect(body).not.toMatch(/reply yes/i);
  });

  it('carries the brand tag, the rates disclosure and a free opt-out', () => {
    // The three things a carrier / TFV reviewer looks for on a confirmation message.
    const body = renderConfirmRequestMessage('Burnaby').body;
    expect(body.startsWith('KIDS FUN:')).toBe(true);
    expect(body).toContain('Msg&data rates may apply.');
    expect(body).toContain('Reply STOP to opt out anytime.');
  });

  it('uses its OWN opt-out sentence, not the STOP_LINE every other template ends with', () => {
    // Deliberate, and pinned so a future "consistency" edit is a decision rather than a reflex:
    // §2.6 gives this message "Reply STOP to opt out anytime." inline, where the others end with
    // "Reply STOP to end" on its own line. This one reaches somebody who has not confirmed
    // anything yet, so there is nothing to "end".
    const body = renderConfirmRequestMessage('Vancouver').body;
    expect(body).not.toContain('Reply STOP to end');
    expect(body).not.toContain('\n');
  });

  it('IS covered by the GSM-7 guard, not exempt from it', () => {
    // Also asserted in the all-templates wall in tests/sms/weekly_send.test.ts.
    const message = renderConfirmRequestMessage('Vancouver');
    expect(() => assertGsm7Safe(message.body)).not.toThrow();
    expect(message.encoding).toBe('GSM-7');
    expect(message.segments).toBe(1);
  });

  it('stays inside ONE segment for every area we cover, including the longest', () => {
    // The measurement, not an assumption. "North Vancouver" is the worst case at 135 septets of
    // the 160 a single GSM-7 segment holds, so the whole covered set fits with 25 to spare — the
    // headroom any future addition to this copy has to fit inside.
    for (const label of Object.values(REGION_LABEL)) {
      const estimate = estimateSegments(renderConfirmRequestMessage(label).body);
      expect(estimate.encoding, label).toBe('GSM-7');
      expect(estimate.segments, label).toBe(1);
    }
    expect(estimateSegments(renderConfirmRequestMessage('North Vancouver').body).characters).toBe(135);
  });

  it('drops the area clause rather than printing a placeholder', () => {
    // Unreachable from the signup path — the validator rejects any postal that does not resolve —
    // but the renderer is pure and must not rely on its one caller's guarantee.
    const body = renderConfirmRequestMessage(null).body;
    expect(body).toContain('confirm weekly kid activity picks. Msg&data');
    expect(body).not.toContain('null');
    expect(body).not.toContain(' for .');
    assertGsm7Safe(body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The send
// ─────────────────────────────────────────────────────────────────────────────

describe('sendConfirmationRequest', () => {
  it('dispatches exactly ONE message, to the number on the signup', async () => {
    const { dispatched, options } = wired({ dryRun: false });
    const result = await sendConfirmationRequest(SIGNUP, options);

    expect(result.outcome).toBe('sent');
    expect(result.twilioSid).toBe('SM123');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].phone).toBe('+16045550123');
    expect(dispatched[0].body).toBe(renderConfirmRequestMessage('Vancouver').body);
  });

  it('writes ONE sms_send_log row with send_type "confirm_request"', async () => {
    const { logged, options } = wired({ dryRun: false });
    await sendConfirmationRequest(SIGNUP, options);
    expect(logged).toEqual([
      {
        subscriberId: 'sub-1',
        sendType: 'confirm_request',
        outcome: 'sent',
        // Weekly sends only — migration 0035's CHECK rejects a snapshot on any other send_type.
        picksSnapshot: null,
        twilioSid: 'SM123',
        consentTextVersion: '2026-08-26.v2',
      },
    ]);
  });

  it('resolves the area with the SAME resolver the welcome text uses, not a second one', async () => {
    // lib/sms/welcome.ts calls areaLabelForPostal(postalCode). So does this. One postal code must
    // not be able to name two different areas in two consecutive messages.
    for (const [postal, expected] of [
      ['V5L 1A1', 'Vancouver'],
      ['V7S 1A1', 'West Vancouver'],
      ['V5A 1A1', 'Burnaby'],
      ['V6X 1A1', 'Richmond'],
      ['V7L 1A1', 'North Vancouver'],
    ] as const) {
      const { dispatched, options } = wired({ dryRun: false });
      await sendConfirmationRequest({ ...SIGNUP, postalCode: postal }, options);
      expect(dispatched[0].body, postal).toContain(`picks for ${expected}.`);
      expect(areaLabelForPostal(postal), postal).toBe(expected);
    }
  });

  it('and that resolver agrees with the regionId the validator already stored', async () => {
    // `SmsSignup` carries BOTH `postalCode` and the `regionId` the validator resolved from it.
    // Going back through the postal code keeps this call identical to the welcome text's — this
    // pins that the two routes cannot disagree, which is the only reason that is safe.
    const parsed = parseSmsSignupBody(
      {
        consent: true,
        phone: '604 555 0123',
        postal: 'v7s1a1',
        childAges: [5],
      },
      { now: NOW }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(areaLabelForPostal(parsed.value.postalCode)).toBe(REGION_LABEL[parsed.value.regionId]);
  });

  it('is dry-run by default in an unconfigured environment — built, costed, not dispatched', async () => {
    // SMS_SENDING_ENABLED deliberately unset, and `dryRun` NOT passed, so this asserts the
    // DEFAULT. The message is still BUILT: a verification run must cost the real message.
    const { dispatched, logged, options } = wired();
    delete (options as { dryRun?: boolean }).dryRun;
    const result = await sendConfirmationRequest(SIGNUP, options);

    expect(result.outcome).toBe('dry_run');
    expect(result.twilioSid).toBeNull();
    expect(result.segments).toBe(1);
    expect(dispatched[0].dryRun).toBe(true);
    expect(dispatched[0].body).toBe(renderConfirmRequestMessage('Vancouver').body);
    // sms_send_log has no dry_run column by design (0035) — a staging run writes no audit row.
    expect(logged).toEqual([]);
  });

  it('sends for real when SMS_SENDING_ENABLED is true, with no explicit dryRun', async () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const { dispatched, logged, options } = wired();
    delete (options as { dryRun?: boolean }).dryRun;
    const result = await sendConfirmationRequest(SIGNUP, options);
    expect(result.outcome).toBe('sent');
    expect(dispatched[0].dryRun).toBe(false);
    expect(logged).toHaveLength(1);
  });

  it('reports a Twilio failure as an error, and logs the attempt', async () => {
    const { logged, options } = wired({
      dryRun: false,
      dispatch: async () => ({ outcome: 'failed', twilioSid: null, errorCode: 30001, error: 'boom' }),
    });
    const result = await sendConfirmationRequest(SIGNUP, options);
    expect(result.outcome).toBe('error');
    expect(result.errorCode).toBe(30001);
    // "we tried and Twilio refused" is a different answer from "no record", and only one is true.
    expect(logged[0].outcome).toBe('failed');
  });

  it('surfaces 21610 as its own code — the case the route cannot fix', async () => {
    // On this path a carrier opt-out means the number blocked us BEFORE signing up: the
    // confirmation is undeliverable and stays that way until they text START themselves. Reported
    // rather than flattened into a generic failure, so it is at least visible.
    const { logged, options } = wired({
      dryRun: false,
      dispatch: async () => ({ outcome: 'stopped_via_carrier', twilioSid: null, errorCode: 21610 }),
    });
    const result = await sendConfirmationRequest(SIGNUP, options);
    expect(result.outcome).toBe('error');
    expect(result.errorCode).toBe(21610);
    expect(logged[0].outcome).toBe('stopped_via_carrier');
  });

  it('still sends when there is no subscriber id, and writes no audit row', async () => {
    // Null in the draft scaffold (the store stub returns none) and on a dry run. A missing audit
    // id must not cost a parent their confirmation text.
    const { dispatched, logged, options } = wired({ dryRun: false, subscriberId: null });
    const result = await sendConfirmationRequest(SIGNUP, options);
    expect(result.outcome).toBe('sent');
    expect(dispatched).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it('never throws, and no error string carries the number or the body', async () => {
    const result = await sendConfirmationRequest(SIGNUP, {
      dryRun: false,
      dispatch: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('dispatch threw');
    expect(result.error).not.toContain('6045550123');
    expect(result.error).not.toContain('Reply JOIN');
  });

  it('a lost audit row does not turn a delivered message into a failure', async () => {
    // The text has already gone. Reporting an error would invite the route to tell a parent their
    // signup failed, after both the consent row and the message succeeded.
    const { options } = wired({
      dryRun: false,
      record: async () => {
        throw new Error('relation "sms_send_log" does not exist');
      },
    });
    const result = await sendConfirmationRequest(SIGNUP, options);
    expect(result.outcome).toBe('sent');
  });

  it('the default seams are inert — an unwired real send does not reach Twilio', async () => {
    // `dispatchSms` is still a stub, so this is the honest current state of the branch: the
    // MESSAGE is real, the transport is not.
    const result = await sendConfirmationRequest(SIGNUP, { dryRun: false, subscriberId: null });
    expect(result.outcome).toBe('error');
    expect(result.segments).toBe(1); // built and costed all the same
  });
});
