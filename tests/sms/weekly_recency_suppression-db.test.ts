// tests/sms/weekly_recency_suppression-db.test.ts — the Friday job must not text the same
// subscriber twice in a few days.
//
// ═══ WHY THIS EXISTS ═══
// `loadActiveSubscribers` had NO recency filter of any kind: it returned every active subscriber,
// every run, with nothing anywhere recording that one of them had been texted yesterday. That was
// harmless while the only trigger was a weekly cron. It stops being harmless the moment a
// subscriber can ask for their first picks on JOIN — a parent who signs up on a Thursday evening
// would get their picks that night and the Friday batch would text them again about fourteen hours
// later, against a disclosure that says "1 message per week".
//
// Worse than the duplicate, and the reason the window is a hard requirement rather than a polish
// item: the novelty filter would have excluded the picks the first message just used, so the
// Friday run could fall below FLOOR_PICKS, send an EMPTY_WEEK message instead, and increment
// consecutive_empty_weeks — three of which auto-pause the subscriber. The second message a new
// parent ever received would be "we found nothing this week", counted against them.
//
// ⚠ THE OPERATOR RUNS THIS LANE, NOT ME — the same standing caveat as
// signup_persistence-db.test.ts, and it applies in full here. I hold no write access to any
// database. There IS a postgres listening locally, and pointing this file at it would have been
// exactly the "DB-backed test suite aimed at the wrong database" failure that migration 0043's
// trigger exists to alarm on (and that has happened here before — Round 27). So this file is
// written blind against a schema that was read, not exercised. A green run is the Operator's
// evidence, not mine.
//
// SELF-CONTAINED AND SELF-CLEANING, keyed on a run-unique phone prefix and a marker
// consent_text_version, cleaned in beforeAll AND afterAll so a crashed run cannot poison the next.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
import {
  loadActiveSubscribers,
  RESEND_SUPPRESSION_WINDOW_DAYS,
} from '@/lib/sms/weekly-send-io';
import type { SmsSignup } from '@/lib/sms/signup-validate';

const PREFIX = '+1604555';
const TEST_CONSENT_VERSION = 'test-recency-suppression';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(8100 + seq++).padStart(4, '0')}`;

// NO `as SmsSignup` CAST HERE, and that is the point rather than a style preference. This helper
// originally ended `} as SmsSignup`, which silenced the compiler about TWO required fields it was
// missing — `consentMethod` and `regionId` — and every row this suite tried to create then failed
// on migration 0034's NOT NULL, returning `subscriberId: null`. Five of six tests failed against
// the suppression logic, which was correct the whole time. A cast that turns a compile error into
// a runtime one is worth more than the keystrokes it saves only when the shape is genuinely
// unknowable; here it was simply wrong, and it cost a db-lane round trip to find out.
function signup(over: Partial<SmsSignup> = {}): SmsSignup {
  return {
    phoneNumber: nextPhone(),
    postalCode: 'V5L 1A1',
    regionId: 'van',
    birthYears: [2018],
    categoryInterests: [],
    consentMethod: 'web_form',
    consentTextVersion: TEST_CONSENT_VERSION,
    ...over,
  };
}

async function cleanup() {
  await query(
    `DELETE FROM sms_send_log WHERE consent_text_version = $1
        OR subscriber_id IN (SELECT id FROM sms_consent WHERE consent_text_version = $1)`,
    [TEST_CONSENT_VERSION]
  );
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
  await query(
    `DELETE FROM sms_send_log WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE phone_number LIKE $1)`,
    [`${PREFIX}8%`]
  );
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}8%`]);
}

/** An ACTIVE subscriber — the state the Friday job selects on. */
async function activeSubscriber(): Promise<{ id: string; phone: string }> {
  const s = signup();
  const created = await createPendingSubscriber(s, { dryRun: false });
  await query(`UPDATE sms_consent SET status = 'active', confirmed_timestamp = now() WHERE id = $1`, [
    created.subscriberId,
  ]);
  return { id: created.subscriberId!, phone: s.phoneNumber };
}

/** A weekly send-log row `daysAgo` in the past — what suppression keys on. */
async function weeklySendAgo(subscriberId: string, daysAgo: number) {
  await query(
    `INSERT INTO sms_send_log
       (subscriber_id, phone_hash, phone_hash_version, send_type, picks_snapshot,
        outcome, consent_text_version, created_at)
     VALUES ($1, $2, 1, 'weekly', $3::jsonb, 'sent', $4, now() - make_interval(days => $5::int))`,
    [subscriberId, `hash-${subscriberId}`, JSON.stringify([{ occurrence_id: 'occ-1', rank: 1 }]),
     TEST_CONSENT_VERSION, daysAgo]
  );
}

const idsFrom = async () => (await loadActiveSubscribers()).map((a) => a.subscriber.id);

beforeAll(async () => {
  vi.stubEnv('SMS_PREFERENCES_SECRET', 'recency-preferences-secret');
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'recency-salt');
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

// ── (a) THE SILENCE REQUIREMENT, ASSERTED FIRST because it is the one that can hurt somebody ──
describe('suppression is completely silent', () => {
  it('writes NO row and touches NO counter for the subscriber it withholds', async () => {
    const { id } = await activeSubscriber();
    await weeklySendAgo(id, 1);

    const [before] = await query<{ consecutive_empty_weeks: number }>(
      `SELECT consecutive_empty_weeks FROM sms_consent WHERE id = $1`, [id]);
    const [logsBefore] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM sms_send_log WHERE subscriber_id = $1`, [id]);

    // The whole mechanism: the row never leaves the loader, so the send loop never sees it and
    // cannot write anything about it. If suppression is ever moved INTO the loop instead, this
    // test is what fails — because the loop's empty-week path would write a row and a counter.
    expect(await idsFrom()).not.toContain(id);

    const [after] = await query<{ consecutive_empty_weeks: number }>(
      `SELECT consecutive_empty_weeks FROM sms_consent WHERE id = $1`, [id]);
    const [logsAfter] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM sms_send_log WHERE subscriber_id = $1`, [id]);

    expect(after.consecutive_empty_weeks).toBe(before.consecutive_empty_weeks);
    expect(logsAfter.n).toBe(logsBefore.n);
  });

  it('leaves the subscriber ACTIVE — withheld for a week is not paused or stopped', async () => {
    const { id } = await activeSubscriber();
    await weeklySendAgo(id, 1);
    await idsFrom();
    const [row] = await query<{ status: string }>(`SELECT status FROM sms_consent WHERE id = $1`, [id]);
    expect(row.status).toBe('active');
  });
});

// ── the predicate itself ──
describe('the recency window', () => {
  it('withholds a subscriber texted inside the window', async () => {
    const { id } = await activeSubscriber();
    await weeklySendAgo(id, 1);
    expect(await idsFrom()).not.toContain(id);
  });

  it('RETURNS a subscriber whose last send is older than the window', async () => {
    // The case that must never regress: a normal Friday-to-Friday cadence is 7 days, and the
    // window is deliberately shorter so it can never swallow the weekly send itself.
    const { id } = await activeSubscriber();
    await weeklySendAgo(id, RESEND_SUPPRESSION_WINDOW_DAYS + 2);
    expect(await idsFrom()).toContain(id);
  });

  it('RETURNS a subscriber who has never been sent anything', async () => {
    // Vacuity guard: without this, a predicate that excluded everyone would pass every test above.
    const { id } = await activeSubscriber();
    expect(await idsFrom()).toContain(id);
  });

  it('ignores non-weekly send types — a welcome or a pause notice must not withhold picks', async () => {
    const { id } = await activeSubscriber();
    await query(
      `INSERT INTO sms_send_log
         (subscriber_id, phone_hash, phone_hash_version, send_type, outcome,
          consent_text_version, created_at)
       VALUES ($1, $2, 1, 'welcome', 'sent', $3, now())`,
      [id, `hash-${id}`, TEST_CONSENT_VERSION]
    );
    expect(await idsFrom()).toContain(id);
  });
});
