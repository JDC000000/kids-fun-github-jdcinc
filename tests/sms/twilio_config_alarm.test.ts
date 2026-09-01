// tests/sms/twilio_config_alarm.test.ts — the guard for the incident where TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID were absent from production for days and
// every confirm-request send failed silently, found only by someone reading sms_send_log.
//
// EACH TEST GETS A FRESH MODULE (vi.resetModules + dynamic import). The alarm deliberately fires
// once per cold start, so a shared module instance would make the second test in this file
// silently depend on what the first one already alarmed about. A fresh import per test IS the
// cold start being described.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWelcomeMessage } from '@/lib/sms/message';

// Typed to captureAndFlush's REAL signature. `vi.fn(async () => {})` infers `.mock.calls` as
// an array of EMPTY tuples, so every `calls[0][0]` below is a type error even though the tests
// pass at runtime — which is precisely how this file shipped with a false "tsc clean" claim.
const captureAndFlush = vi.fn(
  async (_err: unknown, _flushTimeoutMs?: number, _tags?: Record<string, string>) => {}
);
vi.mock('@/lib/observability/route-handler', () => ({ captureAndFlush }));

const TO = '+16045550123';
const MESSAGE = renderWelcomeMessage({
  areaLabel: 'East Van',
  childAges: [5],
  preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
});

async function freshDispatch() {
  vi.resetModules();
  return (await import('@/lib/sms/twilio-client')).dispatchSms;
}

beforeEach(() => {
  captureAndFlush.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('missingTwilioConfig names what is absent, and only names', () => {
  it('lists every unset variable', async () => {
    vi.resetModules();
    const { missingTwilioConfig } = await import('@/lib/sms/config');
    expect(missingTwilioConfig()).toEqual([
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_MESSAGING_SERVICE_SID',
    ]);
  });

  it('lists only the one that is missing when the others are set', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'a'.repeat(32)}`);
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'super-secret-token-value');
    vi.resetModules();
    const { missingTwilioConfig } = await import('@/lib/sms/config');
    expect(missingTwilioConfig()).toEqual(['TWILIO_MESSAGING_SERVICE_SID']);
  });

  it('🔴 returns NAMES, never values — this result goes straight into an alert', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'super-secret-token-value');
    vi.resetModules();
    const { missingTwilioConfig } = await import('@/lib/sms/config');
    const joined = missingTwilioConfig().join(' ');
    expect(joined).not.toContain('super-secret-token-value');
  });
});

describe('the alarm fires when a real send is really lost', () => {
  it('captures once when sending is enabled but Twilio is unconfigured', async () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const dispatchSms = await freshDispatch();

    const result = await dispatchSms(TO, MESSAGE, { dryRun: false });

    expect(captureAndFlush).toHaveBeenCalledTimes(1);
    const err = captureAndFlush.mock.calls[0][0] as Error;
    expect(err.message).toContain('TWILIO_ACCOUNT_SID');
    expect(err.message).toContain('failing silently');
    // Behaviour is UNCHANGED. The point of this change was the notification, not a new failure mode.
    expect(result.outcome).toBe('failed');
    expect(result.twilioSid).toBeNull();
  });

  it('🔴 stays silent when sending is disabled — an unconfigured dev box is not an incident', async () => {
    // Without this the alarm would fire on every developer machine and every preview deploy, and
    // would be muted within a week. A guard nobody can afford to leave on is not a guard.
    vi.stubEnv('SMS_SENDING_ENABLED', 'false');
    const dispatchSms = await freshDispatch();

    await dispatchSms(TO, MESSAGE, { dryRun: false });

    expect(captureAndFlush).not.toHaveBeenCalled();
  });

  it('🔴 alarms ONCE across a bulk run, not once per subscriber', async () => {
    // The Friday job loops five hundred subscribers. Five hundred identical Sentry events is an
    // outage of the alerting channel, not an alert.
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const dispatchSms = await freshDispatch();

    for (let i = 0; i < 25; i += 1) {
      await dispatchSms(TO, MESSAGE, { dryRun: false });
    }

    expect(captureAndFlush).toHaveBeenCalledTimes(1);
  });

  it('never puts the phone number or the message body in the alarm', async () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const dispatchSms = await freshDispatch();

    await dispatchSms(TO, MESSAGE, { dryRun: false });

    const payload = JSON.stringify(captureAndFlush.mock.calls[0]) + (captureAndFlush.mock.calls[0][0] as Error).message;
    expect(payload).not.toContain(TO);
    expect(payload).not.toContain(MESSAGE.body);
  });

  it('does not alarm on a dry run — it dispatches nothing, so nothing is lost', async () => {
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const dispatchSms = await freshDispatch();

    const result = await dispatchSms(TO, MESSAGE, { dryRun: true });

    expect(result.outcome).toBe('dry_run');
    expect(captureAndFlush).not.toHaveBeenCalled();
  });
});
