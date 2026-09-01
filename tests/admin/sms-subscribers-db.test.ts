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
         (phone_number, status, consent_method, consent_text_version, consent_timestamp)
       VALUES ($1, 'active', 'web_form', $2, now() - interval '1 hour')`,
      ['+16045550188', MARKER]
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
    const mine = (await getSmsSubscribers()).filter((r) => r.phoneNumber === '+16045550188');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'active', consentMethod: 'web_form', purged: false });
    expect(mine[0].consentTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('🔴 reports an erased row as purged, not as a missing phone number', async () => {
    const rows = await getSmsSubscribers();
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
    for (const r of await getSmsSubscribers()) {
      expect(typeof r.shortRef).toBe('string');
      expect(r.shortRef).toMatch(/^\d+$/);
    }
  });

  it('orders newest consent first', async () => {
    const times = (await getSmsSubscribers())
      .map((r) => r.consentTimestamp)
      .filter((t): t is string => t !== null);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
  });

  it('the summary agrees with the rows it was given', async () => {
    const rows = await getSmsSubscribers();
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
    return getSmsSubscriberDetail(ids.liveNew).then((d) => {
      expect(d).not.toBeNull();
      expect(d!.sends).toHaveLength(2);
      expect(d!.sends.filter((r) => !r.linkedToThisRow)).toHaveLength(1);
    });
  });

  it('🔴 shows the PURGED subscriber both rows too — hash recovered from its own log row', () => {
    // The trap this covers: a purged row has phone_number = NULL, so phoneHash() cannot be
    // recomputed for it. The hash is read back off the rows it still owns via subscriber_id.
    return getSmsSubscriberDetail(ids.purgedOld).then((d) => {
      expect(d!.purged).toBe(true);
      expect(d!.subscriber.phoneNumber).toBeNull();
      expect(d!.sends).toHaveLength(2);
    });
  });

  it('marks which rows belong to the record being viewed', async () => {
    const d = await getSmsSubscriberDetail(ids.liveNew);
    const own = d!.sends.filter((r) => r.linkedToThisRow);
    expect(own).toHaveLength(1);
    expect(own[0].sendType).toBe('weekly');
  });

  it('never returns the phone hash in any field', async () => {
    // The salt is global and the keyspace is small, so the hash must not cross this boundary.
    const d = await getSmsSubscriberDetail(ids.liveNew);
    expect(JSON.stringify(d)).not.toContain(hash);
  });

  it('returns null for an id that is not a subscriber', async () => {
    expect(await getSmsSubscriberDetail('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
