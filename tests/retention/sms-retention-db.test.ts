// tests/retention/sms-retention-db.test.ts — both sms_consent retention rules, against real
// Postgres. Skips when DATABASE_URL is unset, like the other DB suites. Scopes every assertion to
// its own consent_text_version marker and removes exactly what it inserts, so it is safe against a
// populated database.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeStoppedSubscriberData, purgeUnconfirmedSignups } from '../../lib/retention/sms';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `test-sms-retention-${Date.now()}`;

async function insertConsent(opts: {
  phone: string | null;
  status: string;
  consentAgeDays: number;
  stoppedAgeDays?: number;
}): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO sms_consent
       (phone_number, postal_code, birth_years, category_interests, status, consent_method,
        consent_text_version, consent_timestamp, stopped_at)
     VALUES ($1, 'V5L 1A1', ARRAY[2019]::integer[], ARRAY['public_swim']::text[], $2, 'web_form',
             $3, now() - ($4::text || ' days')::interval,
             CASE WHEN $5::text IS NULL THEN NULL
                  ELSE now() - ($5::text || ' days')::interval END)
     RETURNING id`,
    [opts.phone, opts.status, MARKER, String(opts.consentAgeDays),
     opts.stoppedAgeDays === undefined ? null : String(opts.stoppedAgeDays)]
  );
  return row.id;
}

async function readRow(id: string) {
  const rows = await query<{
    phone_number: string | null; postal_code: string | null;
    birth_years: number[] | null; category_interests: string[] | null; status: string;
  }>(
    `SELECT phone_number, postal_code, birth_years, category_interests, status
       FROM sms_consent WHERE id = $1::uuid`,
    [id]
  );
  return rows[0] ?? null;
}

describe.skipIf(!hasDb)('sms_consent retention — the job 0034 deferred', () => {
  beforeEach(async () => {
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [MARKER]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [MARKER]);
  });

  afterAll(async () => {
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [MARKER]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [MARKER]);
    await closePool();
  });

  it('🔴 30-day: erases the four personal columns and KEEPS the row', async () => {
    // Keeping the row is the whole design. sms_send_log's CASL audit trail must go on pointing
    // at a subscription that demonstrably existed (0034 header).
    const id = await insertConsent({ phone: '+16045551001', status: 'stopped', consentAgeDays: 200, stoppedAgeDays: 45 });
    const res = await purgeStoppedSubscriberData();
    expect(res.purged).toBeGreaterThanOrEqual(1);

    const row = await readRow(id);
    expect(row).not.toBeNull();               // row survives
    expect(row!.status).toBe('stopped');      // consent record intact
    expect(row!.phone_number).toBeNull();
    expect(row!.postal_code).toBeNull();
    expect(row!.birth_years).toBeNull();
    expect(row!.category_interests).toBeNull();
  });

  it('leaves a recently-stopped subscriber alone', async () => {
    const id = await insertConsent({ phone: '+16045551002', status: 'stopped', consentAgeDays: 40, stoppedAgeDays: 5 });
    await purgeStoppedSubscriberData();
    expect((await readRow(id))!.phone_number).toBe('+16045551002');
  });

  it('🔴 is idempotent — a second run does not re-touch an already-purged row', async () => {
    // `phone_number IS NOT NULL` is what makes this true. Without it every run would rewrite
    // every historical stopped row forever, growing monotonically while achieving nothing.
    await insertConsent({ phone: '+16045551003', status: 'stopped', consentAgeDays: 200, stoppedAgeDays: 60 });
    const first = await purgeStoppedSubscriberData();
    expect(first.purged).toBeGreaterThanOrEqual(1);
    const second = await purgeStoppedSubscriberData();
    expect(second.purged).toBe(0);
  });

  it('🔴 90-day: DELETES an unconfirmed signup, and ON DELETE SET NULL saves its send log', async () => {
    // This is the exact mechanism /admin/sms-subscribers/[id]'s phone_hash fallback exists to
    // survive: a send record outliving the consent row it pointed at. 0035/0036 use ON DELETE
    // SET NULL rather than CASCADE precisely so the audit trail is not destroyed with the row.
    const id = await insertConsent({ phone: '+16045551004', status: 'pending', consentAgeDays: 120 });
    await query(
      `INSERT INTO sms_send_log (subscriber_id, phone_hash, send_type, outcome, consent_text_version)
       VALUES ($1::uuid, 'test-hash-not-a-real-digest', 'confirm_request', 'sent', $2)`,
      [id, MARKER]
    );

    const res = await purgeUnconfirmedSignups();
    expect(res.purged).toBeGreaterThanOrEqual(1);
    expect(await readRow(id)).toBeNull();     // consent row really gone

    const logs = await query<{ subscriber_id: string | null }>(
      `SELECT subscriber_id FROM sms_send_log WHERE consent_text_version = $1`,
      [MARKER]
    );
    expect(logs).toHaveLength(1);             // audit row SURVIVED
    expect(logs[0].subscriber_id).toBeNull(); // ...with the FK nulled, not cascaded away
  });

  it('leaves a recent pending signup alone', async () => {
    const id = await insertConsent({ phone: '+16045551005', status: 'pending', consentAgeDays: 10 });
    await purgeUnconfirmedSignups();
    expect(await readRow(id)).not.toBeNull();
  });

  it('🔴 a dry run counts and changes NOTHING', async () => {
    const stoppedId = await insertConsent({ phone: '+16045551006', status: 'stopped', consentAgeDays: 200, stoppedAgeDays: 90 });
    const pendingId = await insertConsent({ phone: '+16045551007', status: 'pending', consentAgeDays: 150 });

    const s = await purgeStoppedSubscriberData({ dryRun: true });
    const p = await purgeUnconfirmedSignups({ dryRun: true });

    expect(s.matched).toBeGreaterThanOrEqual(1);
    expect(s.purged).toBe(0);
    expect(p.matched).toBeGreaterThanOrEqual(1);
    expect(p.purged).toBe(0);
    expect((await readRow(stoppedId))!.phone_number).toBe('+16045551006');
    expect(await readRow(pendingId)).not.toBeNull();
  });

  it('an active subscriber is never touched by either rule, however old', async () => {
    // Production currently holds exactly one sms_consent row — an active test signup. Neither
    // rule may match it, and that is asserted rather than assumed.
    const id = await insertConsent({ phone: '+16045551008', status: 'active', consentAgeDays: 400 });
    await purgeStoppedSubscriberData();
    await purgeUnconfirmedSignups();
    const row = await readRow(id);
    expect(row).not.toBeNull();
    expect(row!.phone_number).toBe('+16045551008');
  });
});
