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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { exportUserData } from '../lib/db/account-data';
import { ensureUserProfile, updateUserProfile } from '../lib/db/user-profile';
import { createSavedSearch } from '../lib/db/saved-search';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { closePool, query } from '../lib/db/client';

// F-9: the export resolves the sign-in email on-demand (auth.users via the
// service-role admin API) instead of reading the redundant stored google_identity
// copy. Mock that resolver to a fixed address so we can assert the export carries
// the live-resolved email without needing a real Supabase auth backend. The value
// deliberately embeds no user id, so the cross-user isolation assertions below
// (never contains the OTHER user's id) still hold.
const RESOLVED_EMAIL = 'owner@example.com';
vi.mock('../lib/email/recipients', () => ({
  resolveRecipientEmail: vi.fn(async () => ({ email: 'owner@example.com', attempted: true })),
}));

const hasUserDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('exportUserData — owner-only data export (2 users)', () => {
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    await ensureUserProfile(userA, 'a@example.com');
    await updateUserProfile(userA, { home_postal: 'V6B 1A1', email_opt_in: true });
    // Legacy saved_child_ages: seeded directly via the service pool to simulate a
    // value stored BEFORE F-8 stopped collection. The app no longer writes this
    // column; this proves the export STILL surfaces legacy values (PIPEDA).
    await query('UPDATE user_profile SET saved_child_ages = $1 WHERE id = $2', [[24, 48], userA]);
    await createSavedSearch(userA, { name: 'A swim', params: { q: 'swim' } });
    await createSavedSearch(userA, { name: 'A gym', params: { q: 'gym' } });

    await ensureUserProfile(userB, 'b@example.com');
    await updateUserProfile(userB, { home_postal: 'V5K 0A1' });
    await query('UPDATE user_profile SET saved_child_ages = $1 WHERE id = $2', [[12], userB]);
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
    // F-8: legacy children's-ages value (seeded pre-collection-stop) is STILL
    // exported — a user is entitled to see what's stored, even legacy data.
    expect(profile!.saved_child_ages).toEqual([24, 48]);
    expect(profile!.email_opt_in).toBe(true);
    // F-9: the sign-in email is resolved on-demand (not read from a stored copy),
    // and the redundant google_identity column is no longer surfaced at all.
    expect(profile!.email).toBe(RESOLVED_EMAIL);
    expect('google_identity' in profile!).toBe(false);

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
