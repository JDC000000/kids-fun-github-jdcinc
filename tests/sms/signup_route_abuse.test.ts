// tests/sms/signup_route_abuse.test.ts — what POST /api/sms/signup does with a throttled or an
// already-subscribed number. No database, no Twilio: the store is mocked, because what is under
// test here is the ROUTE's decisions — when it asks, what it refuses, and what it says.
//
// SEPARATE FILE FROM signup_route.test.ts on purpose. That one exercises the real store seam in
// dry-run mode and asserts the contract a caller sees; module-mocking the store there would
// weaken every test in it. The two abuse paths need the store to lie, so they get their own file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/sms/signup-store', () => ({
  checkAndRecordSignupAttempt: vi.fn(),
  createPendingSubscriber: vi.fn(),
  sendConfirmationRequest: vi.fn(),
}));
vi.mock('@/lib/observability/route-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/observability/route-handler')>()),
  captureAndFlush: vi.fn(async () => {}),
}));

import { POST } from '@/app/api/sms/signup/route';
import {
  checkAndRecordSignupAttempt,
  createPendingSubscriber,
  sendConfirmationRequest,
  type SignupThrottleResult,
} from '@/lib/sms/signup-store';
import { captureAndFlush } from '@/lib/observability/route-handler';

const throttleMock = vi.mocked(checkAndRecordSignupAttempt);
const writeMock = vi.mocked(createPendingSubscriber);
const sendMock = vi.mocked(sendConfirmationRequest);
const captureMock = vi.mocked(captureAndFlush);

const validBody = {
  phone: '604 555 0123',
  postal: 'V5L 1A1',
  childAges: [4, 7],
  interests: ['public_swim'],
  consent: true,
};

function post(body: unknown = validBody, headers: Record<string, string> = {}): Request {
  return new Request('https://kidsfun.example/api/sms/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const ALLOWED: SignupThrottleResult = {
  allowed: true,
  reason: null,
  retryAfterSeconds: 0,
  degraded: false,
};

beforeEach(() => {
  vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
  vi.stubEnv('SMS_SENDING_ENABLED', 'true');
  throttleMock.mockResolvedValue(ALLOWED);
  writeMock.mockResolvedValue({ outcome: 'created', subscriberId: 'sub-1' });
  sendMock.mockResolvedValue({ outcome: 'sent', twilioSid: 'SM1', segments: 1, errorCode: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('the throttle, from outside', () => {
  it('🔴 a refused attempt writes NOTHING and sends NOTHING', async () => {
    // The whole point. Before the throttle existed, every submission of somebody else's number
    // rewrote their consent row and dispatched a confirmation SMS to their handset.
    throttleMock.mockResolvedValue({
      allowed: false,
      reason: 'phone_interval',
      retryAfterSeconds: 420,
      degraded: false,
    });
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('420');
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Too many signup attempts. Please try again in a few minutes.',
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never says WHICH limit refused', async () => {
    // The reason distinguishes "you already asked for a text to this number" from "too many
    // numbers from your address" — different facts about different people. Returning it would let
    // an unauthenticated caller read a stranger's signup history off the error message.
    for (const reason of ['phone_interval', 'phone_daily', 'ip_interval', 'ip_daily'] as const) {
      throttleMock.mockResolvedValue({ allowed: false, reason, retryAfterSeconds: 60, degraded: false });
      const raw = await (await POST(post())).text();
      for (const leak of ['phone', 'ip', 'daily', 'interval', 'limit']) {
        expect(raw.toLowerCase(), `${reason} leaked "${leak}"`).not.toContain(leak);
      }
    }
  });

  it('is asked BEFORE anything is written, and only AFTER the body validates', async () => {
    const order: string[] = [];
    throttleMock.mockImplementation(async () => {
      order.push('throttle');
      return ALLOWED;
    });
    writeMock.mockImplementation(async () => {
      order.push('write');
      return { outcome: 'created', subscriberId: 'sub-1' };
    });
    await POST(post());
    expect(order).toEqual(['throttle', 'write']);

    // And a submission that never resolves to a real number must not spend a real subject's
    // budget: there is nothing to throttle until we know which number this is about.
    throttleMock.mockClear();
    const bad = await POST(post({ ...validBody, phone: 'garbage', consent: false }));
    expect(bad.status).toBe(400);
    expect(throttleMock).not.toHaveBeenCalled();
  });

  it('counts the attempt against the validated E.164 number, not the typed string', async () => {
    await POST(post());
    expect(throttleMock).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: '+16045550123' })
    );
  });

  it('prefers x-real-ip, falls back to the first x-forwarded-for hop, and rejects nonsense', async () => {
    // The leftmost forwarded-for entry is the conventional client position; hashing the whole
    // chain would make every hop change the subject and defeat the counter.
    const cases: Array<[Record<string, string>, string | null]> = [
      [{ 'x-real-ip': '203.0.113.7' }, '203.0.113.7'],
      [{ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }, '203.0.113.7'],
      [{ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }, '198.51.100.9'],
      [{}, null],
      // Longer than the longest IPv6 text form: treated as absent rather than truncated, because
      // a truncated address is a different address and would silently merge callers.
      [{ 'x-real-ip': 'a'.repeat(200) }, null],
    ];
    for (const [headers, expected] of cases) {
      throttleMock.mockClear();
      await POST(post(validBody, headers));
      expect(throttleMock, JSON.stringify(headers)).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: expected })
      );
    }
  });

  it('lets a degraded check through — but raises it rather than going quietly inert', async () => {
    throttleMock.mockResolvedValue({ ...ALLOWED, degraded: true });
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'sms_signup_throttle_degraded' }),
      undefined,
      { route: 'api/sms/signup', operation: 'check_signup_throttle' }
    );
  });
});

describe('an already-active subscriber resubmitting their own number', () => {
  beforeEach(() => {
    writeMock.mockResolvedValue({
      outcome: 'already_active',
      subscriberId: null,
      wasActive: true,
      preferencesReplaced: false,
    });
  });

  it('🔴 sends them NO confirmation text — there is nothing left to confirm', async () => {
    // They replied JOIN already and we hold the confirmed_timestamp that proves it. A second
    // confirmation establishes nothing and, when the submitter is not the subscriber, is simply
    // an unrequested text to a stranger's handset.
    const res = await POST(post());
    expect(sendMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200); // 200, not 201: nothing was created.
  });

  it('answers ok with alreadyActive, and does not claim a text was dispatched', async () => {
    const res = await POST(post());
    expect(await res.json()).toEqual({ ok: true, alreadyActive: true, dispatched: false });
  });

  it('still returns nothing about the subscriber', async () => {
    // The pre-existing invariant, re-asserted on the new branch: this endpoint is
    // unauthenticated and the caller has not proved they hold the number they submitted.
    const raw = await (await POST(post())).text();
    for (const leak of ['id', 'short_ref', 'preferences', 'token', '6045550123', '+1604']) {
      expect(raw.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe('the ordinary path is unchanged', () => {
  it('still 201s and reports a real dispatch', async () => {
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, dispatched: true });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: '+16045550123' }),
      { subscriberId: 'sub-1' }
    );
  });

  it('reports dispatched:false when the confirmation could not be sent', async () => {
    // A FAILED SEND IS NOT A FAILED SIGNUP — still 201, the row exists — but the response must
    // not claim a text went out, because the form reads this field to decide what to show.
    sendMock.mockResolvedValue({
      outcome: 'error',
      twilioSid: null,
      segments: 1,
      errorCode: 21610,
      error: 'blocked',
    });
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, dispatched: false });
  });
});
