// tests/retention/sms-retention-db.test.ts — both sms_consent retention rules AND migration
// 0043's hard-delete alarm, against real Postgres. Skips when DATABASE_URL is unset, like the
// other DB suites. Scopes every assertion to its own consent_text_version marker and removes
// exactly what it inserts, so it is safe against a populated database.
//
// The 0043 trigger is tested here rather than in a file of its own for one reason: it can ONLY be
// tested against a real database. A trigger is not importable and not mockable — SQL that reads
// correctly and fires never is exactly the failure it is being written to prevent, and the only
// thing that distinguishes the two is a real DELETE against a real Postgres. This file is already
// in DB_INTEGRATION_SUITES, so it is the cheapest honest home for that.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeStoppedSubscriberData, purgeUnconfirmedSignups } from '../../lib/retention/sms';
import { closePool, query } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `test-sms-retention-${Date.now()}`;

/**
 * Every consent id this suite has minted.
 *
 * Needed because sms_consent_delete_log rows OUTLIVE the row they describe — that is the whole
 * point of the table — so they cannot be cleaned up by joining back to a consent_text_version
 * marker that no longer exists anywhere. The ids are the only handle left.
 */
const mintedIds: string[] = [];

async function insertConsent(opts: {
  phone: string | null;
  status: string;
  consentAgeDays: number;
  stoppedAgeDays?: number;
  preferencesToken?: string;
}): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO sms_consent
       (phone_number, postal_code, birth_years, category_interests, status, consent_method,
        consent_text_version, consent_timestamp, stopped_at, preferences_token)
     VALUES ($1, 'V5L 1A1', ARRAY[2019]::integer[], ARRAY['public_swim']::text[], $2, 'web_form',
             $3, now() - ($4::text || ' days')::interval,
             CASE WHEN $5::text IS NULL THEN NULL
                  ELSE now() - ($5::text || ' days')::interval END,
             $6)
     RETURNING id`,
    [opts.phone, opts.status, MARKER, String(opts.consentAgeDays),
     opts.stoppedAgeDays === undefined ? null : String(opts.stoppedAgeDays),
     opts.preferencesToken ?? null]
  );
  mintedIds.push(row.id);
  return row.id;
}

/** Insert one send-log row for a subscriber, so there is an audit trail to keep (or to strand). */
async function insertSendLog(subscriberId: string, phoneHash: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO sms_send_log (subscriber_id, phone_hash, send_type, outcome, consent_text_version)
     VALUES ($1::uuid, $2, 'confirm_request', 'sent', $3)
     RETURNING id`,
    [subscriberId, phoneHash, MARKER]
  );
  return row.id;
}

async function readRow(id: string) {
  const rows = await query<{
    phone_number: string | null; postal_code: string | null;
    birth_years: number[] | null; category_interests: string[] | null; status: string;
    preferences_token: string | null;
  }>(
    `SELECT phone_number, postal_code, birth_years, category_interests, status, preferences_token
       FROM sms_consent WHERE id = $1::uuid`,
    [id]
  );
  return rows[0] ?? null;
}

/** How many rows this suite currently owns — the before/after count that proves nothing vanished. */
async function markerRowCount(): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sms_consent WHERE consent_text_version = $1`,
    [MARKER]
  );
  return Number(row.n);
}

async function deleteLogFor(consentId: string) {
  return query<{
    consent_id: string; short_ref: string | null; status: string | null;
    had_phone_number: boolean; phone_hash: string | null; phone_hash_version: number | null;
    send_log_rows: number; db_user: string; deleted_at: Date;
  }>(
    `SELECT consent_id, short_ref, status, had_phone_number, phone_hash, phone_hash_version,
            send_log_rows, db_user, deleted_at
       FROM sms_consent_delete_log WHERE consent_id = $1::uuid`,
    [consentId]
  );
}

describe.skipIf(!hasDb)('sms_consent retention — the job 0034 deferred', () => {
  // Send-log rows FIRST: the FK is ON DELETE SET NULL, so removing consent rows first would
  // strand them under a null subscriber_id instead of failing loudly — the exact shape of the
  // 13 rows the 2026-09-04 audit found.
  async function cleanup(): Promise<void> {
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [MARKER]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [MARKER]);
    // These are written BY the cleanup above (0043's trigger fires on any delete, including a
    // test's own), and they outlive their consent row by design — so they are cleaned by id.
    if (mintedIds.length > 0) {
      await query(`DELETE FROM sms_consent_delete_log WHERE consent_id = ANY($1::uuid[])`,
                  [mintedIds]);
    }
  }

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
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

  it('🔴 90-day: NULLS the personal columns and KEEPS the row — no row is destroyed', async () => {
    // The behaviour change of 2026-09-04. This rule used to DELETE. The row count before and
    // after is the assertion that matters: a purge that removes nothing is what makes the FK's
    // ON DELETE SET NULL stop being reachable from shipped code at all.
    const id = await insertConsent({
      phone: '+16045551004', status: 'pending', consentAgeDays: 120,
      preferencesToken: `${MARKER}-tok-1004`,
    });
    const before = await markerRowCount();

    const res = await purgeUnconfirmedSignups();
    expect(res.purged).toBeGreaterThanOrEqual(1);
    expect(await markerRowCount()).toBe(before);   // NOTHING was deleted

    const row = await readRow(id);
    expect(row).not.toBeNull();                    // row survives
    expect(row!.status).toBe('pending');           // still recognisably a never-confirmed signup
    expect(row!.phone_number).toBeNull();
    expect(row!.postal_code).toBeNull();
    expect(row!.birth_years).toBeNull();
    expect(row!.category_interests).toBeNull();
  });

  it('🔴 90-day: clears preferences_token too — a retained row must not keep a live credential', async () => {
    // The one column this rule clears and the 30-day rule does not. It used to be destroyed
    // along with the row; keeping the row without clearing it would turn a privacy NARROWING
    // into a bearer token that outlives everything it was minted for.
    const id = await insertConsent({
      phone: '+16045551009', status: 'pending', consentAgeDays: 200,
      preferencesToken: `${MARKER}-tok-1009`,
    });
    await purgeUnconfirmedSignups();
    expect((await readRow(id))!.preferences_token).toBeNull();
  });

  it('🔴 90-day: the send log keeps its LINK, not just its hash', async () => {
    // What the delete cost, stated as a test. Under the old DELETE the FK went to NULL and the
    // row survived but became unattributable — 13 rows in exactly that state are why this
    // workstream exists. Keeping the consent row keeps subscriber_id pointing somewhere.
    const id = await insertConsent({ phone: '+16045551010', status: 'pending', consentAgeDays: 300 });
    await insertSendLog(id, 'test-hash-not-a-real-digest');

    await purgeUnconfirmedSignups();

    const logs = await query<{ subscriber_id: string | null }>(
      `SELECT subscriber_id FROM sms_send_log WHERE consent_text_version = $1`,
      [MARKER]
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].subscriber_id).toBe(id);   // still attributable, which is the whole gain
  });

  it('🔴 90-day: is idempotent — a second run does not re-touch an already-purged row', async () => {
    // `phone_number IS NOT NULL` is what makes this true, and it became load-bearing only when
    // the rule stopped deleting. A deleted row leaves the WHERE clause by ceasing to exist; a
    // nulled one does not, so without the predicate every run would rewrite every historical
    // pending row forever.
    await insertConsent({ phone: '+16045551011', status: 'pending', consentAgeDays: 400 });
    const first = await purgeUnconfirmedSignups();
    expect(first.purged).toBeGreaterThanOrEqual(1);
    const second = await purgeUnconfirmedSignups();
    expect(second.purged).toBe(0);
  });

  it('🔴 90-day: a dry run stops counting a row once it has been purged', async () => {
    // `matched` has to mean "rows that would ACTUALLY change". Without the predicate on the
    // count query an operator reading a dry run would see the same backlog every night forever
    // and conclude the job was not working.
    await insertConsent({ phone: '+16045551012', status: 'pending', consentAgeDays: 400 });
    expect((await purgeUnconfirmedSignups({ dryRun: true })).matched).toBeGreaterThanOrEqual(1);
    await purgeUnconfirmedSignups();
    expect((await purgeUnconfirmedSignups({ dryRun: true })).matched).toBe(0);
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

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Migration 0043 — the alarm on the path no application code takes any more.
  //
  // Every assertion below runs a REAL `DELETE FROM sms_consent`, because that is the only way to
  // find out whether a trigger fires. Reviewing the SQL cannot tell you: a trigger attached to
  // the wrong event, or shadowed by an FK action that runs first, reads exactly like one that
  // works. The BEFORE-vs-AFTER choice in 0043 was made from this evidence, not from the manual.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('🔴 0043: a hard DELETE writes an audit row — id, hash, who, when', async () => {
    const id = await insertConsent({ phone: '+16045551020', status: 'pending', consentAgeDays: 3 });
    await insertSendLog(id, 'hash-for-1020');

    await query(`DELETE FROM sms_consent WHERE id = $1::uuid`, [id]);
    expect(await readRow(id)).toBeNull();          // the delete really happened

    const logs = await deleteLogFor(id);
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.consent_id).toBe(id);
    expect(log.status).toBe('pending');
    expect(log.short_ref).not.toBeNull();
    expect(log.had_phone_number).toBe(true);       // live personal data was destroyed
    expect(log.db_user).toBeTruthy();              // the "who" that was missing on 2026-09-04
    expect(Date.now() - new Date(log.deleted_at).getTime()).toBeLessThan(60_000);
  });

  it('🔴 0043: the hash is copied from the send log, which only a BEFORE trigger can see', async () => {
    // The load-bearing detail. The FK's ON DELETE SET NULL fires before user AFTER-row triggers,
    // so an AFTER DELETE trigger would read subscriber_id already NULL and record no hash and no
    // count — silently, and only discoverably here. If this test ever goes green with a null
    // hash, the trigger has been moved to AFTER.
    const id = await insertConsent({ phone: '+16045551021', status: 'pending', consentAgeDays: 3 });
    await insertSendLog(id, 'hash-for-1021');

    await query(`DELETE FROM sms_consent WHERE id = $1::uuid`, [id]);

    const [log] = await deleteLogFor(id);
    expect(log.phone_hash).toBe('hash-for-1021');  // re-links the now-orphaned send row
    expect(log.phone_hash_version).toBe(1);
    expect(log.send_log_rows).toBe(1);

    // And the send row is still there, stranded exactly as the audit found it — except now
    // something in the database says which subscriber it belonged to.
    const [sent] = await query<{ subscriber_id: string | null; phone_hash: string }>(
      `SELECT subscriber_id, phone_hash FROM sms_send_log WHERE consent_text_version = $1`,
      [MARKER]
    );
    expect(sent.subscriber_id).toBeNull();
    expect(sent.phone_hash).toBe(log.phone_hash);
  });

  it('🔴 0043: a subscriber with no send history still gets a row, with a null hash', async () => {
    // A null hash is not a failure to record — it is the recorded fact that we had never texted
    // this number. Dropping the row instead would leave the same silence this table exists to end.
    const id = await insertConsent({ phone: '+16045551022', status: 'pending', consentAgeDays: 3 });

    await query(`DELETE FROM sms_consent WHERE id = $1::uuid`, [id]);

    const [log] = await deleteLogFor(id);
    expect(log).toBeDefined();
    expect(log.phone_hash).toBeNull();
    expect(log.phone_hash_version).toBeNull();
    expect(log.send_log_rows).toBe(0);
    expect(log.had_phone_number).toBe(true);
  });

  it('🔴 0043: had_phone_number distinguishes destroying live data from deleting a purged shell', async () => {
    // The triage question at 9am: did this deletion take a phone number with it, or was the row
    // already an empty husk the retention job had finished with?
    const id = await insertConsent({ phone: '+16045551023', status: 'pending', consentAgeDays: 400 });
    await purgeUnconfirmedSignups();
    expect((await readRow(id))!.phone_number).toBeNull();

    await query(`DELETE FROM sms_consent WHERE id = $1::uuid`, [id]);

    const [log] = await deleteLogFor(id);
    expect(log.had_phone_number).toBe(false);
  });

  it('🔴 0043: the retention job itself trips no alarm — it no longer deletes anything', async () => {
    // The two halves of this workstream meeting: with the 90-day rule changed to null-and-keep,
    // NO shipped code path deletes an sms_consent row, so any row in sms_consent_delete_log is
    // by construction something other than the retention job. That is what makes the table an
    // alarm rather than a log of routine work nobody reads.
    const pending = await insertConsent({ phone: '+16045551024', status: 'pending', consentAgeDays: 400 });
    const stopped = await insertConsent({ phone: '+16045551025', status: 'stopped', consentAgeDays: 400, stoppedAgeDays: 90 });

    await purgeStoppedSubscriberData();
    await purgeUnconfirmedSignups();

    expect(await deleteLogFor(pending)).toHaveLength(0);
    expect(await deleteLogFor(stopped)).toHaveLength(0);
  });
});
