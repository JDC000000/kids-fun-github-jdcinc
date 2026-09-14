// tests/sms/instant_picks_send_log-db.test.ts — the on-demand audit row, against a REAL database
// (plan v2.0 task 6, task 8).
//
// ═══ WHY A DB LANE FILE WHEN THERE IS ALREADY A STATIC ONE ═══
// tests/sms/instant_picks_send_log_invariants.test.ts reads the source and the migrations and
// asserts nobody EDITED the two load-bearing rules. That catches the edit. It cannot catch the
// case where the migration was written correctly and DID NOT DO WHAT IT SAID — a DROP predicate
// that matched nothing, a constraint left in place beside its replacement, an ADD that silently
// applied to a different table. Those are the failure modes migration 0049's own header is most
// worried about, and the only way to see them is to make the database answer.
//
// So this file asks the live schema three questions:
//   1. does an on-demand row INSERT at all (i.e. did the send_type CHECK actually widen);
//   2. does the snapshot rule STILL REJECT a snapshot on that row (i.e. did 0049 avoid dropping
//      the constraint that mentions the same column it was searching for);
//   3. does the "Last Friday" panel stay blind to it.
//
// ⚠ THE OPERATOR RUNS THIS LANE against the shared database. SELF-CLEANING on a key this suite
// owns, in beforeAll AND afterAll, following tests/sms/send_log-db.test.ts's rule — the key is
// `consent_text_version`, NOT the phone number, because the purge NULLs the number and a
// number-keyed cleanup would leak exactly the rows these suites create.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { recordSmsSend } from '@/lib/sms/send-log';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import { findLastWeek } from '@/lib/sms/preferences';
import { checkAndRecordInstantPicksSend } from '@/lib/sms/instant-picks-send-throttle';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
const TEST_CONSENT_VERSION = 'test-instant-picks-send';
const SALT = 'db-lane-instant-picks-salt';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(7100 + seq++).padStart(4, '0')}`;

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

async function cleanup(): Promise<void> {
  // Send-log rows FIRST — the FK is ON DELETE SET NULL, so deleting consent rows first would
  // orphan them rather than fail loudly.
  await query(
    `DELETE FROM sms_send_log WHERE consent_text_version = $1
        OR subscriber_id IN (SELECT id FROM sms_consent WHERE consent_text_version = $1)`,
    [TEST_CONSENT_VERSION]
  );
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  await query(
    `DELETE FROM sms_send_log WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE phone_number LIKE $1)`,
    [`${PREFIX}71%`]
  );
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}71%`]);
  // The throttle counters this suite writes. Short-lived by design (migration 0045) and scoped to
  // the subjects our own salt produces, so this cannot touch another suite's rows.
  await query(`DELETE FROM sms_signup_throttle WHERE scope LIKE 'instant_picks_sms%'`);
}

beforeAll(async () => {
  vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

async function subscriber(): Promise<{ id: string; phone: string }> {
  const phone = nextPhone();
  const created = await createPendingSubscriber(signup(phone), { dryRun: false });
  return { id: created.subscriberId as string, phone };
}

describe('migration 0049 · the send_type CHECK actually widened', () => {
  it('an on-demand row inserts', async () => {
    const { id, phone } = await subscriber();
    await expect(
      recordSmsSend({
        subscriberId: id,
        phoneNumber: phone,
        sendType: 'instant_picks',
        outcome: 'sent',
        picksSnapshot: null,
        twilioSid: 'SM_instant_1',
        consentTextVersion: TEST_CONSENT_VERSION,
      })
    ).resolves.toBeUndefined();

    const rows = await query<{ send_type: string; picks_snapshot: unknown }>(
      `SELECT send_type, picks_snapshot FROM sms_send_log WHERE subscriber_id = $1`,
      [id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].send_type).toBe('instant_picks');
    expect(rows[0].picks_snapshot).toBeNull();
  });

  it('exactly ONE send_type enumeration constraint exists — not the replacement plus the original', () => {
    // ⚠ THE SILENT HALF-APPLICATION migration 0046's header warns about: `IF EXISTS` on a
    // differently-named DROP misses, the ADD still succeeds, and TWO constraints sit on the
    // column. Both must pass, so every write under the new value is rejected by a constraint the
    // migration ledger says was replaced.
    return query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
        WHERE ns.nspname = 'public' AND t.relname = 'sms_send_log' AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%confirm_request%'`
    ).then((rows) => expect(rows[0].n).toBe('1'));
  });
});

describe('🔴 migration 0049 · the snapshot rule SURVIVED, and still bites', () => {
  it('sms_send_log_picks_only_weekly is still present and still says what it said', async () => {
    const rows = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
        WHERE ns.nspname = 'public' AND t.relname = 'sms_send_log'
          AND c.conname = 'sms_send_log_picks_only_weekly'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain('picks_snapshot');
    expect(rows[0].def).toContain("'weekly'");
    // And it did NOT quietly grow the new value.
    expect(rows[0].def).not.toContain('instant_picks');
  });

  it('the database REJECTS a snapshot on an on-demand row', async () => {
    // The behavioural half of §9 risk 4. If this ever passes, the weekly novelty filter's "same
    // condition twice" assumption is false and a Wednesday button press can suppress activities
    // from Friday's real text — with every other test in this repo still green.
    const { id, phone } = await subscriber();
    await expect(
      recordSmsSend({
        subscriberId: id,
        phoneNumber: phone,
        sendType: 'instant_picks',
        outcome: 'sent',
        picksSnapshot: [{ occurrence_id: 'occ-1', rank: 1 }],
        twilioSid: 'SM_instant_bad',
        consentTextVersion: TEST_CONSENT_VERSION,
      })
    ).rejects.toThrow();
  });

  it('and still accepts one on a weekly row, so the rule was not simply broken', async () => {
    // The control. A constraint that rejected everything would pass the test above for the wrong
    // reason.
    const { id, phone } = await subscriber();
    await expect(
      recordSmsSend({
        subscriberId: id,
        phoneNumber: phone,
        sendType: 'weekly',
        outcome: 'sent',
        picksSnapshot: [{ occurrence_id: 'occ-1', rank: 1 }],
        twilioSid: 'SM_weekly_ok',
        consentTextVersion: TEST_CONSENT_VERSION,
      })
    ).resolves.toBeUndefined();
  });
});

describe('the "Last Friday" panel does not see an on-demand send', () => {
  it('a subscriber whose ONLY send is on-demand still reads as "we have not texted you"', async () => {
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id,
      phoneNumber: phone,
      sendType: 'instant_picks',
      outcome: 'sent',
      picksSnapshot: null,
      twilioSid: 'SM_instant_panel',
      consentTextVersion: TEST_CONSENT_VERSION,
    });

    // The button sits inside this panel. Its own press must not come back at the parent as though
    // we had decided to text them.
    expect((await findLastWeek(id)).kind).toBe('none');
  });

  it('an on-demand row written AFTER a weekly one does not displace it', async () => {
    // The sharper version: `findLastWeek` takes the most recent row of the types it selects. If
    // the IN-list ever grew, the newer on-demand row would shadow the real Friday send and the
    // panel would show the wrong thing rather than nothing — harder to notice than a blank panel.
    const { id, phone } = await subscriber();
    await recordSmsSend({
      subscriberId: id, phoneNumber: phone, sendType: 'weekly', outcome: 'sent',
      picksSnapshot: null, twilioSid: 'SM_weekly_first',
      consentTextVersion: TEST_CONSENT_VERSION,
    });
    await recordSmsSend({
      subscriberId: id, phoneNumber: phone, sendType: 'instant_picks', outcome: 'sent',
      picksSnapshot: null, twilioSid: 'SM_instant_after',
      consentTextVersion: TEST_CONSENT_VERSION,
    });

    expect((await findLastWeek(id)).kind).toBe('weekly');
  });
});

describe('migration 0048 · the send throttle can actually write its scopes', () => {
  it('both halves count, under the two new scope values', async () => {
    const { id } = await subscriber();
    const first = await checkAndRecordInstantPicksSend({
      subscriberId: id,
      ipAddress: '198.51.100.42',
    });
    expect(first.allowed).toBe(true);
    // ⚠ `degraded: false` IS THE ASSERTION THAT MATTERS HERE. The throttle catches a
    // `23514 check_violation` and — on this path — refuses. So a migration that had not widened
    // the scope CHECK would show up as `allowed: false, degraded: true`, i.e. a feature that
    // silently never sends. This is the only check that distinguishes "the limit ran" from "the
    // limit could not run".
    expect(first.degraded).toBe(false);

    const rows = await query<{ scope: string }>(
      `SELECT scope FROM sms_signup_throttle WHERE scope LIKE 'instant_picks_sms%' ORDER BY scope`
    );
    expect(rows.map((r) => r.scope)).toEqual(['instant_picks_sms', 'instant_picks_sms_ip']);
  });

  it('the second send within ten minutes is refused by the per-subscriber half', async () => {
    const { id } = await subscriber();
    await checkAndRecordInstantPicksSend({ subscriberId: id, ipAddress: null });
    const second = await checkAndRecordInstantPicksSend({ subscriberId: id, ipAddress: null });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('subscriber_interval');
    expect(second.degraded).toBe(false);
  });

  it('page presses and sends are counted on separate rows, never the same budget', async () => {
    const { id } = await subscriber();
    await checkAndRecordInstantPicksSend({ subscriberId: id, ipAddress: null });
    const rows = await query<{ scope: string }>(
      `SELECT DISTINCT scope FROM sms_signup_throttle WHERE scope LIKE 'instant_picks%'`
    );
    // The page counter uses scope 'instant_picks' and is untouched by a send.
    expect(rows.map((r) => r.scope)).not.toContain('instant_picks');
  });
});
