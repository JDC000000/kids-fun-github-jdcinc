// tests/admin/sms-engagement-db.test.ts — the per-subscriber engagement read model.
//
// THE STRUCTURAL RISK THIS FILE EXISTS FOR. One subscriber has many sends AND many clicks.
// Joining sms_send_log to sms_click_event on subscriber_id emits sends x clicks rows, and the
// obvious repair is count(DISTINCT ...), which hides the multiplication instead of removing it.
// That is the exact defect fixed in getOpsSeries this week. The arithmetic test below would fail
// loudly if that shape ever came back — 3 sends and 4 taps must read as 3 and 4, never 12.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../../lib/db/client';
import { getSmsEngagement } from '../../lib/admin/sms-engagement';

const hasDb = Boolean(process.env.DATABASE_URL);
const MARKER = `engtest-${Date.now()}`;
let n = 0;

async function seedSubscriber(opts: { isTest?: boolean } = {}): Promise<string> {
  n += 1;
  const rows = await query<{ id: string }>(
    `INSERT INTO sms_consent
       (phone_number, postal_code, birth_years, status, consent_method, consent_timestamp,
        consent_text_version, preferences_token, is_test)
     VALUES ($1, 'V5K 0A1', ARRAY[2018], 'active', 'web_form', now(), 'test', $2, $3)
     RETURNING id`,
    [`+1555${String(7000000 + n).slice(0, 7)}`, `${MARKER}-${n}`, opts.isTest ?? false]
  );
  return rows[0].id;
}

async function seedSend(subscriberId: string, picks: number, delivery = 'delivered'): Promise<string> {
  const snapshot = JSON.stringify(
    Array.from({ length: picks }, (_, i) => ({ occurrence_id: `occ-${i}`, rank: i + 1 }))
  );
  const rows = await query<{ id: string }>(
    `INSERT INTO sms_send_log
       (subscriber_id, phone_hash, phone_hash_version, send_type, picks_snapshot, outcome,
        delivery_status, consent_text_version)
     VALUES ($1, 'hash', 1, 'weekly', $2::jsonb, 'sent', $3, 'test')
     RETURNING id`,
    [subscriberId, snapshot, delivery]
  );
  return rows[0].id;
}

// sms_click_event.occurrence_id is a real FK into activity_occurrence — a tap points at a
// specific activity, and the schema will not accept an invented id. Borrowing a live row keeps
// the fixture honest about that rather than working around it.
async function anyOccurrenceId(): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM activity_occurrence WHERE archived_at IS NULL LIMIT 1`
  );
  if (rows.length === 0) throw new Error('no activity_occurrence rows to point a tap at');
  return rows[0].id;
}

async function seedTap(subscriberId: string, sendLogId: string, origin: string): Promise<void> {
  const occurrenceId = await anyOccurrenceId();
  await query(
    `INSERT INTO sms_click_event (subscriber_id, send_log_id, occurrence_id, link_origin)
     VALUES ($1, $2, $3, $4)`,
    [subscriberId, sendLogId, occurrenceId, origin]
  );
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM sms_click_event WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE preferences_token LIKE $1)`,
    [`${MARKER}%`]
  );
  await query(
    `DELETE FROM sms_send_log WHERE subscriber_id IN
       (SELECT id FROM sms_consent WHERE preferences_token LIKE $1)`,
    [`${MARKER}%`]
  );
  await query(`DELETE FROM sms_consent WHERE preferences_token LIKE $1`, [`${MARKER}%`]);
}

describe.skipIf(!hasDb)('getSmsEngagement', () => {
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it('🔴 does NOT multiply sends by taps — the Cartesian shape must not come back', async () => {
    // 3 sends, 4 taps. A join without pre-aggregation gives 12 of each.
    const id = await seedSubscriber();
    const a = await seedSend(id, 5);
    await seedSend(id, 5);
    await seedSend(id, 5);
    for (const origin of ['direct', 'direct', 'hub', 'hub']) await seedTap(id, a, origin);

    const { rows } = await getSmsEngagement({ redactPersonalData: false });
    const row = rows.find((r) => r.subscriberId === id)!;
    expect(row.sends).toBe(3);
    expect(row.taps).toBe(4);
    expect(row.picksOffered).toBe(15);
    expect(row.directTaps).toBe(2);
    expect(row.hubTaps).toBe(2);
  });

  it('🔴 excludes is_test rows by default, and includes them only when asked', async () => {
    const real = await seedSubscriber();
    const test = await seedSubscriber({ isTest: true });

    const def = await getSmsEngagement({ redactPersonalData: false });
    expect(def.rows.map((r) => r.subscriberId)).toContain(real);
    expect(def.rows.map((r) => r.subscriberId)).not.toContain(test);

    // Both present in the same run, so the exclusion is proven to discriminate rather than to
    // return nothing — "the test row is absent" passes vacuously on an empty result.
    const all = await getSmsEngagement({ includeTest: true, redactPersonalData: false });
    expect(all.rows.map((r) => r.subscriberId)).toContain(real);
    expect(all.rows.map((r) => r.subscriberId)).toContain(test);
  });

  it('🔴 the SUMMARY excludes test rows too, not just the list', async () => {
    // The list and the totals are computed in different places. A dashboard whose rows are clean
    // while its headline number is polluted is worse than one that is wrong consistently.
    const real = await seedSubscriber();
    const test = await seedSubscriber({ isTest: true });
    const s1 = await seedSend(real, 4);
    const s2 = await seedSend(test, 9);
    await seedTap(real, s1, 'direct');
    for (let i = 0; i < 7; i += 1) await seedTap(test, s2, 'direct');

    const { summary } = await getSmsEngagement({ redactPersonalData: false });
    expect(summary.picksOffered).toBe(4);
    expect(summary.taps).toBe(1);
  });

  it('a null picks_snapshot counts as nothing offered, not as unknown', async () => {
    const id = await seedSubscriber();
    await query(
      `INSERT INTO sms_send_log
         (subscriber_id, phone_hash, phone_hash_version, send_type, picks_snapshot, outcome,
          delivery_status, consent_text_version)
       VALUES ($1, 'hash', 1, 'weekly', NULL, 'sent', 'delivered', 'test')`,
      [id]
    );
    const { rows } = await getSmsEngagement({ redactPersonalData: false });
    const row = rows.find((r) => r.subscriberId === id)!;
    expect(row.sends).toBe(1);
    expect(row.picksOffered).toBe(0);
  });

  it('🔴 tap rate is null rather than NaN when nothing was offered', async () => {
    // 0/0. A dashboard showing "NaN%" or "Infinity%" is how a metric silently stops being read.
    const id = await seedSubscriber();
    const { rows, summary } = await getSmsEngagement({ redactPersonalData: false });
    const row = rows.find((r) => r.subscriberId === id)!;
    expect(row.picksOffered).toBe(0);
    expect(row.tapRatePct).toBeNull();
    expect(summary.tapRatePct === null || Number.isFinite(summary.tapRatePct)).toBe(true);
  });

  it('reports the FSA only, never the full postal code, and no phone number anywhere', async () => {
    const id = await seedSubscriber();
    const { rows } = await getSmsEngagement({ redactPersonalData: false });
    const row = rows.find((r) => r.subscriberId === id)!;
    expect(row.fsa).toBe('V5K');
    expect(JSON.stringify(row)).not.toContain('0A1');
    expect(JSON.stringify(row)).not.toMatch(/\+1\d{10}/);
  });
});
