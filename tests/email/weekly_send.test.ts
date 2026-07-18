// tests/email/weekly_send.test.ts — single-user digest send, DB-backed, DRY-RUN only.
//
// Proves the orchestrator end-to-end against real Postgres WITHOUT sending any
// email: the recipient resolver is mocked (no Supabase Auth), and every send is
// dryRun so lib/email/resend.ts builds the payload and dispatches nothing. We then
// assert the payload is correct (recipient, subject, the seeded activity in the
// HTML, the CASL List-Unsubscribe header) and that the opt-in / saved-search /
// watermark gates behave.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// Mock the email-address resolver so no real Supabase Auth call is made.
vi.mock('@/lib/email/recipients', () => ({
  resolveRecipientEmail: vi.fn(async () => ({ email: 'digest-test@example.com', attempted: true })),
}));

import { query, closePool } from '@/lib/db/client';
import { sendWeeklyDigestForUser } from '@/lib/email/weekly';
import { recordWeeklySend } from '@/lib/email/send-log';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('sendWeeklyDigestForUser (dry-run, real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const activityName = `Weekly Digest Storytime ${suffix}`;
  const users = {
    happy: randomUUID(),
    optOut: randomUUID(),
    noSearch: randomUUID(),
    nothingNew: randomUUID(),
  };
  let occurrenceId = '';

  beforeAll(async () => {
    process.env.WEEKLY_EMAIL_UNSUBSCRIBE_SECRET = 'test-unsub-secret';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example';
    delete process.env.WEEKLY_EMAIL_ENABLED; // ensure sending stays disabled

    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier)
         VALUES ('library_bibliocommons', $1, 'official') RETURNING id`,
      [`Weekly Email Test Source ${suffix}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Weekly Storytime Series ${suffix}`, source.id]
    );
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (
         series_id, source_record_id, activity_name, primary_category_id,
         start_datetime_utc, end_datetime_utc, cost_status, source_url,
         status_state, confidence_label, last_checked_at, created_at
       ) VALUES ($1,$2,$3,$4, now() + interval '3 days', now() + interval '3 days' + interval '45 minutes',
                 'free', $5, 'confirmed', 'high', now(), now())
       RETURNING id`,
      [series.id, `weekly-${suffix}`, activityName, category.id, 'https://example.org/events/weekly-test']
    );
    occurrenceId = occ.id;

    // Profiles: created_at BEFORE the occurrence so the occurrence is "new since signup".
    for (const [key, id] of Object.entries(users)) {
      const optIn = key !== 'optOut';
      await query(
        `INSERT INTO user_profile (id, google_identity, email_opt_in, created_at)
           VALUES ($1, $2, $3, now() - interval '2 days')`,
        [id, `${id}@example.com`, optIn]
      );
    }
    // Saved searches (all users except noSearch).
    for (const id of [users.happy, users.optOut, users.nothingNew]) {
      await query(
        `INSERT INTO saved_search (user_id, query_json)
           VALUES ($1, '{"name":"Storytime","params":{"q":"storytime"}}'::jsonb)`,
        [id]
      );
    }
    // nothingNew: record a real send NOW → watermark is after the occurrence's created_at.
    await recordWeeklySend({ userId: users.nothingNew, activityCount: 1, resendId: 'seed', dryRun: false });
  });

  afterAll(async () => {
    const ids = Object.values(users);
    await query(`DELETE FROM saved_search WHERE user_id = ANY($1)`, [ids]).catch(() => {});
    await query(`DELETE FROM user_profile WHERE id = ANY($1)`, [ids]).catch(() => {}); // cascades weekly_email_send
    await query(`DELETE FROM activity_occurrence WHERE id = $1`, [occurrenceId]).catch(() => {});
    await query(`DELETE FROM activity_series WHERE canonical_title = $1`, [`Weekly Storytime Series ${suffix}`]).catch(() => {});
    await query(`DELETE FROM source WHERE name = $1`, [`Weekly Email Test Source ${suffix}`]).catch(() => {});
    delete process.env.WEEKLY_EMAIL_UNSUBSCRIBE_SECRET;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    await closePool();
  });

  it('builds a correct payload for an opted-in user with a matching new activity', async () => {
    const res = await sendWeeklyDigestForUser(users.happy, { dryRun: true, now: new Date() });
    expect(res.status).toBe('dry_run');
    expect(res.activityCount).toBeGreaterThanOrEqual(1);
    expect(res.payload?.to).toEqual(['digest-test@example.com']);
    expect(res.payload?.subject).toMatch(/new activit/);
    expect(res.payload?.html).toContain(activityName);
    expect(res.payload?.headers?.['List-Unsubscribe']).toContain('/api/email/unsubscribe');
    expect(res.payload?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // No real send happened, so no watermark row was written for this user.
    const sends = await query(`SELECT id FROM weekly_email_send WHERE user_id = $1`, [users.happy]);
    expect(sends).toHaveLength(0);
  });

  it('skips a user who has NOT opted in (CASL opt-out gate)', async () => {
    const res = await sendWeeklyDigestForUser(users.optOut, { dryRun: true, now: new Date() });
    expect(res.status).toBe('skipped_not_opted_in');
    expect(res.activityCount).toBe(0);
  });

  it('skips a user with no saved searches', async () => {
    const res = await sendWeeklyDigestForUser(users.noSearch, { dryRun: true, now: new Date() });
    expect(res.status).toBe('skipped_no_saved_searches');
  });

  it('skips when nothing is new since the last email (watermark honoured)', async () => {
    const res = await sendWeeklyDigestForUser(users.nothingNew, { dryRun: true, now: new Date() });
    expect(res.status).toBe('skipped_nothing_new');
  });
});
