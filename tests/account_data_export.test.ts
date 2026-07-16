// tests/account_data_export.test.ts — self-service data export against a real
// Postgres, driven through the RLS-enforcing user pool (withUserContext).
//
// Honest-boundary posture (same as the other user_* DB suites): no human OAuth
// click-through, but GIVEN a user id the export LOGIC is fully exercisable —
// exportUserData reads under the non-owner `authenticated` role with
// request.jwt.claim.sub set (exactly how Supabase/PostgREST drives auth.uid()),
// so a passing run proves the export can ONLY ever contain the caller's own rows.
// The critical security property — two distinct users, no cross-contamination —
// is asserted directly. Requires USER_DATABASE_URL; skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { exportUserData } from '../lib/db/account-data';
import { ensureUserProfile, updateUserProfile } from '../lib/db/user-profile';
import { createSavedSearch } from '../lib/db/saved-search';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { closePool } from '../lib/db/client';

const hasUserDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('exportUserData — owner-only data export (2 users)', () => {
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    await ensureUserProfile(userA, 'a@example.com');
    await updateUserProfile(userA, { home_postal: 'V6B 1A1', saved_child_ages: [24, 48], email_opt_in: true });
    await createSavedSearch(userA, { name: 'A swim', params: { q: 'swim' } });
    await createSavedSearch(userA, { name: 'A gym', params: { q: 'gym' } });

    await ensureUserProfile(userB, 'b@example.com');
    await updateUserProfile(userB, { home_postal: 'V5K 0A1', saved_child_ages: [12] });
    await createSavedSearch(userB, { name: 'B art', params: { q: 'art' } });
  });

  afterAll(async () => {
    // Clean up both users' rows (service pool bypasses RLS).
    const { query } = await import('../lib/db/client');
    for (const u of [userA, userB]) {
      await query('DELETE FROM saved_search WHERE user_id = $1', [u]).catch(() => {});
      await query('DELETE FROM user_profile WHERE id = $1', [u]).catch(() => {});
    }
    await closeUserPool();
    await closePool();
  });

  it("exports the calling user's profile and saved searches", async () => {
    const ex = await exportUserData(userA);
    expect(ex.format).toBe('kids-fun/account-export');
    expect(ex.version).toBe(1);
    expect(ex.user_id).toBe(userA);

    const profile = ex.data.profile as Record<string, unknown> | null;
    expect(profile).toBeTruthy();
    expect(profile!.id).toBe(userA);
    expect(profile!.home_postal).toBe('V6B 1A1');
    expect(profile!.saved_child_ages).toEqual([24, 48]);
    expect(profile!.email_opt_in).toBe(true);

    const searches = ex.data.saved_searches as Array<{ query_json: { name: string } }>;
    expect(searches).toHaveLength(2);
    const names = searches.map((s) => s.query_json.name).sort();
    expect(names).toEqual(['A gym', 'A swim']);
  });

  it("never includes the OTHER user's data anywhere (RLS isolation)", async () => {
    const ex = await exportUserData(userA);
    const serialized = JSON.stringify(ex);
    expect(serialized).not.toContain(userB);
    expect(serialized).not.toContain('V5K 0A1'); // B's postal
    expect(serialized).not.toContain('B art'); // B's saved search
  });

  it("is symmetric — B's export contains only B's data", async () => {
    const ex = await exportUserData(userB);
    const profile = ex.data.profile as Record<string, unknown> | null;
    expect(profile!.id).toBe(userB);
    const searches = ex.data.saved_searches as Array<unknown>;
    expect(searches).toHaveLength(1);
    expect(JSON.stringify(ex)).not.toContain(userA);
    expect(JSON.stringify(ex)).not.toContain('V6B 1A1');
  });

  it('honestly documents which datasets are excluded and why', async () => {
    const ex = await exportUserData(userA);
    expect(ex.manifest.included.map((i) => i.section)).toContain('profile');
    expect(ex.manifest.included.map((i) => i.section)).toContain('saved_searches');
    expect(ex.manifest.excluded.length).toBeGreaterThan(0);
    expect(ex.manifest.excluded[0].dataset).toMatch(/analytics_event/);
    expect(ex.manifest.excluded[0].reason).toMatch(/anonymous/i);
  });
});
