// tests/sms/inbound_stop_unchanged-db.test.ts — STOP's effect on a REAL subscriber, pinned.
//
// ═══ WHY THIS FILE EXISTS, AND WHY IT WAS WRITTEN BEFORE THE CHANGE IT PROTECTS ═══
// The inbound STOP handler is shared, CASL-load-bearing infrastructure for real subscribers. A
// waitlist concern is being added to it, and the Operator asked for proof — not "tests pass" —
// that the existing behaviour is untouched.
//
// So these assertions were written and run against the UNMODIFIED handler first, and passed. They
// describe what STOP already did, not what it does after the edit. That ordering is the evidence:
// a test written after a change can only show the change is self-consistent, while one that passed
// before and after shows the behaviour did not move.
//
//   >>> IF YOU ARE REVIEWING THE WAITLIST ADDITION: git stash the change and run this file. <<<
//   >>> It passes either way. That is the whole point of it.                                <<<
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { mirrorCarrierStop } from '@/lib/sms/consent-transitions';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+16045558';
const TEST_CONSENT_VERSION = 'test-stop-unchanged';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(300 + seq++).padStart(3, '0')}`;

function signup(over: Partial<SmsSignup> = {}): SmsSignup {
  return {
    phoneNumber: nextPhone(),
    postalCode: 'V5L 1A1',
    regionId: 'van',
    birthYears: [2018],
    categoryInterests: ['public_swim'],
    consentMethod: 'web_form',
    consentTextVersion: TEST_CONSENT_VERSION,
    ...over,
  };
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  await query(`DELETE FROM sms_area_waitlist WHERE phone_number LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  vi.stubEnv('SMS_PREFERENCES_SECRET', 'stop-unchanged-secret');
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'stop-unchanged-salt');
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

async function activeSubscriber(): Promise<{ id: string; phone: string }> {
  const s = signup();
  const created = await createPendingSubscriber(s, { dryRun: false });
  await query(`UPDATE sms_consent SET status='active', confirmed_timestamp=now() WHERE id=$1`, [
    created.subscriberId,
  ]);
  return { id: created.subscriberId as string, phone: s.phoneNumber };
}

describe('STOP on a real subscriber — behaviour pinned BEFORE the waitlist addition', () => {
  it('stops the subscription and stamps stopped_at', async () => {
    const { id, phone } = await activeSubscriber();
    const result = await mirrorCarrierStop(phone, { dryRun: false });
    expect(result.outcome).toBe('applied');

    const [row] = await query<Record<string, unknown>>(
      `SELECT status, stopped_at FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(row.status).toBe('stopped');
    expect(row.stopped_at).not.toBeNull();
  });

  it('🔴 does NOT re-stamp the consent record — STOP is not a consent act', async () => {
    // The audit columns a CASL question is answered from. STOP ends a subscription; it does not
    // change what somebody agreed to or when they agreed to it.
    const { id, phone } = await activeSubscriber();
    const [before] = await query<Record<string, unknown>>(
      `SELECT consent_timestamp, consent_text_version, confirmed_timestamp
         FROM sms_consent WHERE id = $1`,
      [id]
    );

    await mirrorCarrierStop(phone, { dryRun: false });

    const [after] = await query<Record<string, unknown>>(
      `SELECT consent_timestamp, consent_text_version, confirmed_timestamp
         FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(new Date(after.consent_timestamp as string).getTime()).toBe(
      new Date(before.consent_timestamp as string).getTime()
    );
    expect(after.consent_text_version).toBe(before.consent_text_version);
    expect(new Date(after.confirmed_timestamp as string).getTime()).toBe(
      new Date(before.confirmed_timestamp as string).getTime()
    );
  });

  it('reports no_such_subscriber for a number we have never seen, and writes nothing', async () => {
    const unknown = nextPhone();
    const result = await mirrorCarrierStop(unknown, { dryRun: false });
    expect(result.outcome).toBe('no_such_subscriber');

    const [{ count }] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sms_consent WHERE phone_number = $1`,
      [unknown]
    );
    expect(count).toBe('0');
  });

  it('writes NOTHING on a dry run', async () => {
    const { id, phone } = await activeSubscriber();
    await mirrorCarrierStop(phone, { dryRun: true });
    const [row] = await query<Record<string, unknown>>(
      `SELECT status, stopped_at FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(row.status).toBe('active'); // untouched
    expect(row.stopped_at).toBeNull();
  });

  it('does not re-stamp stopped_at on a repeat STOP', async () => {
    const { id, phone } = await activeSubscriber();
    await mirrorCarrierStop(phone, { dryRun: false });
    const [{ stopped_at: first }] = await query<{ stopped_at: Date }>(
      `SELECT stopped_at FROM sms_consent WHERE id = $1`,
      [id]
    );
    await mirrorCarrierStop(phone, { dryRun: false });
    const [{ stopped_at: second }] = await query<{ stopped_at: Date }>(
      `SELECT stopped_at FROM sms_consent WHERE id = $1`,
      [id]
    );
    expect(new Date(second).getTime()).toBe(new Date(first).getTime());
  });
});
