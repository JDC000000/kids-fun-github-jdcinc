// tests/email/account_deletion_cascade.test.ts — cross-stream safety.
//
// The weekly_email_send table (0017) adds an FK to user_profile. Account deletion
// (Task C, lib/db/account-data.deleteUserData) hard-deletes user_profile through the
// RLS `authenticated` role. This proves the new FK's ON DELETE CASCADE lets that
// deletion still succeed AND erases the send history with the account — while a
// different user's send history is left intact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensureUserProfile } from '@/lib/db/user-profile';
import { deleteUserData } from '@/lib/db/account-data';
import { recordWeeklySend } from '@/lib/email/send-log';
import { query, closePool } from '@/lib/db/client';
import { closeUserPool } from '@/lib/db/user-scoped-client';

const hasUserDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('weekly_email_send cascades on account deletion', () => {
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    for (const u of [userA, userB]) {
      await ensureUserProfile(u, `${u}@example.com`);
      await recordWeeklySend({ userId: u, activityCount: 3, resendId: 'seed', dryRun: false });
    }
  });

  afterAll(async () => {
    await query('DELETE FROM user_profile WHERE id = $1', [userB]).catch(() => {}); // cascades B's log
    await closeUserPool();
    await closePool();
  });

  it('deletes the account + its send log (cascade), leaving another user’s log intact', async () => {
    const before = await query('SELECT id FROM weekly_email_send WHERE user_id = $1', [userA]);
    expect(before.length).toBeGreaterThanOrEqual(1);

    const res = await deleteUserData(userA);
    expect(res.profile_deleted).toBe(1);

    const afterA = await query('SELECT id FROM weekly_email_send WHERE user_id = $1', [userA]);
    expect(afterA).toHaveLength(0); // erased with the profile

    const afterB = await query('SELECT id FROM weekly_email_send WHERE user_id = $1', [userB]);
    expect(afterB.length).toBeGreaterThanOrEqual(1); // untouched
  });
});
