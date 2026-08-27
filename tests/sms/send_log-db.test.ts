// tests/sms/send_log-db.test.ts — Stage B against a REAL database.
//
// The send log is the CASL audit trail. What is asserted here is not "the INSERT runs" but that a
// row written today can still answer a complaint after the subscriber's personal data is gone —
// which is the only question this table exists for.
//
// ⚠ THE OPERATOR RUNS THIS LANE. I hold no write access to any database. Every statement was
// validated with EXPLAIN against the live schema (plans without executing), but a green run here
// is the Operator's evidence, not mine.
//
// SELF-CLEANING, keyed on a phone prefix this suite owns, in beforeAll AND afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { recordSmsSend } from '@/lib/sms/send-log';
import { applyDeliveryStatus } from '@/lib/sms/delivery-status';
import { loadRecentlySentPickIds } from '@/lib/sms/weekly-send-io';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { phoneHash, PHONE_HASH_VERSION, MissingPhoneHashSaltError } from '@/lib/sms/phone-hash';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(8000 + seq++).padStart(4, '0')}`;
const SALT = 'db-lane-phone-hash-salt';

function signup(phone: string): SmsSignup {
  return {
    phoneNumber: phone,
    postalCode: 'V5L 1A1',
    regionId: 'van',
    birthYears: [2021],
    categoryInterests: [],
    consentMethod: 'web_form',
    consentTextVersion: '2026-08-26.v2',
  };
}

async function cleanup(): Promise<void> {
  // The send log first — its FK is ON DELETE SET NULL, so orphaned rows would survive and leak
  // into another run's assertions rather than failing loudly.
  await query(
    `DELETE FROM sms_send_log WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE phone_number LIKE $1)`,
    [`${PREFIX}8%`]
  );
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}8%`]);
}

beforeAll(async () => {
  vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

/** A committed subscriber to hang send rows off. */
async function subscriber(): Promise<{ id: string; phone: string }> {
  const phone = nextPhone();
  const created = await createPendingSubscriber(signup(phone), { dryRun: false });
  return { id: created.subscriberId as string, phone };
}

describe('recordSmsSend', () => {
  it('writes the audit row, hashed, with the version that produced it', async () => {
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'welcome',
      outcome: 'sent',
      picksSnapshot: null,
      twilioSid: 'SM_welcome_1',
      consentTextVersion: '2026-08-26.v2',
    });

    const [row] = await query<Record<string, unknown>>(
      `SELECT subscriber_id, phone_hash, phone_hash_version, send_type, outcome,
              picks_snapshot, twilio_sid, consent_text_version
         FROM sms_send_log WHERE twilio_sid = $1`,
      ['SM_welcome_1']
    );
    expect(row.subscriber_id).toBe(id);
    expect(row.phone_hash).toBe(phoneHash(phone));
    expect(row.phone_hash_version).toBe(PHONE_HASH_VERSION);
    expect(row.send_type).toBe('welcome');
    expect(row.picks_snapshot).toBeNull();
    // COPIED, not joined — the wording in force at SEND time, which is the fact an audit asks about.
    expect(row.consent_text_version).toBe('2026-08-26.v2');
  });

  it('🔴 NEVER stores the number in the clear — the hash is the only trace', async () => {
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'confirm_request',
      outcome: 'sent',
      picksSnapshot: null,
      twilioSid: 'SM_clear_1',
      consentTextVersion: 'v',
    });
    // Cast the whole row to text and look for the number anywhere in it.
    const [{ dump }] = await query<{ dump: string }>(
      `SELECT sms_send_log::text AS dump FROM sms_send_log WHERE twilio_sid = $1`,
      ['SM_clear_1']
    );
    expect(dump).not.toContain(phone);
    expect(dump).not.toContain(phone.slice(-7));
  });

  it('🔴 SURVIVES THE PURGE — the whole reason the column exists', async () => {
    // Migration 0034's 30-day purge NULLs sms_consent.phone_number in place. After it, the ONLY
    // way to answer "what did you send to this number" is the hash. This is that, end to end.
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'weekly',
      outcome: 'sent',
      picksSnapshot: [{ occurrence_id: '11111111-1111-1111-1111-111111111111', rank: 1 }],
      twilioSid: 'SM_purge_1',
      consentTextVersion: 'v',
    });

    // The purge, as 0034 performs it.
    await query(
      `UPDATE sms_consent SET phone_number=NULL, postal_code=NULL, birth_years=NULL,
                              category_interests=NULL WHERE id=$1`,
      [id]
    );

    // A complaint arrives quoting the number. Hash it, and the history is still there.
    const rows = await query<{ send_type: string; consent_text_version: string }>(
      `SELECT send_type, consent_text_version FROM sms_send_log WHERE phone_hash = $1`,
      [phoneHash(phone)]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.send_type)).toContain('weekly');
  });

  it('accepts a NULL subscriber_id — a confirmation sent before the id was known', async () => {
    const phone = nextPhone();
    await recordSmsSend({
      subscriberId: null,
      phoneNumber: phone,
      sendType: 'confirm_request',
      outcome: 'sent',
      picksSnapshot: null,
      twilioSid: 'SM_nosub_1',
      consentTextVersion: 'v',
    });
    const [row] = await query<{ subscriber_id: string | null; phone_hash: string }>(
      `SELECT subscriber_id, phone_hash FROM sms_send_log WHERE twilio_sid = $1`,
      ['SM_nosub_1']
    );
    expect(row.subscriber_id).toBeNull();
    expect(row.phone_hash).toBe(phoneHash(phone)); // still findable, which is the point
    await query(`DELETE FROM sms_send_log WHERE twilio_sid = $1`, ['SM_nosub_1']);
  });

  it('stores picks_snapshot as real jsonb, queryable by containment', async () => {
    // The novelty window reads this back with @>; a JSON *string* would satisfy the column type
    // and silently fail every containment query.
    const { id, phone } = await subscriber();
    const occ = '22222222-2222-2222-2222-222222222222';
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'weekly',
      outcome: 'sent',
      picksSnapshot: [{ occurrence_id: occ, rank: 1 }],
      twilioSid: 'SM_json_1',
      consentTextVersion: 'v',
    });
    const [row] = await query<{ hit: boolean }>(
      `SELECT (picks_snapshot @> $2::jsonb) AS hit FROM sms_send_log WHERE twilio_sid = $1`,
      ['SM_json_1', JSON.stringify([{ occurrence_id: occ }])]
    );
    expect(row.hit).toBe(true);
  });

  it('REFUSES to write without a salt, rather than inventing a hash', async () => {
    // A placeholder would produce an audit trail that looks complete and answers no question.
    const { id, phone } = await subscriber();
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    await expect(
      recordSmsSend({
        subscriberId: id,
        phoneNumber: phone,
        sendType: 'welcome',
        outcome: 'sent',
        picksSnapshot: null,
        twilioSid: 'SM_nosalt_1',
        consentTextVersion: 'v',
      })
    ).rejects.toBeInstanceOf(MissingPhoneHashSaltError);
    vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
    const rows = await query(`SELECT 1 FROM sms_send_log WHERE twilio_sid = $1`, ['SM_nosalt_1']);
    expect(rows).toHaveLength(0);
  });

  it("is rejected by 0035's CHECK if a non-weekly row carries a snapshot", async () => {
    // The schema, not the code, is what guarantees this. Asserted so a future relaxation is loud.
    const { id, phone } = await subscriber();
    await expect(
      recordSmsSend({
        subscriberId: id,
        phoneNumber: phone,
        sendType: 'welcome',
        outcome: 'sent',
        picksSnapshot: [{ occurrence_id: '33333333-3333-3333-3333-333333333333', rank: 1 }],
        twilioSid: 'SM_badcheck_1',
        consentTextVersion: 'v',
      })
    ).rejects.toThrow();
  });
});

describe('applyDeliveryStatus', () => {
  it('updates delivery_status and NOTHING else', async () => {
    // outcome is the CASL record of what WE did; delivery_status is what the carrier then did.
    // Collapsing them would make an audit answer "no" for a message we demonstrably sent.
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'weekly',
      outcome: 'sent',
      picksSnapshot: null,
      twilioSid: 'SM_status_1',
      consentTextVersion: 'v',
    });

    await applyDeliveryStatus({ twilioSid: 'SM_status_1', status: 'undelivered', errorCode: 30003 });

    const [row] = await query<{ delivery_status: string; outcome: string }>(
      `SELECT delivery_status, outcome FROM sms_send_log WHERE twilio_sid = $1`,
      ['SM_status_1']
    );
    expect(row.delivery_status).toBe('undelivered');
    expect(row.outcome).toBe('sent'); // untouched
  });

  it('matching no row is not an error — a dry-run send wrote none', async () => {
    await expect(
      applyDeliveryStatus({ twilioSid: 'SM_does_not_exist', status: 'delivered', errorCode: null })
    ).resolves.toBeUndefined();
  });

  it('records an unrecognised carrier status verbatim', async () => {
    // 0035 leaves delivery_status unconstrained precisely so a new Twilio state is not a failed
    // write. Twilio documents that it adds properties without notice.
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'welcome',
      outcome: 'sent',
      picksSnapshot: null,
      twilioSid: 'SM_status_2',
      consentTextVersion: 'v',
    });
    await applyDeliveryStatus({ twilioSid: 'SM_status_2', status: 'teleported', errorCode: null });
    const [row] = await query<{ delivery_status: string }>(
      `SELECT delivery_status FROM sms_send_log WHERE twilio_sid = $1`,
      ['SM_status_2']
    );
    expect(row.delivery_status).toBe('teleported');
  });
});

describe('loadRecentlySentPickIds — the novelty window', () => {
  it('returns the occurrence ids from the most recent weekly send', async () => {
    const { id, phone } = await subscriber();
    const a = '44444444-4444-4444-4444-444444444444';
    const b = '55555555-5555-5555-5555-555555555555';
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'weekly',
      outcome: 'sent',
      picksSnapshot: [
        { occurrence_id: a, rank: 1 },
        { occurrence_id: b, rank: 2 },
      ],
      twilioSid: 'SM_nov_1',
      consentTextVersion: 'v',
    });
    expect(await loadRecentlySentPickIds(id)).toEqual(new Set([a, b]));
  });

  it('IGNORES non-weekly rows, which carry no snapshot by CHECK anyway', async () => {
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'empty_week',
      outcome: 'empty',
      picksSnapshot: null,
      twilioSid: 'SM_nov_2',
      consentTextVersion: 'v',
    });
    expect(await loadRecentlySentPickIds(id)).toEqual(new Set());
  });

  it('looks back over SENDS, not weeks — an empty week does not reset the window', async () => {
    // The distinction round 7 designed this around: a subscriber with an empty week has no weekly
    // send from last calendar week at all, so a time-based window would look at nothing and
    // re-serve a fortnight-old pick.
    const { id, phone } = await subscriber();
    const old = '66666666-6666-6666-6666-666666666666';
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'weekly',
      outcome: 'sent',
      picksSnapshot: [{ occurrence_id: old, rank: 1 }],
      twilioSid: 'SM_nov_3',
      consentTextVersion: 'v',
    });
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'empty_week',
      outcome: 'empty',
      picksSnapshot: null,
      twilioSid: 'SM_nov_4',
      consentTextVersion: 'v',
    });
    // The empty week is skipped; the previous WEEKLY send is still the window.
    expect(await loadRecentlySentPickIds(id)).toEqual(new Set([old]));
  });

  it('is scoped to ONE subscriber', async () => {
    const one = await subscriber();
    const two = await subscriber();
    await recordSmsSend({
      subscriberId: one.id,
      phoneNumber: one.phone,
      sendType: 'weekly',
      outcome: 'sent',
      picksSnapshot: [{ occurrence_id: '77777777-7777-7777-7777-777777777777', rank: 1 }],
      twilioSid: 'SM_nov_5',
      consentTextVersion: 'v',
    });
    expect(await loadRecentlySentPickIds(two.id)).toEqual(new Set());
  });

  it('returns an empty set for a subscriber with no history', async () => {
    const { id } = await subscriber();
    expect(await loadRecentlySentPickIds(id)).toEqual(new Set());
  });
});
