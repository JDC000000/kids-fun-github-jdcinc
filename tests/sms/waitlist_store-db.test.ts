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
import { addToWaitlist, markWaitlistUnsubscribed } from '@/lib/sms/waitlist-store';
import { loadWaitingFor } from '@/lib/sms/waitlist-notify';
import { WAITLIST_CONSENT_VERSION } from '@/lib/sms/waitlist-copy';

const PREFIX = '+1604555 87'.replace(' ', ''); // +1604555 87xx — this suite's own block
/** Stamped on any sms_consent rows this suite creates, so cleanup can find them exactly. */
const TEST_CONSENT_VERSION = 'test-waitlist-store';
let seq = 0;
const nextPhone = () => `${PREFIX}${String(10 + seq++).padStart(2, '0')}`;

async function cleanup(): Promise<void> {
  await query(`DELETE FROM sms_area_waitlist WHERE phone_number LIKE $1`, [`${PREFIX}%`]);
  // Keyed on the version rather than the number: one test NULLs phone_number to reproduce the
  // purge, so a number-keyed delete would leak exactly that row. Same lesson as the consent suite.
  await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [TEST_CONSENT_VERSION]);
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

describe('markWaitlistUnsubscribed — making "Reply STOP" actually true', () => {
  it('marks every waiting row for the number, across all areas', async () => {
    // One number can wait on several areas, so a partial opt-out would leave some armed.
    const phone = nextPhone();
    const a = await addToWaitlist({ phoneNumber: phone, regionChipId: 'wvan', areaFsa: null });
    const b = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: 'V3S' });

    const r = await markWaitlistUnsubscribed(phone, { dryRun: false });
    expect(r.outcome).toBe('marked');
    expect(r.rows).toBe(2);

    for (const id of [a.id, b.id]) {
      const [row] = await query<Record<string, unknown>>(
        `SELECT unsubscribed_at FROM sms_area_waitlist WHERE id = $1`,
        [id]
      );
      expect(row.unsubscribed_at).not.toBeNull();
    }
  });

  it('🔴 an unsubscribed row is no longer selected for notification', async () => {
    // The whole point: not just recording the opt-out, but honouring it at the send.
    const phone = nextPhone();
    const area = 'V9Y';
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: area });
    expect((await loadWaitingFor(area)).map((x) => x.id)).toContain(w.id);

    await markWaitlistUnsubscribed(phone, { dryRun: false });
    expect((await loadWaitingFor(area)).map((x) => x.id)).not.toContain(w.id);
  });

  it('writes NOTHING on a dry run', async () => {
    const phone = nextPhone();
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: 'bby', areaFsa: null });
    const r = await markWaitlistUnsubscribed(phone, { dryRun: true });
    expect(r.outcome).toBe('dry_run');

    const [row] = await query<Record<string, unknown>>(
      `SELECT unsubscribed_at FROM sms_area_waitlist WHERE id = $1`,
      [w.id]
    );
    expect(row.unsubscribed_at).toBeNull();
  });

  it('does not move a date that already means something', async () => {
    // Re-stamping an existing unsubscribed_at would overwrite when they actually opted out.
    const phone = nextPhone();
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: 'rmd', areaFsa: null });
    await markWaitlistUnsubscribed(phone, { dryRun: false });
    const [{ unsubscribed_at: first }] = await query<{ unsubscribed_at: Date }>(
      `SELECT unsubscribed_at FROM sms_area_waitlist WHERE id = $1`,
      [w.id]
    );

    const second = await markWaitlistUnsubscribed(phone, { dryRun: false });
    expect(second.outcome).toBe('none'); // nothing left to mark
    const [{ unsubscribed_at: after }] = await query<{ unsubscribed_at: Date }>(
      `SELECT unsubscribed_at FROM sms_area_waitlist WHERE id = $1`,
      [w.id]
    );
    expect(new Date(after).getTime()).toBe(new Date(first).getTime());
  });

  it('is a no-op, not an error, for a number with no waitlist rows', async () => {
    const r = await markWaitlistUnsubscribed(nextPhone(), { dryRun: false });
    expect(r.outcome).toBe('none');
    expect(r.rows).toBe(0);
  });
});

describe('loadWaitingFor also refuses a number that STOPPED the weekly product', () => {
  // Defence in depth on top of the inbound-handler stamp (4fd316c). It exists because that stamp
  // can fail SILENTLY — markWaitlistUnsubscribed never throws, deliberately — and because rows
  // created before that fix were never retroactively marked.

  /**
   * A minimal sms_consent row in a given status.
   *
   * `stopped_at` is set only for a stopped row because migration 0034's
   * `sms_consent_stopped_has_timestamp` CHECK requires it — the schema refuses a stopped
   * subscription with no stop time, which is the right constraint and caught this fixture.
   */
  async function subscriberWith(status: 'active' | 'stopped', phone: string): Promise<void> {
    await query(
      `INSERT INTO sms_consent
         (phone_number, postal_code, birth_years, category_interests, status,
          consent_method, consent_timestamp, consent_text_version, preferences_token, stopped_at)
       VALUES ($1, 'V5L 1A1', ARRAY[2018], ARRAY['public_swim']::text[], $2,
               'web_form', now(), $3, $4, $5)`,
      [
        phone,
        status,
        TEST_CONSENT_VERSION,
        `tok-${phone.slice(-6)}`,
        status === 'stopped' ? new Date() : null,
      ]
    );
  }

  it('🔴 excludes a waitlist row whose number has a STOPPED subscription', async () => {
    // The mixed case: subscriber AND waitlist row, stops the weekly text. Even if the stamp never
    // landed, we must not compose a notification for them.
    const phone = nextPhone();
    const area = 'V9X';
    await subscriberWith('stopped', phone);
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: area });

    // The row itself still looks perfectly active — this is the silent-failure shape.
    const [row] = await query<Record<string, unknown>>(
      `SELECT unsubscribed_at FROM sms_area_waitlist WHERE id = $1`,
      [w.id]
    );
    expect(row.unsubscribed_at).toBeNull();

    expect((await loadWaitingFor(area)).map((r) => r.id)).not.toContain(w.id);
  });

  it('still includes a number whose subscription is ACTIVE', async () => {
    // A sparse-area parent may legitimately be both. Stopping the weekly text is the signal —
    // merely having one is not.
    const phone = nextPhone();
    const area = 'V9W';
    await subscriberWith('active', phone);
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: area });
    expect((await loadWaitingFor(area)).map((r) => r.id)).toContain(w.id);
  });

  it('still includes a waitlist-only number with no subscription at all', async () => {
    // The common case must not be broken by the join.
    const phone = nextPhone();
    const area = 'V9V';
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: area });
    expect((await loadWaitingFor(area)).map((r) => r.id)).toContain(w.id);
  });

  it('⚠ KNOWN HOLE: a PURGED stopper is not caught by this clause', async () => {
    // Pinned rather than left implied. 0034's purge NULLs sms_consent.phone_number 30 days after a
    // stop, so the join stops matching. Twilio's carrier block still covers them; this does not.
    // Asserted so "defence in depth" cannot be read as more coverage than it has — and so that if
    // anyone later closes this hole, they change a test that says why it was open.
    const phone = nextPhone();
    const area = 'V9U';
    await subscriberWith('stopped', phone);
    await query(`UPDATE sms_consent SET phone_number = NULL WHERE phone_number = $1`, [phone]);
    const w = await addToWaitlist({ phoneNumber: phone, regionChipId: null, areaFsa: area });

    expect((await loadWaitingFor(area)).map((r) => r.id)).toContain(w.id); // the hole, documented
  });
});
