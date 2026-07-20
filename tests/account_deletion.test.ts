// tests/account_deletion.test.ts — self-service account deletion against a real
// Postgres, driven through the RLS-enforcing user pool (withUserContext).
//
// Proves the two things that matter for a delete that touches PII:
//   1. It actually removes the caller's rows (verified back via the service pool,
//      so we're reading the real table state, not a mock).
//   2. It CANNOT touch another user's rows — a second distinct user's profile +
//      saved searches are fully intact afterward (owner-only DELETE RLS).
// The `it` blocks form an ordered narrative (delete A → B intact → re-delete A is
// a no-op → A's export is empty) and run sequentially. Requires USER_DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { deleteUserData, exportUserData } from '../lib/db/account-data';
import { ensureUserProfile, updateUserProfile } from '../lib/db/user-profile';
import { createSavedSearch } from '../lib/db/saved-search';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { query, closePool } from '../lib/db/client';

const hasUserDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('deleteUserData — self-service account deletion (2 users)', () => {
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    for (const u of [userA, userB]) {
      await ensureUserProfile(u, `${u}@example.com`);
      await updateUserProfile(u, { home_postal: 'V6B 1A1' });
      await createSavedSearch(u, { name: 'keep-1', params: { q: 'x' } });
      await createSavedSearch(u, { name: 'keep-2', params: { q: 'y' } });
    }
  });

  afterAll(async () => {
    // A is deleted by the test; clean up B (service pool bypasses RLS).
    await query('DELETE FROM saved_search WHERE user_id = $1', [userB]).catch(() => {});
    await query('DELETE FROM user_profile WHERE id = $1', [userB]).catch(() => {});
    await closeUserPool();
    await closePool();
  });

  it("hard-deletes the caller's profile + saved searches and reports counts", async () => {
    const result = await deleteUserData(userA);
    expect(result.saved_searches_deleted).toBe(2);
    expect(result.profile_deleted).toBe(1);

    // Verify against real table state via the service pool (not through RLS).
    const prof = await query('SELECT id FROM user_profile WHERE id = $1', [userA]);
    expect(prof).toHaveLength(0);
    const ss = await query('SELECT id FROM saved_search WHERE user_id = $1', [userA]);
    expect(ss).toHaveLength(0);
  });

  it("leaves the OTHER user's data completely intact (RLS isolation)", async () => {
    const prof = await query('SELECT id FROM user_profile WHERE id = $1', [userB]);
    expect(prof).toHaveLength(1);
    const ss = await query('SELECT id FROM saved_search WHERE user_id = $1', [userB]);
    expect(ss).toHaveLength(2);
  });

  it('deleting an already-deleted account is a safe no-op (0 rows, no error)', async () => {
    const result = await deleteUserData(userA);
    expect(result.saved_searches_deleted).toBe(0);
    expect(result.profile_deleted).toBe(0);
  });

  it('after deletion, an export for that user returns nothing lingering', async () => {
    const ex = await exportUserData(userA);
    expect(ex.data.profile).toBeNull();
    expect(ex.data.saved_searches).toEqual([]);
  });
});
