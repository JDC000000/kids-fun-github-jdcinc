// tests/admin/sms-subscribers-db.test.ts — the subscriber list read model, against a real database.
//
// Skips when DATABASE_URL is unset, like the other admin DB tests. Inserts its own rows and
// removes exactly what it inserted, so it is safe against a populated staging database as well as
// an empty CI one — every assertion is scoped to this run's own consent_text_version marker rather
// than to global counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSmsSubscribers, summariseSubscribers } from '../../lib/admin/sms-subscribers';
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
