// tests/sms/signup_persistence-db.test.ts — Stage A against a REAL database.
//
// ═══ THIS IS THE FIRST TEST ON THIS BRANCH THAT WRITES A CONSENT ROW ═══
// Everything before it proved decisions against stubs. These four seams are the ones that make the
// signup → JOIN → welcome journey durable, and the row they write is the one a CASL complaint is
// answered from — so what is asserted here is not "the query runs" but "the row says what happened".
//
// ⚠ THE OPERATOR RUNS THIS LANE, NOT ME. I hold no write access to any database, including the
// local test instance, so this file is written blind against a schema I could only READ. Every
// statement it exercises was checked column-by-column against `information_schema` first, but a
// green run here is the Operator's evidence, not mine.
//
// SELF-CONTAINED AND SELF-CLEANING. The reconciliation that unblocked this stage was needed partly
// because the db lane had been leaving rows behind for months (176 of 249 venues were test
// residue). This file deletes every row it creates, keyed on a run-unique phone prefix, in
// `afterAll` AND defensively at the start — so a crashed run does not poison the next one.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '@/lib/db/client';
import {
  SIGNUP_THROTTLE_LIMITS,
  checkAndRecordSignupAttempt,
  createPendingSubscriber,
  type SignupThrottleLimits,
} from '@/lib/sms/signup-store';
import { phoneHash } from '@/lib/sms/phone-hash';
import {
  findSubscriberByPhone,
  applyConsentChange,
  decideConfirm,
  decideStop,
} from '@/lib/sms/consent-transitions';
import { loadWelcomeSubscriber } from '@/lib/sms/welcome';
import { mintPreferencesToken } from '@/lib/sms/preferences-token';
import type { SmsSignup } from '@/lib/sms/signup-validate';

// A NANP-valid block this suite owns outright, so cleanup can be exact and nothing else collides.
const PREFIX = '+1604555';
/** Stamped on every row this suite creates, and the key its cleanup uses. See below. */
const TEST_CONSENT_VERSION = 'test-stage-a';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(9000 + seq++).padStart(4, '0')}`;

function signup(over: Partial<SmsSignup> = {}): SmsSignup {
  return {
    phoneNumber: nextPhone(),
    postalCode: 'V5L 1A1',
    regionId: 'van',
    birthYears: [2021, 2016],
    categoryInterests: ['public_swim'],
    consentMethod: 'web_form',
    consentTextVersion: TEST_CONSENT_VERSION,
    ...over,
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
    [`${PREFIX}9%`]
  );
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}9%`]);
  /*
   * ═══ THE THROTTLE COUNTERS, AND WHY THIS ONE DELETE IS UNSCOPED ═══
   * Every other statement in this function is keyed, because its table has other writers. This
   * one is not, and the exception is argued rather than assumed:
   *
   *   • `sms_signup_throttle` (0045) has exactly ONE writer in the entire repo —
   *     `checkAndRecordSignupAttempt`, on the signup path — and exactly one test suite that
   *     reaches it, which is this file. There is no neighbour whose rows this could delete.
   *   • Its rows are not keyable from outside the store anyway. `subject_hash` is an HMAC, so
   *     there is no `phone_number LIKE` equivalent, and the ip subject is not derivable here at
   *     all without restating the store's own construction — a copy that could drift silently and
   *     would then leak exactly the rows it was written to sweep.
   *   • A WRITE-TIME sweep was tried first and is WRONG, which is worth recording because it looks
   *     right: `nextPhone()` regenerates the same numbers on every run, so a row left by
   *     YESTERDAY's run collides with today's subject while sitting outside any "since this run
   *     started" window. That failed as a stale `attempts` count on the second run, not the first.
   *
   * ⚠ IF A SECOND WRITER EVER APPEARS — an admin tool, a retention job's own fixtures — this must
   * become a keyed delete before that suite is written, or the two will silently delete each
   * other's rows in the shared db lane.
   */
  await query(`DELETE FROM sms_signup_throttle`);
}

beforeAll(async () => {
  // Self-sufficient: this suite asserts the minted preferences token, so it must not depend on the
  // secret happening to be present in whoever's shell runs the lane.
  vi.stubEnv('SMS_PREFERENCES_SECRET', 'stage-a-preferences-secret');
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'stage-a-salt');
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('createPendingSubscriber', () => {
  it('writes a real pending row with everything the signup carried', async () => {
    const s = signup();
    const result = await createPendingSubscriber(s, { dryRun: false });
    expect(result.outcome).toBe('created');
    expect(result.subscriberId).toBeTruthy();

    const [row] = await query<Record<string, unknown>>(
      `SELECT phone_number, postal_code, birth_years, category_interests, status,
              consent_method, consent_text_version, consecutive_empty_weeks,
              confirmed_timestamp, stopped_at, preferences_token, short_ref
         FROM sms_consent WHERE id = $1`,
      [result.subscriberId]
    );
    expect(row.phone_number).toBe(s.phoneNumber);
    expect(row.postal_code).toBe('V5L 1A1');
    expect(row.birth_years).toEqual([2021, 2016]);
    expect(row.category_interests).toEqual(['public_swim']);
    // PENDING, NEVER ACTIVE. Only a JOIN may activate — the whole value of the double opt-in is
    // that nobody can subscribe a number they do not hold.
    expect(row.status).toBe('pending');
    expect(row.confirmed_timestamp).toBeNull();
    expect(row.consent_text_version).toBe(TEST_CONSENT_VERSION);
    // short_ref is GENERATED ALWAYS AS IDENTITY — the subscriber half of every short link.
    expect(Number(row.short_ref)).toBeGreaterThan(0);
    // And the token was minted from the id the database assigned.
    expect(row.preferences_token).toBe(mintPreferencesToken(result.subscriberId as string));
  });

  it('UPSERTS on a resubmitted number instead of raising 23505', async () => {
    // A parent fixing a typo, a stopped subscriber returning, a double-tapped submit — all three
    // are legitimate and none is an error a form should show. Consent is per NUMBER, not per row.
    const s = signup();
    const first = await createPendingSubscriber(s, { dryRun: false });
    const second = await createPendingSubscriber(
      { ...s, postalCode: 'V6B 1A1', birthYears: [2019] },
      { dryRun: false }
    );

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('reactivated');
    expect(second.subscriberId).toBe(first.subscriberId); // same row, not a second one

    const [row] = await query<Record<string, unknown>>(
      `SELECT postal_code, birth_years, preferences_token FROM sms_consent WHERE id = $1`,
      [first.subscriberId]
    );
    expect(row.postal_code).toBe('V6B 1A1'); // the correction landed
    expect(row.birth_years).toEqual([2019]);
    // AND THEY KEEP THE LINK THEY ALREADY HAVE. Re-minting would silently break the hub link in
    // every message already sent to them.
    expect(row.preferences_token).toBe(mintPreferencesToken(first.subscriberId as string));

    const [{ count }] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sms_consent WHERE phone_number = $1`,
      [s.phoneNumber]
    );
    expect(count).toBe('1');
  });

  it('RESETS a returning subscriber to the start of the double opt-in', async () => {
    // A resubmission is a fresh act of express consent, so it must not inherit a confirmation or a
    // stop from the previous life of the row.
    const s = signup();
    const first = await createPendingSubscriber(s, { dryRun: false });
    await query(
      `UPDATE sms_consent
          SET status='stopped', stopped_at=now(), confirmed_timestamp=now(),
              consecutive_empty_weeks=3
        WHERE id=$1`,
      [first.subscriberId]
    );

    await createPendingSubscriber(s, { dryRun: false });
    const [row] = await query<Record<string, unknown>>(
      `SELECT status, stopped_at, confirmed_timestamp, consecutive_empty_weeks
         FROM sms_consent WHERE id = $1`,
      [first.subscriberId]
    );
    expect(row.status).toBe('pending');
    expect(row.stopped_at).toBeNull();
    expect(row.confirmed_timestamp).toBeNull();
    expect(row.consecutive_empty_weeks).toBe(0);
  });

  // ═══ WHAT A RESUBMISSION OVERWRITES (the `prior` CTE, commit 62f3d1c) ═══
  // These two flags exist so a resubmitting parent can be warned about a loss they cannot
  // currently see. NOTHING CONSUMES THEM YET — the warning's copy is blocked on a leak-vector
  // ruling — which is exactly why they need coverage now: unconsumed logic is what rots silently,
  // and both flags depend on a `!inserted` guard whose failure mode is INVISIBLE (it reports every
  // brand-new signup as having replaced preferences it never had).

  it('reports NOTHING replaced for a brand-new number — the !inserted guard', async () => {
    // 🔴 THE GUARD'S WHOLE PURPOSE. On the INSERT branch the `prior` CTE selects zero rows, so
    // every `IS DISTINCT FROM` against it answers TRUE. Without `!inserted` this returns
    // preferencesReplaced: true for a first-time signup that replaced nothing whatsoever — and it
    // would look completely correct in the SQL. Drop the guard and only this test notices.
    const result = await createPendingSubscriber(signup(), { dryRun: false });
    expect(result.outcome).toBe('created');
    expect(result.wasActive).toBe(false);
    expect(result.preferencesReplaced).toBe(false);
  });

  it('reports preferences REPLACED when a resubmission changes them', async () => {
    const s = signup();
    await createPendingSubscriber(s, { dryRun: false });
    const second = await createPendingSubscriber(
      { ...s, categoryInterests: ['public_swim', 'library'], birthYears: [2018] },
      { dryRun: false }
    );
    expect(second.outcome).toBe('reactivated');
    expect(second.preferencesReplaced).toBe(true);
  });

  it('reports preferences NOT replaced when a resubmission is identical', async () => {
    // The double-tapped submit. It is still an UPDATE — so `inserted` is false and the row is
    // rewritten — but nothing the parent cares about changed, and warning them would be a lie.
    // This is the case that a `!inserted`-only implementation gets wrong.
    const s = signup();
    await createPendingSubscriber(s, { dryRun: false });
    const second = await createPendingSubscriber(s, { dryRun: false });
    expect(second.outcome).toBe('reactivated');
    expect(second.preferencesReplaced).toBe(false);
  });

  it('detects a replacement in EACH of the three compared fields independently', async () => {
    // Three ORed `IS DISTINCT FROM` terms. A typo in any one of them still passes a test that only
    // ever varies interests, so each field is varied on its own against an otherwise identical
    // resubmission.
    for (const change of [
      { postalCode: 'V6B 1A1' },
      { birthYears: [2014] },
      { categoryInterests: ['library'] },
    ]) {
      const s = signup();
      await createPendingSubscriber(s, { dryRun: false });
      const second = await createPendingSubscriber({ ...s, ...change }, { dryRun: false });
      expect(second.preferencesReplaced, `changing ${Object.keys(change)[0]}`).toBe(true);
    }
  });

  it('🔴 REFUSES to downgrade an active subscriber — the row is not touched at all', async () => {
    // ═══ THE DEFECT, AND THE INVERSION OF THIS TEST ═══
    // This test used to ASSERT the downgrade: an ACTIVE subscriber who resubmitted was knocked
    // back to `pending`, lost `confirmed_timestamp`, had their stored preferences overwritten and
    // was sent another confirmation SMS — and `wasActive` merely REPORTED that it had happened.
    // Since the form is unauthenticated, the person doing the resubmitting need not be the
    // subscriber, which made a public form a way to unsubscribe a stranger and text their handset.
    //
    // The upsert's conflict action now carries `WHERE sms_consent.status <> 'active'`, so the
    // whole branch is skipped and NOTHING about the row changes. What is asserted below is every
    // column that used to move.
    const activeOne = signup();
    const created = await createPendingSubscriber(activeOne, { dryRun: false });
    await query(`UPDATE sms_consent SET status='active', confirmed_timestamp=now() WHERE id=$1`, [
      created.subscriberId,
    ]);
    const [before] = await query<Record<string, unknown>>(
      `SELECT status, confirmed_timestamp, consent_timestamp, postal_code, birth_years,
              category_interests, stopped_at, consecutive_empty_weeks
         FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );

    // A resubmission that ALSO tries to change every stored preference, because "left alone" has
    // to mean the data too — an anonymous caller must not be able to edit somebody's subscription.
    const resubmitted = await createPendingSubscriber(
      { ...activeOne, postalCode: 'V6B 1A1', birthYears: [2010], categoryInterests: ['library'] },
      { dryRun: false }
    );
    expect(resubmitted.outcome).toBe('already_active');
    expect(resubmitted.wasActive).toBe(true);
    expect(resubmitted.preferencesReplaced).toBe(false);
    // No id goes back on this path — nothing downstream sends or logs anything for it.
    expect(resubmitted.subscriberId).toBeNull();

    const [after] = await query<Record<string, unknown>>(
      `SELECT status, confirmed_timestamp, consent_timestamp, postal_code, birth_years,
              category_interests, stopped_at, consecutive_empty_weeks
         FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );
    expect(after).toEqual(before);
    expect(after.status).toBe('active');
  });

  it('still reactivates a PENDING resubmitter — only `active` is exempt', async () => {
    // The exemption is narrow on purpose. A pending row has never been confirmed, so re-stamping
    // consent and re-sending the confirmation is exactly right for it, and `wasActive` stays
    // false because they were not receiving anything to lose.
    const pendingOne = signup();
    const first = await createPendingSubscriber(pendingOne, { dryRun: false });
    const stillPending = await createPendingSubscriber(pendingOne, { dryRun: false });
    expect(stillPending.outcome).toBe('reactivated');
    expect(stillPending.wasActive).toBe(false);
    expect(stillPending.subscriberId).toBe(first.subscriberId);
  });

  it('still revives a STOPPED subscriber into pending — they are opting in again', async () => {
    // A stopped row IS the case the upsert was written for: consent is per number, so a re-signup
    // must reuse the row, clear `stopped_at`, and go back through the double opt-in.
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    await query(`UPDATE sms_consent SET status='stopped', stopped_at=now() WHERE id=$1`, [
      created.subscriberId,
    ]);
    const second = await createPendingSubscriber(s, { dryRun: false });
    expect(second.outcome).toBe('reactivated');
    const [row] = await query<Record<string, unknown>>(
      `SELECT status, stopped_at FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );
    expect(row.status).toBe('pending');
    expect(row.stopped_at).toBeNull();
  });

  it('reports wasActive for a STOPPED subscriber as false — they were not receiving texts', async () => {
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    await query(`UPDATE sms_consent SET status='stopped', stopped_at=now() WHERE id=$1`, [
      created.subscriberId,
    ]);
    const second = await createPendingSubscriber(s, { dryRun: false });
    expect(second.wasActive).toBe(false);
  });

  it('writes NOTHING on a dry run', async () => {
    const s = signup();
    const result = await createPendingSubscriber(s, { dryRun: true });
    expect(result).toEqual({ outcome: 'dry_run', subscriberId: null });
    const [{ count }] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sms_consent WHERE phone_number = $1`,
      [s.phoneNumber]
    );
    expect(count).toBe('0');
  });

  it('never lets the phone number reach an error string', async () => {
    // Postgres quotes the offending value on a constraint violation. This result is returned to a
    // route that reports failures, so a raw driver message would put a subscriber's number in a log.
    const s = signup({ postalCode: 'x'.repeat(400) }); // no length limit; force a different failure
    const result = await createPendingSubscriber(
      { ...s, consentMethod: 'not-a-method' as SmsSignup['consentMethod'] },
      { dryRun: false }
    );
    expect(result.outcome).toBe('error');
    expect(JSON.stringify(result)).not.toContain(s.phoneNumber.slice(-7));
  });
});

describe('findSubscriberByPhone', () => {
  it('returns the three-field ConsentRow and NOTHING else', async () => {
    // The round-5 PII property, enforced by the SELECT list rather than by convention.
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    const row = await findSubscriberByPhone(s.phoneNumber);
    expect(row).toEqual({ id: created.subscriberId, status: 'pending', stoppedAt: null });
    expect(Object.keys(row!).sort()).toEqual(['id', 'status', 'stoppedAt']);
  });

  it('finds nothing for a number nobody signed up with', async () => {
    expect(await findSubscriberByPhone(`${PREFIX}9999`)).toBeNull();
  });

  it('is INVISIBLE to the 30-day purge, by construction', async () => {
    // Migration 0034's purge NULLs phone_number in place rather than deleting the row, so a purged
    // subscriber cannot match this WHERE clause. Every "after the purge" case resolves to null
    // through here without anything testing for a purge.
    const s = signup();
    await createPendingSubscriber(s, { dryRun: false });
    await query(`UPDATE sms_consent SET phone_number = NULL WHERE phone_number = $1`, [s.phoneNumber]);
    expect(await findSubscriberByPhone(s.phoneNumber)).toBeNull();
  });
});

describe('applyConsentChange — the compare-and-set', () => {
  it('applies a JOIN and stamps the consent record correctly', async () => {
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    const row = await findSubscriberByPhone(s.phoneNumber);
    const decision = decideConfirm(row);
    expect(decision.outcome).toBe('applied');
    if (decision.outcome !== 'applied') return;

    const now = new Date();
    expect(await applyConsentChange(decision.change, now)).toBe('applied');

    const [after] = await query<Record<string, unknown>>(
      `SELECT status, confirmed_timestamp, stopped_at, consecutive_empty_weeks
         FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );
    expect(after.status).toBe('active');
    expect(after.confirmed_timestamp).not.toBeNull(); // the double-opt-in reply, recorded
    expect(after.stopped_at).toBeNull();
  });

  it('🔴 REFUSES the second of two concurrent JOINs — one welcome, not two', async () => {
    // The race round 18 designed this contract for. Both passes read `pending` and both decide
    // `applied`; the predicate is what makes only one of them write. Without it the inbound route
    // would send two welcome texts for one JOIN.
    const s = signup();
    await createPendingSubscriber(s, { dryRun: false });
    const row = await findSubscriberByPhone(s.phoneNumber);
    const a = decideConfirm(row);
    const b = decideConfirm(row); // same read, as a duplicate webhook would produce
    if (a.outcome !== 'applied' || b.outcome !== 'applied') throw new Error('expected applied');

    expect(await applyConsentChange(a.change, new Date())).toBe('applied');
    expect(await applyConsentChange(b.change, new Date())).toBe('no_match');
  });

  it('does not re-stamp stopped_at on a repeat STOP', async () => {
    // COALESCE, not a bare now(): re-stamping would push the 30-day purge deadline out every time
    // a duplicate STOP arrived — a retention promise quietly extended by a retry.
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    const first = decideStop(await findSubscriberByPhone(s.phoneNumber));
    if (first.outcome !== 'applied') throw new Error('expected applied');
    await applyConsentChange(first.change, new Date());

    const [{ stopped_at: original }] = await query<{ stopped_at: Date }>(
      `SELECT stopped_at FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );
    // Force the same change through again, as a replayed webhook would.
    await applyConsentChange(
      { ...first.change, expectedStatus: 'stopped' },
      new Date(Date.now() + 60_000)
    );
    const [{ stopped_at: after }] = await query<{ stopped_at: Date }>(
      `SELECT stopped_at FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );
    expect(new Date(after).getTime()).toBe(new Date(original).getTime());
  });

  it('a START must NOT re-stamp the consent record', async () => {
    // START is a carrier resume signal, not a fresh act of express consent. Re-stamping
    // consent_timestamp would record a consent act that never happened, in the columns an audit
    // reads. `reconsent: false` is what prevents it — asserted against the real row.
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    await query(`UPDATE sms_consent SET status='stopped', stopped_at=now() WHERE id=$1`, [
      created.subscriberId,
    ]);
    const [{ consent_timestamp: before }] = await query<{ consent_timestamp: Date }>(
      `SELECT consent_timestamp FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );

    await applyConsentChange(
      {
        subscriberId: created.subscriberId as string,
        expectedStatus: 'stopped',
        status: 'active',
        stoppedAt: 'clear',
        reconsent: false,
        confirm: false,
      },
      new Date(Date.now() + 60_000)
    );

    const [after] = await query<Record<string, unknown>>(
      `SELECT status, consent_timestamp, stopped_at FROM sms_consent WHERE id = $1`,
      [created.subscriberId]
    );
    expect(after.status).toBe('active');
    expect(after.stopped_at).toBeNull();
    expect(new Date(after.consent_timestamp as string).getTime()).toBe(new Date(before).getTime());
  });
});

describe('loadWelcomeSubscriber', () => {
  it('loads exactly what the welcome text needs, from the stored row', async () => {
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    const loaded = await loadWelcomeSubscriber(created.subscriberId as string);
    expect(loaded).toEqual({
      id: created.subscriberId,
      phoneNumber: s.phoneNumber,
      postalCode: 'V5L 1A1',
      birthYears: [2021, 2016],
      preferencesToken: mintPreferencesToken(created.subscriberId as string),
      consentTextVersion: TEST_CONSENT_VERSION,
    });
  });

  it('returns null for a PURGED row rather than a subscriber with no number', async () => {
    // The purge NULLs the personal columns in place, so the row still exists. Without this guard
    // `dispatchSms` would be handed null as a recipient and the type would be lying.
    const s = signup();
    const created = await createPendingSubscriber(s, { dryRun: false });
    await query(`UPDATE sms_consent SET phone_number = NULL WHERE id = $1`, [created.subscriberId]);
    expect(await loadWelcomeSubscriber(created.subscriberId as string)).toBeNull();
  });

  it('returns null for an id that does not exist', async () => {
    expect(await loadWelcomeSubscriber('11111111-1111-1111-1111-111111111111')).toBeNull();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE SIGNUP THROTTLE, AGAINST REAL SQL (migration 0045)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// tests/sms/signup_throttle.test.ts pins the DECISION logic against an in-memory model of the
// upsert. This block is the other half, and it is the half that cannot be faked: the model is
// only worth anything if `ON CONFLICT ... DO UPDATE ... WHERE` really behaves the way it claims.
// Three things are executed here and nowhere else —
//
//   • a refused attempt returns ZERO ROWS rather than a row with an unchanged count;
//   • a refused attempt leaves `last_attempt_at` and `attempts` untouched;
//   • CONCURRENT attempts for the same number do not both win.
//
// The last one is the entire reason this table is a counter and not an append-only log, and it is
// invisible to any single-threaded test.
describe('checkAndRecordSignupAttempt against a real sms_signup_throttle', () => {
  /** Tight limits so a test does not have to wait ten minutes to observe the interval rule. */
  const limits: SignupThrottleLimits = {
    phoneMinIntervalSeconds: 60,
    phonePerDay: 2,
    ipMinIntervalSeconds: 0,
    ipPerDay: 100,
  };

  /** Live, with the suite's own limits, and never through the shared default pool options. */
  const attempt = (phoneNumber: string, ipAddress: string | null = null) =>
    checkAndRecordSignupAttempt({ phoneNumber, ipAddress }, { dryRun: false, limits });

  const subjectOf = (phoneNumber: string) => phoneHash(phoneNumber) as string;

  it('lets the first attempt through and writes exactly one counter row', async () => {
    const phone = nextPhone();
    expect((await attempt(phone)).allowed).toBe(true);
    const [row] = await query<{ attempts: number; scope: string }>(
      `SELECT scope, attempts FROM sms_signup_throttle WHERE subject_hash = $1`,
      [subjectOf(phone)]
    );
    expect(row).toMatchObject({ scope: 'phone', attempts: 1 });
  });

  it('🔴 refuses the second attempt inside the interval, and does not touch the row', async () => {
    // The `WHERE` on the conflict action. If it were missing, this would return a row with
    // attempts: 2 and the throttle would be a counter that never says no.
    const phone = nextPhone();
    await attempt(phone);
    const [before] = await query<{ attempts: number; last_attempt_at: Date }>(
      `SELECT attempts, last_attempt_at FROM sms_signup_throttle WHERE subject_hash = $1`,
      [subjectOf(phone)]
    );

    const refused = await attempt(phone);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('phone_interval');
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(limits.phoneMinIntervalSeconds);

    const [after] = await query<{ attempts: number; last_attempt_at: Date }>(
      `SELECT attempts, last_attempt_at FROM sms_signup_throttle WHERE subject_hash = $1`,
      [subjectOf(phone)]
    );
    // Untouched, so hammering cannot extend the caller's own lockout.
    expect(after.attempts).toBe(before.attempts);
    expect(after.last_attempt_at.getTime()).toBe(before.last_attempt_at.getTime());
  });

  it('refuses on the DAILY cap once the interval is no longer what is stopping them', async () => {
    const phone = nextPhone();
    await attempt(phone);
    // Age the row past the interval without waiting for it, the same way the rest of this suite
    // ages a consent row: the clock is not what is under test here, the predicate is.
    const age = async () =>
      query(`UPDATE sms_signup_throttle SET last_attempt_at = now() - interval '1 hour'
              WHERE subject_hash = $1`, [subjectOf(phone)]);
    await age();
    expect((await attempt(phone)).allowed).toBe(true); // second of two allowed per day
    await age();
    const refused = await attempt(phone);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('phone_daily');
    // Until the UTC day rolls over — never zero, and never more than a whole day.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it('🔴 lets exactly ONE of eight simultaneous attempts through', async () => {
    // ═══ THE REASON THIS IS A COUNTER AND NOT A LOG ═══
    // `SELECT count(*)` then `INSERT` would let all eight through: every one of them takes its
    // snapshot before any of them writes, so every one sees zero prior attempts. That is not a
    // theoretical race on a serverless endpoint — it is one line of shell, and it would put eight
    // confirmation texts on somebody's handset. `ON CONFLICT DO UPDATE` takes a row lock, so the
    // seven losers block, re-read the row the winner committed, and are refused by its `WHERE`.
    const phone = nextPhone();
    const results = await Promise.all(Array.from({ length: 8 }, () => attempt(phone)));
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === 'phone_interval')).toBe(true);

    const [row] = await query<{ attempts: number }>(
      `SELECT attempts FROM sms_signup_throttle WHERE subject_hash = $1`,
      [subjectOf(phone)]
    );
    expect(row.attempts).toBe(1);
  });

  it('counts a phone and an IP as separate subjects, and never stores either in the clear', async () => {
    const phone = nextPhone();
    await attempt(phone, '203.0.113.9');
    const rows = await query<{ scope: string; subject_hash: string }>(
      // Both rows this one call wrote: the phone subject we can name, and the ip subject we
      // cannot — which is the whole reason the scope column is read back rather than assumed.
      `SELECT scope, subject_hash FROM sms_signup_throttle
        WHERE subject_hash = $1 OR scope = 'ip'`,
      [subjectOf(phone)]
    );
    expect(rows.some((r) => r.scope === 'phone')).toBe(true);
    expect(rows.some((r) => r.scope === 'ip')).toBe(true);
    // Same salt, different domain prefix — one call must not produce one shared subject.
    expect(new Set(rows.map((r) => r.subject_hash)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.subject_hash).not.toContain(phone);
      expect(row.subject_hash).not.toContain('203.0.113.9');
      expect(row.subject_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the production limits are the ones Jon asked for', async () => {
    // Pinned here rather than only in the unit lane so that loosening them is a visible diff in
    // the file the Operator reads when a throttle complaint arrives.
    expect(SIGNUP_THROTTLE_LIMITS.phoneMinIntervalSeconds).toBe(600);
    expect(SIGNUP_THROTTLE_LIMITS.phonePerDay).toBe(3);
  });
});
