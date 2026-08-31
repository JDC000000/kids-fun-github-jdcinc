// tests/sms/waitlist_store-db.test.ts — the waitlist writes, against a REAL database.
//
// Deferred until 0038 was applied; the Operator applied it to production and cleared the same
// migration for local test databases, so these can finally exist.
//
// SELF-CLEANING, keyed on a phone block this suite owns outright. sms_area_waitlist has no purge
// semantics to work around (nothing NULLs the number), so unlike the consent suite the phone number
// IS a safe cleanup key here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/lib/db/client';
import { addToWaitlist } from '@/lib/sms/waitlist-store';
import { loadWaitingFor } from '@/lib/sms/waitlist-notify';
import { WAITLIST_CONSENT_VERSION } from '@/lib/sms/waitlist-copy';

const PREFIX = '+1604555 87'.replace(' ', ''); // +1604555 87xx — this suite's own block
let seq = 0;
const nextPhone = () => `${PREFIX}${String(10 + seq++).padStart(2, '0')}`;

async function cleanup(): Promise<void> {
  await query(`DELETE FROM sms_area_waitlist WHERE phone_number LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(cleanup);
afterAll(cleanup);

describe('addToWaitlist', () => {
  it('writes a sparse-municipality row with the region set and no FSA', async () => {
    const phone = nextPhone();
    const r = await addToWaitlist({ phoneNumber: phone, regionChipId: 'wvan', areaFsa: null });
    expect(r.outcome).toBe('added');

    const [row] = await query<Record<string, unknown>>(
      `SELECT phone_number, region_chip_id, area_fsa, waitlist_consent_version,
              notified_at, unsubscribed_at
         FROM sms_area_waitlist WHERE id = $1`,
      [r.id]
    );
    expect(row.phone_number).toBe(phone);
    expect(row.region_chip_id).toBe('wvan');
    expect(row.area_fsa).toBeNull();
    expect(row.waitlist_consent_version).toBe(WAITLIST_CONSENT_VERSION);
    expect(row.notified_at).toBeNull();
    expect(row.unsubscribed_at).toBeNull();
  });

  it('writes an out-of-area row with the FSA set and no region', async () => {
    const phone = nextPhone();
    const r = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: 'V3S' });
    expect(r.outcome).toBe('added');
    const [row] = await query<Record<string, unknown>>(
      `SELECT region_chip_id, area_fsa FROM sms_area_waitlist WHERE id = $1`,
      [r.id]
    );
    expect(row.region_chip_id).toBeNull();
    expect(row.area_fsa).toBe('V3S');
  });

  it('is idempotent per (number, area) — one row, not two', async () => {
    const phone = nextPhone();
    const first = await addToWaitlist({ phoneNumber: phone, regionChipId: 'bby', areaFsa: null });
    const second = await addToWaitlist({ phoneNumber: phone, regionChipId: 'bby', areaFsa: null });
    expect(first.outcome).toBe('added');
    expect(second.outcome).toBe('already_waiting');
    expect(second.id).toBe(first.id);

    const [{ count }] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sms_area_waitlist WHERE phone_number = $1`,
      [phone]
    );
    expect(count).toBe('1');
  });

  it('🔴 lets ONE number wait on TWO areas — the case that makes the STOP gap matter', async () => {
    // The unique index is per (phone, area) on purpose: a family moving between municipalities can
    // legitimately wait on both. It is also exactly what makes a stale opt-out able to strand an
    // armed notification, so it is asserted rather than assumed.
    const phone = nextPhone();
    const a = await addToWaitlist({ phoneNumber: phone, regionChipId: 'wvan', areaFsa: null });
    const b = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: 'V3S' });
    expect(a.outcome).toBe('added');
    expect(b.outcome).toBe('added');
    expect(b.id).not.toBe(a.id);
  });

  it('🔴 re-opting-in NEVER re-arms an already-sent notification', async () => {
    // The promise is ONE message. A repeat opt-in re-stamps consent and clears an opt-out, but
    // must not reset notified_at — a bug here would be invisible until somebody received the same
    // "we've reached your area" text twice, months apart.
    const phone = nextPhone();
    const first = await addToWaitlist({ phoneNumber: phone, regionChipId: 'rmd', areaFsa: null });
    await query(
      `UPDATE sms_area_waitlist SET notified_at = now(), unsubscribed_at = now() WHERE id = $1`,
      [first.id]
    );

    const again = await addToWaitlist({ phoneNumber: phone, regionChipId: 'rmd', areaFsa: null });
    expect(again.outcome).toBe('already_waiting');

    const [row] = await query<Record<string, unknown>>(
      `SELECT notified_at, unsubscribed_at FROM sms_area_waitlist WHERE id = $1`,
      [first.id]
    );
    expect(row.notified_at).not.toBeNull(); // untouched — the message was already sent
    expect(row.unsubscribed_at).toBeNull(); // cleared — opting in again is a deliberate act
  });

  it('🔴 the schema refuses a row that is neither area, or both', async () => {
    // num_nonnulls(...) = 1, enforced by the database rather than by application code — so a
    // future caller that forgets the branch cannot write a row that means nothing.
    const phone = nextPhone();
    await expect(
      query(
        `INSERT INTO sms_area_waitlist (phone_number, waitlist_consent_version) VALUES ($1, $2)`,
        [phone, WAITLIST_CONSENT_VERSION]
      )
    ).rejects.toThrow();
    await expect(
      query(
        `INSERT INTO sms_area_waitlist (phone_number, region_chip_id, area_fsa,
           waitlist_consent_version) VALUES ($1, 'wvan', 'V3S', $2)`,
        [phone, WAITLIST_CONSENT_VERSION]
      )
    ).rejects.toThrow();
  });

  it('never lets the phone number reach an error string', async () => {
    // Postgres quotes the offending value on a constraint violation, and this result is returned to
    // a route that reports failures. Same guarantee signup-store makes.
    const phone = nextPhone();
    const r = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: 'not-an-fsa' });
    expect(r.outcome).toBe('error');
    expect(JSON.stringify(r)).not.toContain(phone.slice(-7));
  });
});

describe('loadWaitingFor', () => {
  it('returns only rows still waiting, and skips notified or unsubscribed ones', async () => {
    const waiting = nextPhone();
    const notified = nextPhone();
    const gone = nextPhone();
    const area = 'V9Z'; // an FSA no other test in this file uses

    const w = await addToWaitlist({ phoneNumber: waiting, regionChipId: null, areaFsa: area });
    const n = await addToWaitlist({ phoneNumber: notified, regionChipId: null, areaFsa: area });
    const g = await addToWaitlist({ phoneNumber: gone, regionChipId: null, areaFsa: area });
    await query(`UPDATE sms_area_waitlist SET notified_at = now() WHERE id = $1`, [n.id]);
    await query(`UPDATE sms_area_waitlist SET unsubscribed_at = now() WHERE id = $1`, [g.id]);

    const rows = await loadWaitingFor(area);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(w.id);
    expect(ids).not.toContain(n.id); // already had its one message
    expect(ids).not.toContain(g.id); // opted out
  });
});
