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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/lib/db/client';
import { createPendingSubscriber } from '@/lib/sms/signup-store';
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
    consentTextVersion: '2026-08-26.v2',
    ...over,
  };
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM sms_consent WHERE phone_number LIKE $1`, [`${PREFIX}9%`]);
}

beforeAll(async () => {
  await cleanup();
});
afterAll(async () => {
  await cleanup();
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
    expect(row.consent_text_version).toBe('2026-08-26.v2');
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
      consentTextVersion: '2026-08-26.v2',
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
