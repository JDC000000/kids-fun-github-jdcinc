// tests/admin/sms-subscribers-db.test.ts — the subscriber list read model, against a real database.
//
// Skips when DATABASE_URL is unset, like the other admin DB tests. Inserts its own rows and
// removes exactly what it inserted, so it is safe against a populated staging database as well as
// an empty CI one — every assertion is scoped to this run's own consent_text_version marker rather
// than to global counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getSmsSubscriberDetail,
  getSmsSubscribers,
  summariseSubscribers,
} from '../../lib/admin/sms-subscribers';
import { phoneHash } from '../../lib/sms/phone-hash';
import { vi } from 'vitest';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `test-sms-subscribers-${Date.now()}`;

describe.skipIf(!hasDb)('SMS subscriber list read model', () => {
  beforeAll(async () => {
    await query(
      `INSERT INTO sms_consent
         (phone_number, status, consent_method, consent_text_version, consent_timestamp,
          postal_code, birth_years)
       VALUES ($1, 'active', 'web_form', $2, now() - interval '1 hour', 'V5N 1A1', $3::int[])`,
      ['+16045550188', MARKER, [2019, 2022]]
    );
    // A PURGED row: stopped, personal columns erased in place, consent record retained. This is
    // the case the whole `purged` flag exists for, and the one an admin page most easily gets
    // wrong by rendering an empty cell that looks like a fault.
    await query(
      `INSERT INTO sms_consent
         (phone_number, status, consent_method, consent_text_version, consent_timestamp, stopped_at)
       VALUES (NULL, 'stopped', 'sms_start', $1, now() - interval '2 hours', now())`,
      [MARKER]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [MARKER]);
    await closePool();
  });

  it('returns both rows with the columns the page renders', async () => {
    const mine = (await getSmsSubscribers({ redactPersonalData: false })).filter((r) => r.phoneNumber === '+16045550188');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'active', consentMethod: 'web_form', purged: false });
    expect(mine[0].consentTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('🔴 selects postal_code and birth_years — the two columns Jon asked to see', async () => {
    // These were absent from the SELECT entirely until 2026-09-18. A test that only checked the
    // TypeScript interface would have passed the whole time the query never asked for them.
    const [mine] = (await getSmsSubscribers({ redactPersonalData: false })).filter((r) => r.phoneNumber === '+16045550188');
    expect(mine.postalCode).toBe('V5N 1A1');
    expect(mine.birthYears).toEqual([2019, 2022]);
  });

  it('🔴 hands birth_years back as real numbers, not strings', async () => {
    // int[] round-tripping through node-postgres as ['2019','2022'] would make every age NaN and
    // still render a plausible-looking cell. Asserted at the boundary, like short_ref above.
    const [mine] = (await getSmsSubscribers({ redactPersonalData: false })).filter((r) => r.phoneNumber === '+16045550188');
    for (const y of mine.birthYears ?? []) expect(typeof y).toBe('number');
  });

  it('🔴 a purged row has postal_code and birth_years erased ALONGSIDE the phone', async () => {
    // lib/retention/sms.ts NULLs all of them in ONE statement. That is what makes the `purged`
    // flag — derived from phone_number alone — authoritative for the two new columns too, rather
    // than an inference the UI is quietly making on its own.
    for (const r of (await getSmsSubscribers({ redactPersonalData: false })).filter((r) => r.purged)) {
      expect(r.phoneNumber).toBeNull();
      expect(r.postalCode).toBeNull();
      expect(r.birthYears).toBeNull();
    }
  });

  it('🔴 reports an erased row as purged, not as a missing phone number', async () => {
    const rows = await getSmsSubscribers({ redactPersonalData: false });
    const purged = rows.filter((r) => r.purged);
    expect(purged.length).toBeGreaterThanOrEqual(1);
    for (const r of purged) {
      expect(r.phoneNumber).toBeNull();
      // The consent record SURVIVES the purge — that is the point of erasing in place.
      expect(r.status).toBeTruthy();
      expect(r.consentTimestamp).toBeTruthy();
    }
  });

  it('normalises short_ref to a string — pg returns bigint as text', async () => {
    // A bigint silently becoming a JS number is a precision bug that only appears past 2^53, i.e.
    // never in testing and eventually in production. Asserted at the boundary instead.
    for (const r of await getSmsSubscribers({ redactPersonalData: false })) {
      expect(typeof r.shortRef).toBe('string');
      expect(r.shortRef).toMatch(/^\d+$/);
    }
  });

  it('orders newest consent first', async () => {
    const times = (await getSmsSubscribers({ redactPersonalData: false }))
      .map((r) => r.consentTimestamp)
      .filter((t): t is string => t !== null);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
  });

  it('the summary agrees with the rows it was given', async () => {
    const rows = await getSmsSubscribers({ redactPersonalData: false });
    const s = summariseSubscribers(rows);
    expect(s.total).toBe(rows.length);
    expect(s.active + s.pending + s.paused + s.stopped).toBeLessThanOrEqual(s.total);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PAGE 2 — the cross-signup history, which is the whole reason the hash key exists.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasDb)('one subscriber\'s full send history', () => {
  const SALT = 'test-salt-for-subscriber-detail';
  const NUMBER = '+16045550199';
  const M2 = `${MARKER}-detail`;
  const ids: { purgedOld: string; liveNew: string } = { purgedOld: '', liveNew: '' };
  let hash: string;

  beforeAll(async () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
    hash = phoneHash(NUMBER) as string;

    // The OLD signup, since purged: personal columns erased IN PLACE, consent record retained.
    const [old] = await query<{ id: string }>(
      `INSERT INTO sms_consent (phone_number, status, consent_method, consent_text_version,
                                consent_timestamp, stopped_at)
       VALUES (NULL, 'stopped', 'web_form', $1, now() - interval '90 days', now() - interval '60 days')
       RETURNING id`,
      [M2]
    );
    ids.purgedOld = old.id;

    // The SAME PERSON signing up again later. New row, new id, same number.
    const [fresh] = await query<{ id: string }>(
      `INSERT INTO sms_consent (phone_number, status, consent_method, consent_text_version,
                                consent_timestamp)
       VALUES ($1, 'active', 'web_form', $2, now() - interval '1 day')
       RETURNING id`,
      [NUMBER, M2]
    );
    ids.liveNew = fresh.id;

    for (const [subId, when] of [
      [ids.purgedOld, '89 days'],
      [ids.liveNew, '12 hours'],
    ] as const) {
      await query(
        `INSERT INTO sms_send_log (subscriber_id, phone_hash, send_type, outcome,
                                   consent_text_version, created_at)
         VALUES ($1::uuid, $2, 'weekly', 'sent', $3, now() - $4::interval)`,
        [subId, hash, M2, when]
      );
    }
  });

  afterAll(async () => {
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [M2]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [M2]);
    vi.unstubAllEnvs();
  });

  it('🔴 shows the LIVE subscriber the history from their earlier, purged signup', () => {
    // This is the ruling. subscriber_id alone answers "what happened to this ROW"; the question
    // the page is for is "what happened to this PERSON", and only phone_hash joins the two.
    return getSmsSubscriberDetail(ids.liveNew, { redactPersonalData: false }).then((d) => {
      expect(d).not.toBeNull();
      expect(d!.sends).toHaveLength(2);
      expect(d!.sends.filter((r) => !r.linkedToThisRow)).toHaveLength(1);
    });
  });

  it('🔴 shows the PURGED subscriber both rows too — hash recovered from its own log row', () => {
    // The trap this covers: a purged row has phone_number = NULL, so phoneHash() cannot be
    // recomputed for it. The hash is read back off the rows it still owns via subscriber_id.
    return getSmsSubscriberDetail(ids.purgedOld, { redactPersonalData: false }).then((d) => {
      expect(d!.purged).toBe(true);
      expect(d!.subscriber.phoneNumber).toBeNull();
      expect(d!.sends).toHaveLength(2);
    });
  });

  it('marks which rows belong to the record being viewed', async () => {
    const d = await getSmsSubscriberDetail(ids.liveNew, { redactPersonalData: false });
    const own = d!.sends.filter((r) => r.linkedToThisRow);
    expect(own).toHaveLength(1);
    expect(own[0].sendType).toBe('weekly');
  });

  it('never returns the phone hash in any field', async () => {
    // The salt is global and the keyspace is small, so the hash must not cross this boundary.
    const d = await getSmsSubscriberDetail(ids.liveNew, { redactPersonalData: false });
    expect(JSON.stringify(d)).not.toContain(hash);
  });

  it('returns null for an id that is not a subscriber', async () => {
    expect(await getSmsSubscriberDetail('00000000-0000-4000-8000-000000000000', { redactPersonalData: false })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 🔴 THE PREVIEW IS READ-ONLY — PROVED AGAINST A REAL DATABASE, NOT ONLY AGAINST SOURCE
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// tests/admin/sms-preview-logic.test.ts asserts the module imports no mutator. That is the guard
// that survives refactors, but it is an argument about code. This is the observation: take a real
// subscriber, snapshot every column the weekly job would move, render the preview, and check that
// nothing moved. If the two ever disagree, believe this one.
describe.skipIf(!hasDb)('🔴 previewing a subscriber mutates nothing', () => {
  const M3 = `${MARKER}-preview`;
  const NUMBER = '+16045550177';
  let id = '';

  beforeAll(async () => {
    vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-preview-short-link-secret');
    vi.stubEnv('SMS_PREFERENCES_SECRET', 'test-preview-preferences-secret');
    const [row] = await query<{ id: string }>(
      `INSERT INTO sms_consent (phone_number, status, consent_method, consent_text_version,
                                consent_timestamp, confirmed_timestamp, postal_code, birth_years,
                                consecutive_empty_weeks)
       VALUES ($1, 'active', 'web_form', $2, now() - interval '10 days',
               now() - interval '10 days', 'V5N 1A1', $3::int[], 2)
       RETURNING id`,
      [NUMBER, M3, [2019, 2022]]
    );
    id = row.id;
  });

  afterAll(async () => {
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [M3]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [M3]);
    vi.unstubAllEnvs();
  });

  it('leaves every column the weekly job writes exactly as it found them', async () => {
    const { previewWeeklySmsForSubscriber } = await import('../../lib/admin/sms-preview');

    const snapshot = async () =>
      (
        await query<{
          status: string;
          consecutive_empty_weeks: number;
          stopped_at: Date | null;
          phone_number: string | null;
          postal_code: string | null;
        }>(
          `SELECT status, consecutive_empty_weeks, stopped_at, phone_number, postal_code
             FROM sms_consent WHERE id = $1::uuid`,
          [id]
        )
      )[0];
    const sendCount = async () =>
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*)::text AS n FROM sms_send_log WHERE subscriber_id = $1::uuid`,
            [id]
          )
        )[0].n
      );

    const before = await snapshot();
    const sendsBefore = await sendCount();

    const result = await previewWeeklySmsForSubscriber(id, new Date());

    const after = await snapshot();
    const sendsAfter = await sendCount();

    // The counter the empty-week/pause machinery moves. Seeded at 2 rather than 0 so an
    // accidental RESET would be caught as loudly as an accidental increment.
    expect(after.consecutive_empty_weeks).toBe(2);
    expect(after).toEqual(before);
    // Not one CASL audit row. A previewed message was never sent, so recording one would both
    // corrupt the send history and make the subscriber ineligible for their real Friday text via
    // the 4-day resend guard — the preview would have consumed the send it was previewing.
    expect(sendsAfter).toBe(sendsBefore);
    expect(sendsAfter).toBe(0);

    // And it genuinely ran the real path rather than bailing early, which is what makes the
    // assertions above meaningful. The catalogue is empty in this lane, so 'empty'/'no_message'
    // are the honest outcomes; what must NOT appear is 'secret_missing' (stubbed above) or
    // 'not_eligible' (this row satisfies every condition in loadActiveSubscribers).
    expect(['ok', 'no_message']).toContain(result.status);
  });
});
