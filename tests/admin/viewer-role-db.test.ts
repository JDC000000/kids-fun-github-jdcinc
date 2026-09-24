// tests/admin/viewer-role-db.test.ts — the read-only 'viewer' admin role against a REAL database.
//
// What this pins (agent test admin login, PR-1; scope doc
// documents/kids-fun/agent-test-admin-login-SCOPE-2026-09-24.md):
//   1. Migration 0055 admits 'viewer' and still rejects anything outside the four known roles.
//   2. A viewer session reads the console (resolveAdminAccess grants, and the view is audited) but
//      resolveSessionAdmin — the single write choke point — returns null. Human roles are unchanged.
//   3. Redaction happens IN SQL: with redactPersonalData the read models return no phone number,
//      postal code, birth year, FSA or correction note — checked against CANARY values planted by
//      this file, searched for in the JSON of everything returned — while `purged`, `childCount`,
//      `hasNote` and the send history stay true to the data. With redactPersonalData:false the
//      rows are exactly what a human admin saw before this change.
//
// Inserts its own rows and removes exactly what it inserted (scoped by marker / id).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, query } from '../../lib/db/client';
import { getSmsSubscriberDetail, getSmsSubscribers } from '../../lib/admin/sms-subscribers';
import { getSmsEngagement } from '../../lib/admin/sms-engagement';
import { listOpenCorrections } from '../../app/admin/corrections/_lib/data';
import { getRecentCorrections, correctionsForDisplay } from '../../lib/admin/dashboard';
import { phoneHash } from '../../lib/sms/phone-hash';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `test-viewer-role-${Date.now()}`;

// CANARY personal data — synthetic, and distinctive enough that finding any of it in a redacted
// result can only mean it leaked. (Birth years are asserted by field, not by substring: a 4-digit
// year can occur inside a UUID by chance.)
const CANARY_PHONE = '+16045550177';
const CANARY_POSTAL = 'V5K 0Z9';
const CANARY_FSA = 'V5K';
const CANARY_YEARS = [2017, 2021];
const CANARY_NOTE = 'CANARY-NOTE my kid Zebediah-Quux goes to this one on Tuesdays';

const session = vi.hoisted(() => ({ user: null as null | { userId: string; email: string | null } }));
vi.mock('../../lib/db/session-user', () => ({ getRequestUser: () => Promise.resolve(session.user) }));
import { resolveAdminAccess, resolveSessionAdmin } from '../../app/admin/_lib/gate';

function leaks(value: unknown): string[] {
  const json = JSON.stringify(value);
  return [
    CANARY_PHONE,
    CANARY_PHONE.replace('+1', ''),
    CANARY_POSTAL,
    CANARY_POSTAL.replace(' ', ''),
    CANARY_NOTE,
    'Zebediah',
  ].filter((needle) => json.includes(needle));
}

describe.skipIf(!hasDb)('viewer role over a live database', () => {
  const ids = {
    viewer: '',
    humans: {} as Record<'operator' | 'admin' | 'superadmin', string>,
    consent: '',
    source: '',
    series: '',
    occurrence: '',
  };

  beforeAll(async () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'test-salt-viewer-role');
    const mkUser = async () =>
      (await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`))[0].id;

    ids.viewer = await mkUser();
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'viewer', true)`, [ids.viewer]);
    for (const role of ['operator', 'admin', 'superadmin'] as const) {
      ids.humans[role] = await mkUser();
      await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, $2, true)`, [ids.humans[role], role]);
    }

    const [c] = await query<{ id: string }>(
      `INSERT INTO sms_consent (phone_number, status, consent_method, consent_text_version, consent_timestamp,
                                postal_code, birth_years)
       VALUES ($1, 'active', 'web_form', $2, now() - interval '1 hour', $3, $4::int[]) RETURNING id`,
      [CANARY_PHONE, MARKER, CANARY_POSTAL, CANARY_YEARS]
    );
    ids.consent = c.id;
    await query(
      `INSERT INTO sms_send_log (subscriber_id, phone_hash, send_type, outcome, consent_text_version, created_at)
       VALUES ($1::uuid, $2, 'weekly', 'sent', $3, now() - interval '30 minutes')`,
      [ids.consent, phoneHash(CANARY_PHONE), MARKER]
    );

    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status)
       VALUES ('test_viewer_role', 'Viewer Role Test Source', 'official', 'auto', 'allowed') RETURNING id`
    );
    ids.source = src.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('Viewer Role Series', $1) RETURNING id`,
      [ids.source]
    );
    ids.series = ser.id;
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
       VALUES ($1, 'Viewer Role Listing', '2026-12-01T18:00:00Z', 'needs_review', 'unscored') RETURNING id`,
      [ids.series]
    );
    ids.occurrence = occ.id;
    await query(
      `INSERT INTO correction_report (occurrence_id, reporter, issue_type, note)
       VALUES ($1, 'anon-canary-reporter', 'wrong_time', $2)`,
      [ids.occurrence, CANARY_NOTE]
    );
  });

  afterAll(async () => {
    const admins = [ids.viewer, ...Object.values(ids.humans)].filter(Boolean);
    await query(`DELETE FROM admin_audit_log WHERE admin_user_id = ANY($1::uuid[])`, [admins]);
    await query(`DELETE FROM admin_user WHERE user_id = ANY($1::uuid[])`, [admins]);
    await query(`DELETE FROM user_profile WHERE id = ANY($1::uuid[])`, [admins]);
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [MARKER]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [MARKER]);
    if (ids.occurrence) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [ids.occurrence]);
    if (ids.occurrence) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [ids.occurrence]);
    if (ids.series) await query(`DELETE FROM activity_series WHERE id = $1`, [ids.series]);
    if (ids.source) await query(`DELETE FROM source WHERE id = $1`, [ids.source]);
    vi.unstubAllEnvs();
    await closePool();
  });

  // ── 1. migration 0055 ─────────────────────────────────────────────────────────────────────
  it('0055 admits viewer and still rejects an unknown role', async () => {
    const [row] = await query<{ role: string }>(`SELECT role FROM admin_user WHERE user_id = $1`, [ids.viewer]);
    expect(row.role).toBe('viewer');
    const [u] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    try {
      await expect(
        query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'root', true)`, [u.id])
      ).rejects.toThrow(/admin_user_role_check|check constraint/);
    } finally {
      await query(`DELETE FROM user_profile WHERE id = $1`, [u.id]);
    }
  });

  // ── 2. the gate ────────────────────────────────────────────────────────────────────────────
  it('🔴 a viewer session may READ (granted, and the view is audited)…', async () => {
    session.user = { userId: ids.viewer, email: null };
    const grant = await resolveAdminAccess({ surface: 'admin_sms_subscribers' });
    expect(grant).toMatchObject({ ok: true, via: 'session', admin: { userId: ids.viewer, role: 'viewer' } });
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'admin.view'`,
      [ids.viewer]
    );
    expect(Number(n.n)).toBe(1);
  });

  it('🔴 …but may NOT write: resolveSessionAdmin returns null for a viewer', async () => {
    session.user = { userId: ids.viewer, email: null };
    expect(await resolveSessionAdmin()).toBeNull();
  });

  it('human roles are unchanged: operator, admin and superadmin all still resolve as writers', async () => {
    for (const role of ['operator', 'admin', 'superadmin'] as const) {
      session.user = { userId: ids.humans[role], email: null };
      expect(await resolveSessionAdmin(), role).toMatchObject({ userId: ids.humans[role], role });
    }
  });

  it('a deactivated viewer is refused on the very next request (revocation)', async () => {
    await query(`UPDATE admin_user SET active = false WHERE user_id = $1`, [ids.viewer]);
    try {
      session.user = { userId: ids.viewer, email: null };
      expect(await resolveAdminAccess({ surface: 'admin_dashboard' })).toEqual({ ok: false });
    } finally {
      await query(`UPDATE admin_user SET active = true WHERE user_id = $1`, [ids.viewer]);
    }
  });

  // ── 3. redaction in SQL ────────────────────────────────────────────────────────────────────
  it('🔴 subscriber list: redacted rows carry no personal data, but stay truthful', async () => {
    const mine = (await getSmsSubscribers({ redactPersonalData: true })).filter((r) => r.id === ids.consent);
    expect(mine).toHaveLength(1);
    expect(leaks(mine)).toEqual([]);
    expect(mine[0]).toMatchObject({
      phoneNumber: null,
      postalCode: null,
      birthYears: null,
      redacted: true,
      purged: false,
      childCount: 2,
      status: 'active',
    });
  });

  it('subscriber list, unredacted: exactly what a human admin saw before', async () => {
    const [mine] = (await getSmsSubscribers({ redactPersonalData: false })).filter((r) => r.id === ids.consent);
    expect(mine).toMatchObject({
      phoneNumber: CANARY_PHONE,
      postalCode: CANARY_POSTAL,
      birthYears: CANARY_YEARS,
      redacted: false,
      purged: false,
      childCount: 2,
    });
  });

  it('🔴 subscriber detail: redacted, with the SAME send history an admin sees', async () => {
    const red = await getSmsSubscriberDetail(ids.consent, { redactPersonalData: true });
    const full = await getSmsSubscriberDetail(ids.consent, { redactPersonalData: false });
    expect(red && full).toBeTruthy();
    expect(leaks(red)).toEqual([]);
    expect(red!.subscriber).toMatchObject({ phoneNumber: null, postalCode: null, birthYears: null, redacted: true });
    expect(red!.sends.map((s) => s.id)).toEqual(full!.sends.map((s) => s.id));
    expect(red!.sends.length).toBeGreaterThan(0);
    expect(full!.subscriber.phoneNumber).toBe(CANARY_PHONE);
  });

  it('🔴 engagement: the per-subscriber FSA is NULL for a viewer, present for an admin', async () => {
    const red = (await getSmsEngagement({ redactPersonalData: true })).rows.filter((r) => r.subscriberId === ids.consent);
    const full = (await getSmsEngagement({ redactPersonalData: false })).rows.filter((r) => r.subscriberId === ids.consent);
    expect(red).toHaveLength(1);
    expect(red[0]).toMatchObject({ fsa: null, redacted: true });
    expect(leaks(red)).toEqual([]);
    expect(full[0]).toMatchObject({ fsa: CANARY_FSA, redacted: false });
  });

  it('🔴 corrections queue: note and reporter NULLed in SQL, hasNote still true', async () => {
    const red = (await listOpenCorrections({ redactPersonalData: true })).filter((c) => c.occurrenceId === ids.occurrence);
    const full = (await listOpenCorrections({ redactPersonalData: false })).filter((c) => c.occurrenceId === ids.occurrence);
    expect(red).toHaveLength(1);
    expect(leaks(red)).toEqual([]);
    expect(red[0]).toMatchObject({ note: null, reporter: null, redacted: true, hasNote: true });
    expect(full[0]).toMatchObject({ note: CANARY_NOTE, reporter: 'anon-canary-reporter', redacted: false, hasNote: true });
  });

  it('🔴 recent corrections (dashboard / data-health): note NULLed before render for a viewer', async () => {
    const recent = (await getRecentCorrections()).filter((c) => c.occurrenceId === ids.occurrence);
    expect(recent).toHaveLength(1);
    const red = correctionsForDisplay(recent, { redactPersonalData: true });
    expect(leaks(red)).toEqual([]);
    expect(red[0]).toMatchObject({ note: null, redacted: true, hasNote: true });
    expect(correctionsForDisplay(recent, { redactPersonalData: false })[0].note).toBe(CANARY_NOTE);
  });
});
