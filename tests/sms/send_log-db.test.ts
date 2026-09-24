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
import {
  loadRecentlySent,
  loadRecentlySentPickIds,
  loadSeriesIdsForOccurrences,
} from '@/lib/sms/weekly-send-io';
import { deleteSourceRows } from '@/lib/testing/delete-source-rows';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { phoneHash, PHONE_HASH_VERSION, MissingPhoneHashSaltError } from '@/lib/sms/phone-hash';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
/** Stamped on every row this suite creates, and the key its cleanup uses. See below. */
const TEST_CONSENT_VERSION = 'test-stage-b';
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
    consentTextVersion: TEST_CONSENT_VERSION,
  };
}

/**
 * ═══ THE CLEANUP KEY, AND WHY IT IS NOT THE PHONE NUMBER ═══
 * These suites TEST THE PURGE — they NULL `phone_number` on purpose to prove the audit trail
 * survives it. So a cleanup keyed on `phone_number LIKE '+1604555…'` cannot see exactly the rows
 * those tests create, and they leak. That is not hypothetical: an earlier version of this file did
 * precisely that and left 13 orphaned consent rows and a send-log row behind, found by reading the
 * live table rather than by any test failing.
 *
 * `consent_text_version` is the right key. It is fully under the test's control, it is NOT touched
 * by the purge (0034 clears only the personal columns), and a value this distinctive cannot
 * collide with a real signup — which stamps the live CONSENT_TEXT_VERSION.
 *
 * The number prefix is kept as a SECOND sweep, because a run that crashes before its first purge
 * leaves rows the version key would also catch, and belt-and-braces costs one statement.
 */
async function cleanup(): Promise<void> {
  // Send-log rows FIRST — the FK is ON DELETE SET NULL, so deleting consent rows first would
  // orphan them rather than fail loudly.
  await query(
    `DELETE FROM sms_send_log WHERE consent_text_version = $1
        OR subscriber_id IN (SELECT id FROM sms_consent WHERE consent_text_version = $1)`,
    [TEST_CONSENT_VERSION]
  );
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  // Second sweep, for a run that crashed before stamping anything.
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
    expect(row.consent_text_version).toBe(TEST_CONSENT_VERSION);
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
        consentTextVersion: TEST_CONSENT_VERSION,
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
        consentTextVersion: TEST_CONSENT_VERSION,
      })
    ).rejects.toThrow();
  });
});

/** Read back exactly what the callback path is allowed to touch, plus the one column it is not. */
async function deliveryRow(sid: string) {
  const [row] = await query<{
    delivery_status: string | null;
    delivery_error_code: number | null;
    outcome: string;
  }>(
    `SELECT delivery_status, delivery_error_code, outcome FROM sms_send_log WHERE twilio_sid = $1`,
    [sid]
  );
  return row;
}

/** One committed send row, ready for callbacks to land on. */
async function loggedSend(sid: string): Promise<void> {
  const { id, phone } = await subscriber();
  await recordSmsSend({
    subscriberId: id,
    phoneNumber: phone,
    sendType: 'weekly',
    outcome: 'sent',
    picksSnapshot: null,
    twilioSid: sid,
    consentTextVersion: TEST_CONSENT_VERSION,
  });
}

describe('applyDeliveryStatus', () => {
  it('updates delivery_status and its error code, and NOTHING else', async () => {
    // outcome is the CASL record of what WE did; delivery_status is what the carrier then did.
    // Collapsing them would make an audit answer "no" for a message we demonstrably sent.
    await loggedSend('SM_status_1');

    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_status_1', status: 'undelivered', errorCode: 30003 })
    ).toBe('applied');

    const row = await deliveryRow('SM_status_1');
    expect(row.delivery_status).toBe('undelivered');
    expect(row.delivery_error_code).toBe(30003); // 0044: the REASON, not just the verdict
    expect(row.outcome).toBe('sent'); // untouched
  });

  it('reports `no_match` when no row carries the SID — a dry-run send wrote none', async () => {
    // Still not an error, and still not a throw. But no longer INDISTINGUISHABLE FROM SUCCESS,
    // which is the actual defect: a dropped delivery receipt used to return exactly what a
    // recorded one returned. This exhausts the retry budget first, so it is also the proof that
    // the budget is bounded.
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_does_not_exist', status: 'delivered', errorCode: null })
    ).toBe('no_match');
  });

  it('records an unrecognised carrier status verbatim', async () => {
    // 0035 leaves delivery_status unconstrained precisely so a new Twilio state is not a failed
    // write. Twilio documents that it adds properties without notice.
    await loggedSend('SM_status_2');
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_status_2', status: 'teleported', errorCode: null })
    ).toBe('applied');
    expect((await deliveryRow('SM_status_2')).delivery_status).toBe('teleported');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE OUT-OF-ORDER CALLBACK. Twilio fires this webhook once per state change, and those are
// independent HTTP requests: they arrive late, twice, or in the wrong order. These run the real
// UPDATE against the real table, because the guard IS the WHERE clause — a JS reimplementation
// of it would prove nothing about the statement that actually ships.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('applyDeliveryStatus — a status can only ever move FORWARD', () => {
  it('advances through the normal sequence', async () => {
    await loggedSend('SM_seq_ok');
    for (const status of ['queued', 'sent', 'delivered']) {
      expect(await applyDeliveryStatus({ twilioSid: 'SM_seq_ok', status, errorCode: null })).toBe(
        'applied'
      );
    }
    expect((await deliveryRow('SM_seq_ok')).delivery_status).toBe('delivered');
  });

  it('REFUSES a late `queued` behind a `delivered` — the regression this fix exists for', async () => {
    await loggedSend('SM_seq_late');
    await applyDeliveryStatus({ twilioSid: 'SM_seq_late', status: 'queued', errorCode: null });
    await applyDeliveryStatus({ twilioSid: 'SM_seq_late', status: 'sent', errorCode: null });
    await applyDeliveryStatus({ twilioSid: 'SM_seq_late', status: 'delivered', errorCode: null });

    // The `queued` callback that took the slow path finally lands.
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_late', status: 'queued', errorCode: null })
    ).toBe('ignored');
    expect((await deliveryRow('SM_seq_late')).delivery_status).toBe('delivered');
  });

  it('lands on the same row whatever order the three callbacks arrive in', async () => {
    // Fully reversed: delivered first, then sent, then queued. The record must not depend on the
    // network. lib/admin/sms-engagement.ts counts `delivered`, and a subscriber silently leaving
    // that column is a dashboard that goes quiet rather than wrong.
    await loggedSend('SM_seq_rev');
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_rev', status: 'delivered', errorCode: null })
    ).toBe('applied');
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_rev', status: 'sent', errorCode: null })
    ).toBe('ignored');
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_rev', status: 'queued', errorCode: null })
    ).toBe('ignored');
    expect((await deliveryRow('SM_seq_rev')).delivery_status).toBe('delivered');
  });

  it('treats a DUPLICATE of the same callback as a no-op, not as news', async () => {
    await loggedSend('SM_seq_dup');
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_dup', status: 'delivered', errorCode: null })
    ).toBe('applied');
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_dup', status: 'delivered', errorCode: null })
    ).toBe('ignored');
    expect((await deliveryRow('SM_seq_dup')).delivery_status).toBe('delivered');
  });

  it('does not let one terminal verdict overwrite another', async () => {
    // Twilio does not send two verdicts for one message, so a second one is a duplicate rather
    // than a correction — and `undelivered` arriving after `delivered` would move the row out of
    // the engagement dashboard's delivered column and into its failed one.
    await loggedSend('SM_seq_term');
    await applyDeliveryStatus({ twilioSid: 'SM_seq_term', status: 'delivered', errorCode: null });
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_term', status: 'undelivered', errorCode: 30003 })
    ).toBe('ignored');
    const row = await deliveryRow('SM_seq_term');
    expect(row.delivery_status).toBe('delivered');
    // And the rejected callback left NO trace: an error code beside `delivered` would describe a
    // verdict this row does not hold.
    expect(row.delivery_error_code).toBeNull();
  });

  it('records an unknown status over an in-flight one, but never over a verdict', async () => {
    await loggedSend('SM_seq_unk_a');
    await applyDeliveryStatus({ twilioSid: 'SM_seq_unk_a', status: 'sent', errorCode: null });
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_unk_a', status: 'teleported', errorCode: null })
    ).toBe('applied');
    expect((await deliveryRow('SM_seq_unk_a')).delivery_status).toBe('teleported');

    await loggedSend('SM_seq_unk_b');
    await applyDeliveryStatus({ twilioSid: 'SM_seq_unk_b', status: 'delivered', errorCode: null });
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_seq_unk_b', status: 'teleported', errorCode: null })
    ).toBe('ignored');
    expect((await deliveryRow('SM_seq_unk_b')).delivery_status).toBe('delivered');
  });

  it('survives two callbacks racing each other, whichever wins the lock', async () => {
    // The guard is a compare-and-set in the WHERE clause rather than a read-then-write in JS,
    // precisely so this cannot come out `queued`. Under READ COMMITTED the loser waits for the
    // winner and then re-evaluates its own predicate against what the winner left.
    await loggedSend('SM_seq_race');
    const verdicts = await Promise.all([
      applyDeliveryStatus({ twilioSid: 'SM_seq_race', status: 'delivered', errorCode: null }),
      applyDeliveryStatus({ twilioSid: 'SM_seq_race', status: 'queued', errorCode: null }),
    ]);
    expect((await deliveryRow('SM_seq_race')).delivery_status).toBe('delivered');
    // `queued` either landed first and was overtaken, or lost and was refused. Never both applied
    // with `queued` last.
    expect(verdicts).toContain('applied');
  });
});

describe("applyDeliveryStatus — Twilio's ErrorCode is kept (migration 0044)", () => {
  it('persists the code and hands it back on a later read', async () => {
    // 30006 is the one that changes what we should DO: the number is a landline and will never
    // receive an SMS. Without this column the row could only say "did not arrive".
    await loggedSend('SM_err_landline');
    await applyDeliveryStatus({ twilioSid: 'SM_err_landline', status: 'failed', errorCode: 30006 });
    const row = await deliveryRow('SM_err_landline');
    expect(row.delivery_status).toBe('failed');
    expect(row.delivery_error_code).toBe(30006);
  });

  it('leaves the code NULL on a successful delivery', async () => {
    // Absent, not zero. `parseDeliveryStatus` maps an ErrorCode of 0 to null for the same reason.
    await loggedSend('SM_err_none');
    await applyDeliveryStatus({ twilioSid: 'SM_err_none', status: 'delivered', errorCode: null });
    expect((await deliveryRow('SM_err_none')).delivery_error_code).toBeNull();
  });

  it('keeps the code and the status describing the SAME verdict', async () => {
    // The code is written by the statement that moves the status, so an advance replaces both
    // together and can never leave a stale reason beside a new verdict.
    await loggedSend('SM_err_pair');
    await applyDeliveryStatus({ twilioSid: 'SM_err_pair', status: 'sent', errorCode: null });
    await applyDeliveryStatus({ twilioSid: 'SM_err_pair', status: 'undelivered', errorCode: 30007 });
    const row = await deliveryRow('SM_err_pair');
    expect(row.delivery_status).toBe('undelivered');
    expect(row.delivery_error_code).toBe(30007);
  });
});

describe('applyDeliveryStatus — the callback that overtakes its own INSERT', () => {
  it('waits for the row instead of dropping the receipt', async () => {
    // A REAL race, not a hypothetical one: every caller dispatches first and writes sms_send_log
    // immediately after, because the SID does not exist until Twilio has answered. The first
    // status callback can therefore be in flight while the INSERT is still uncommitted. That used
    // to be a silent zero-row UPDATE.
    const { id, phone } = await subscriber();
    const insert = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        recordSmsSend({
          subscriberId: id,
          phoneNumber: phone,
          sendType: 'weekly',
          outcome: 'sent',
          picksSnapshot: null,
          twilioSid: 'SM_race_insert',
          consentTextVersion: TEST_CONSENT_VERSION,
        }).then(resolve, reject);
      }, 100);
    });

    // Started BEFORE the row exists.
    const verdict = await applyDeliveryStatus({
      twilioSid: 'SM_race_insert',
      status: 'sent',
      errorCode: null,
    });
    await insert;

    expect(verdict).toBe('applied');
    expect((await deliveryRow('SM_race_insert')).delivery_status).toBe('sent');
  });

  it('still gives up in bounded time when the row is never written', async () => {
    const started = Date.now();
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_race_never', status: 'failed', errorCode: 30008 })
    ).toBe('no_match');
    expect(Date.now() - started).toBeLessThan(5_000); // the budget is ~500ms, not unbounded
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
      consentTextVersion: TEST_CONSENT_VERSION,
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
      consentTextVersion: TEST_CONSENT_VERSION,
    });
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'empty_week',
      outcome: 'empty',
      picksSnapshot: null,
      twilioSid: 'SM_nov_4',
      consentTextVersion: TEST_CONSENT_VERSION,
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
      consentTextVersion: TEST_CONSENT_VERSION,
    });
    expect(await loadRecentlySentPickIds(two.id)).toEqual(new Set());
  });

  it('returns an empty set for a subscriber with no history', async () => {
    const { id } = await subscriber();
    expect(await loadRecentlySentPickIds(id)).toEqual(new Set());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — resolving last week's picks to their activity series, against the real table
//
// FIXTURE HYGIENE (00c8aa0's conventions): every activity row hangs off ONE source this block
// creates and removes with `deleteSourceRows` (source-scoped, never a name pattern), and every
// date is relative to the run and IN THE PAST, with the default `needs_review` status, so no
// read model another db-lane suite builds can ever see these rows, whenever this runs.
// ─────────────────────────────────────────────────────────────────────────────

describe('loadRecentlySent — series resolution (D5)', () => {
  const DAY_MS = 86_400_000;
  let sourceId: string;

  beforeAll(async () => {
    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('manual', $1) RETURNING id`,
      [`send-log-db d5-series ${Date.now()}`]
    );
    sourceId = src.id;
  });
  afterAll(async () => {
    if (sourceId) await deleteSourceRows(sourceId);
  });

  async function series(title: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [title, sourceId]
    );
    return row.id;
  }

  /** One sitting of `seriesId`, `daysAgo` days before this run. */
  async function sitting(seriesId: string, daysAgo: number, archived = false): Promise<string> {
    const start = new Date(Date.now() - daysAgo * DAY_MS);
    const [row] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, end_datetime_utc, archived_at)
       VALUES ($1, 'D5 fixture sitting', $2, $3, $4) RETURNING id`,
      [seriesId, start, new Date(start.getTime() + 3_600_000), archived ? new Date() : null]
    );
    return row.id;
  }

  async function sentWeekly(sub: { id: string; phone: string }, snapshot: unknown[]): Promise<void> {
    await recordSmsSend({
      subscriberId: sub.id,
      phoneNumber: sub.phone,
      sendType: 'weekly',
      outcome: 'sent',
      // Deliberately untyped: this column is jsonb written by older code, and these tests put the
      // shapes an older writer could have left in it.
      picksSnapshot: snapshot as Array<{ occurrence_id: string; rank: number }>,
      twilioSid: `SM_d5_${seq}`,
      consentTextVersion: TEST_CONSENT_VERSION,
    });
  }

  it("resolves last week's picks to their series — the key that matches this week's new sitting", async () => {
    const skate = await series('D5 Public Skate');
    const swim = await series('D5 Public Swim');
    const skateLastWeek = await sitting(skate, 8);
    await sitting(skate, 1); // this week's sitting: a NEW occurrence id, same series
    const swimLastWeek = await sitting(swim, 8);
    const sub = await subscriber();
    await sentWeekly(sub, [
      { occurrence_id: skateLastWeek, rank: 1 },
      { occurrence_id: swimLastWeek, rank: 2 },
    ]);

    expect(await loadRecentlySent(sub.id)).toEqual({
      occurrenceIds: new Set([skateLastWeek, swimLastWeek]),
      seriesIds: new Set([skate, swim]),
      seriesResolved: true,
    });
  });

  it('an ARCHIVED occurrence still names its series — archiving a past sitting must not un-send it', async () => {
    const gym = await series('D5 Open Gym');
    const archived = await sitting(gym, 8, true);
    expect(await loadSeriesIdsForOccurrences([archived])).toEqual(new Set([gym]));
  });

  it('malformed and non-uuid snapshot entries neither throw nor empty the set', async () => {
    // One bad entry reaching `::uuid[]` would throw for the whole array and lose the series arm
    // for the whole week. The guard skips it instead; the good entry still resolves.
    const play = await series('D5 Indoor Play');
    const good = await sitting(play, 8);
    const sub = await subscriber();
    await sentWeekly(sub, [
      { occurrence_id: good, rank: 1 },
      { occurrence_id: 'not-a-uuid', rank: 2 },
      { occurrence_id: 42, rank: 3 },
      { rank: 4 },
      null,
    ]);

    const recent = await loadRecentlySent(sub.id);
    expect(recent.seriesResolved).toBe(true);
    expect(recent.seriesIds).toEqual(new Set([play]));
    expect(recent.occurrenceIds).toEqual(new Set([good, 'not-a-uuid']));
  });

  it('an id that no longer exists resolves to nothing, without error', async () => {
    expect(await loadSeriesIdsForOccurrences(['99999999-9999-4999-8999-999999999999'])).toEqual(new Set());
  });

  it('a subscriber with no weekly send has nothing to resolve', async () => {
    const sub = await subscriber();
    expect(await loadRecentlySent(sub.id)).toEqual({
      occurrenceIds: new Set(),
      seriesIds: new Set(),
      seriesResolved: true,
    });
  });

  it("a failing series read keeps the REAL snapshot's occurrence ids (occurrence-only, not no novelty)", async () => {
    // The series read is replaced by a failing seam; the snapshot read is the real one, so this
    // proves the fallback keeps what was actually read from sms_send_log.
    const sub = await subscriber();
    const id = '88888888-8888-4888-8888-888888888888';
    await sentWeekly(sub, [{ occurrence_id: id, rank: 1 }]);
    const recent = await loadRecentlySent(sub.id, {
      resolveSeries: async () => {
        throw new Error('canceling statement due to statement timeout');
      },
    });
    expect(recent).toEqual({ occurrenceIds: new Set([id]), seriesIds: new Set(), seriesResolved: false });
  });
});
