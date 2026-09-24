// tests/sms/weekly_run_route.test.ts — POST /api/sms/weekly/run contract. No database, no Twilio.
//
// The orchestration module is mocked so this suite tests the ROUTE's own decisions — the auth
// gate, the dry-run forcing, the single/bulk dispatch and the PII allowlist — deterministically.
// The send pipeline itself is proven in tests/sms/weekly_send.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockBulk = vi.fn();
const mockForSubscriber = vi.fn();
const mockLoadDeps = vi.fn();
const mockLoadSubscribers = vi.fn();

vi.mock('@/lib/sms/weekly-send-io', () => ({
  sendWeeklySmsBulk: (...args: unknown[]) => mockBulk(...args),
  sendWeeklySmsForSubscriber: (...args: unknown[]) => mockForSubscriber(...args),
  loadWeeklySmsDeps: (...args: unknown[]) => mockLoadDeps(...args),
  loadActiveSubscribers: (...args: unknown[]) => mockLoadSubscribers(...args),
}));

import { POST } from '@/app/api/sms/weekly/run/route';

const SECRET = 'cron-secret-value';

function post(body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request('https://kidsfun.example/api/sms/weekly/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const authed = { authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  mockBulk.mockReset();
  mockForSubscriber.mockReset();
  mockLoadDeps.mockReset();
  mockLoadSubscribers.mockReset();
  mockBulk.mockResolvedValue({
    dryRun: true,
    candidates: 0,
    counts: {},
    totalSegments: 0,
    results: [],
  });
  mockLoadDeps.mockResolvedValue({ engine: {}, occurrenceShortRefs: new Map() });
  mockLoadSubscribers.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('auth', () => {
  it('503s when the shared secret is unconfigured — fail closed, never open', async () => {
    // An unguarded endpoint that dispatches real text messages to every subscriber is a
    // materially worse thing to leave open than one that emails.
    const res = await POST(post({}, authed));
    expect(res.status).toBe(503);
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it('401s on a missing, wrong or wrong-length secret', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    expect((await POST(post())).status).toBe(401);
    expect((await POST(post({}, { authorization: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(post({}, { 'x-cron-secret': `${SECRET}x` }))).status).toBe(401);
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it('accepts the secret via either Bearer or x-cron-secret', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    expect((await POST(post({}, authed))).status).toBe(200);
    expect((await POST(post({}, { 'x-cron-secret': SECRET }))).status).toBe(200);
  });
});

describe('the dry-run gate', () => {
  it('forces dryRun when SMS_SENDING_ENABLED is not "true"', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    await POST(post({}, authed));
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('honours an explicit { dryRun: true } even when sending IS enabled', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    await POST(post({ dryRun: true }, authed));
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('allows a real run ONLY when the env flag is on and the caller did not ask for a dry run', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    // A real run needs BOTH secrets now — the route 503s without either. Asserted on its own below.
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'test-salt');
    vi.stubEnv('SMS_PREFERENCES_SECRET', 'test-preferences-secret');
    await POST(post({}, authed));
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });

  it('cannot be talked into sending by any body parameter', async () => {
    // There is no combination of inputs that turns sending on — the env flag is the only switch.
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    for (const body of [{ dryRun: false }, { dryRun: 'false' }, { send: true }, { force: 1 }]) {
      mockBulk.mockClear();
      await POST(post(body, authed));
      expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    }
  });
});

describe('single-subscriber mode', () => {
  it('404s for an id that is not an active subscriber', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    mockLoadSubscribers.mockResolvedValue([
      { subscriber: { id: 'other' }, phoneNumber: '+16045550000' },
    ]);
    const res = await POST(post({ subscriberId: 'sub-1' }, authed));
    expect(res.status).toBe(404);
    expect(mockForSubscriber).not.toHaveBeenCalled();
  });

  it('routes through the same loader the bulk job uses', async () => {
    // An ad-hoc run must not be able to reach a subscriber the bulk job would have excluded —
    // a stopped or purged row.
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    mockLoadSubscribers.mockResolvedValue([
      { subscriber: { id: 'sub-1' }, phoneNumber: '+16045550123' },
    ]);
    mockForSubscriber.mockResolvedValue({
      subscriberId: 'sub-1',
      status: 'dry_run',
      pickCount: 6,
      segments: 2,
    });
    const res = await POST(post({ subscriberId: '  sub-1  ' }, authed));
    expect(res.status).toBe(200);
    expect(mockLoadSubscribers).toHaveBeenCalled();
    // The number travels beside the subscriber and is handed straight to the sender — it never
    // touches the pure builder and never reaches the response.
    expect(mockForSubscriber).toHaveBeenCalledWith(
      { id: 'sub-1' },
      '+16045550123',
      expect.objectContaining({ dryRun: true })
    );
    const raw = await res.clone().text();
    expect(raw).not.toContain('6045550123');
    const body = await res.json();
    expect(body.mode).toBe('single');
    expect(body.result).toEqual({
      subscriberId: 'sub-1',
      status: 'dry_run',
      pickCount: 6,
      segments: 2,
    });
  });
});

describe('the response is a PII ALLOWLIST, not a redaction', () => {
  it('drops every field it does not explicitly name', async () => {
    // The failure modes are not symmetric: a field added to SubscriberSendResult later would pass
    // through a denylist silently, and on this lane the thing that would pass through is a phone
    // number. So the route names what may go out.
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    mockBulk.mockResolvedValue({
      dryRun: true,
      candidates: 1,
      counts: { dry_run: 1 },
      totalSegments: 2,
      results: [
        {
          subscriberId: 'sub-1',
          status: 'dry_run',
          pickCount: 6,
          segments: 2,
          degradation: 'widened',
          unlinkableCount: 1,
          novelExcluded: 4,
          noveltyDegraded: 'occurrence_only',
          // Fields a future change might add. None may reach the response.
          phoneNumber: '+16045550123',
          message: { body: 'KIDS FUN: 6 picks this weekend...' },
          preferencesToken: '8fJ2q',
        },
      ],
    });

    const raw = await (await POST(post({}, authed))).text();
    expect(raw).not.toContain('6045550123');
    expect(raw).not.toContain('preferencesToken');
    expect(raw).not.toContain('KIDS FUN:');
    expect(raw).not.toContain('phoneNumber');

    const body = JSON.parse(raw);
    expect(body.results[0]).toEqual({
      subscriberId: 'sub-1',
      status: 'dry_run',
      pickCount: 6,
      segments: 2,
      degradation: 'widened',
      unlinkableCount: 1,
      novelExcluded: 4,
      // A weakened novelty filter is an operator fact, allowlisted so it is visible (D5).
      noveltyDegraded: 'occurrence_only',
    });
    // The week's cost, reported rather than inferred.
    expect(body.totalSegments).toBe(2);
  });
});

describe('input handling', () => {
  it('rejects malformed JSON but accepts an empty body as a bulk run', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    expect((await POST(post('{not json', authed))).status).toBe(400);

    const empty = new Request('https://kidsfun.example/api/sms/weekly/run', {
      method: 'POST',
      headers: authed,
    });
    const res = await POST(empty);
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('bulk');
  });

  it('passes a positive limit through and ignores a nonsense one', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    await POST(post({ limit: 5 }, authed));
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));

    mockBulk.mockClear();
    await POST(post({ limit: -1 }, authed));
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });
});

describe('the secret pre-flight — 503 rather than a real unauditable send', () => {
  /**
   * ⚠ THIS IS THE PATH `sendWeeklySmsBulk`'s OWN GUARD CANNOT COVER.
   * Single-subscriber mode calls `sendWeeklySmsForSubscriber` DIRECTLY, and that function is
   * contractually never-throws (the bulk loop depends on it), so the guard cannot live inside it.
   * Without this route check the ad-hoc path would be the one way to send a real, unauditable
   * text — which is why these assert on BOTH modes, not just the bulk one.
   */
  const enabled = () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
  };

  it('503s a real run when SMS_PHONE_HASH_SALT is absent, and dispatches nothing', async () => {
    enabled();
    vi.stubEnv('SMS_PREFERENCES_SECRET', 'test-preferences-secret');
    const res = await POST(post({}, authed));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('SMS_PHONE_HASH_SALT');
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it('503s a real run when SMS_PREFERENCES_SECRET is absent, and dispatches nothing', async () => {
    enabled();
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'test-salt');
    const res = await POST(post({}, authed));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('SMS_PREFERENCES_SECRET');
    expect(mockBulk).not.toHaveBeenCalled();
  });

  it('503s SINGLE-SUBSCRIBER mode too — the path the job guard cannot reach', async () => {
    enabled();
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'test-salt');
    const res = await POST(post({ subscriberId: 'sub-1' }, authed));
    expect(res.status).toBe(503);
    expect(mockForSubscriber).not.toHaveBeenCalled();
  });

  it('does NOT 503 a DRY run with neither secret — verification must keep working', async () => {
    vi.stubEnv('SMS_CRON_SECRET', SECRET);
    // Sending disabled, so dryRun is forced true. Neither secret is set.
    const res = await POST(post({}, authed));
    expect(res.status).toBe(200);
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('does NOT 503 when both secrets are present', async () => {
    enabled();
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'test-salt');
    vi.stubEnv('SMS_PREFERENCES_SECRET', 'test-preferences-secret');
    const res = await POST(post({}, authed));
    expect(res.status).toBe(200);
    expect(mockBulk).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });
});
