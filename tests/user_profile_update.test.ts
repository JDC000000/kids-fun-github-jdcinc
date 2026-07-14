// tests/user_profile_update.test.ts — profile updates against a real Postgres,
// driven through the RLS-enforcing user pool (withUserContext).
//
// Same honest-boundary posture as tests/user_profile_provisioning.test.ts: no
// human OAuth click-through, but GIVEN a valid user id the update LOGIC is fully
// exercisable — updateUserProfile runs under the non-owner `authenticated` role
// with request.jwt.claim.sub set (exactly how Supabase/PostgREST drives
// auth.uid()), so a passing run proves the owner INSERT/UPDATE RLS policies
// accept an owner's edit. Requires USER_DATABASE_URL; skips otherwise.
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensureUserProfile, getUserProfile, updateUserProfile } from '../lib/db/user-profile';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { closePool } from '../lib/db/client';

const hasUserDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('profile updates (updateUserProfile)', () => {
  afterAll(async () => {
    await closeUserPool();
    await closePool();
  });

  it('updates all editable fields and reads them back', async () => {
    const uid = randomUUID();
    await ensureUserProfile(uid, 'edit@example.com');

    const updated = await updateUserProfile(uid, {
      home_postal: 'V6B 1A1',
      saved_child_ages: [18, 36],
      email_opt_in: true,
    });

    expect(updated.id).toBe(uid);
    expect(updated.home_postal).toBe('V6B 1A1');
    expect(updated.saved_child_ages).toEqual([18, 36]);
    expect(updated.email_opt_in).toBe(true);

    const read = await getUserProfile(uid);
    expect(read?.home_postal).toBe('V6B 1A1');
    expect(read?.saved_child_ages).toEqual([18, 36]);
    expect(read?.email_opt_in).toBe(true);
  });

  it('applies partial updates without touching unspecified fields', async () => {
    const uid = randomUUID();
    await ensureUserProfile(uid, 'partial@example.com');
    await updateUserProfile(uid, { home_postal: 'V5K 0A1', saved_child_ages: [12] });

    // Now flip only email_opt_in.
    const updated = await updateUserProfile(uid, { email_opt_in: true });
    expect(updated.email_opt_in).toBe(true);
    expect(updated.home_postal).toBe('V5K 0A1'); // unchanged
    expect(updated.saved_child_ages).toEqual([12]); // unchanged
  });

  it('clears home_postal when set to null', async () => {
    const uid = randomUUID();
    await ensureUserProfile(uid, 'clear@example.com');
    await updateUserProfile(uid, { home_postal: 'V6B 1A1' });

    const cleared = await updateUserProfile(uid, { home_postal: null });
    expect(cleared.home_postal).toBeNull();
  });

  it('self-heals: updates a profile that was never explicitly provisioned', async () => {
    const uid = randomUUID();
    // No ensureUserProfile — updateUserProfile must INSERT-on-conflict the row first.
    const updated = await updateUserProfile(uid, { saved_child_ages: [6] });
    expect(updated.id).toBe(uid);
    expect(updated.saved_child_ages).toEqual([6]);
    expect(updated.email_opt_in).toBe(false); // schema default preserved
  });
});
