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
import type { ProfilePatch } from '../lib/user/profile-validate';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { closePool, query } from '../lib/db/client';

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
      email_opt_in: true,
    });

    expect(updated.id).toBe(uid);
    expect(updated.home_postal).toBe('V6B 1A1');
    expect(updated.email_opt_in).toBe(true);

    const read = await getUserProfile(uid);
    expect(read?.home_postal).toBe('V6B 1A1');
    expect(read?.email_opt_in).toBe(true);
  });

  it('applies partial updates without touching unspecified fields', async () => {
    const uid = randomUUID();
    await ensureUserProfile(uid, 'partial@example.com');
    await updateUserProfile(uid, { home_postal: 'V5K 0A1' });

    // Now flip only email_opt_in.
    const updated = await updateUserProfile(uid, { email_opt_in: true });
    expect(updated.email_opt_in).toBe(true);
    expect(updated.home_postal).toBe('V5K 0A1'); // unchanged
  });

  it('IGNORES saved_child_ages on write (F-8 — no longer a writable field)', async () => {
    const uid = randomUUID();
    await ensureUserProfile(uid, 'noages@example.com');

    // Seed a legacy value directly (service pool bypasses RLS + the app layer),
    // simulating a row from before collection stopped.
    await query('UPDATE user_profile SET saved_child_ages = $1 WHERE id = $2', [[24, 48], uid]);

    // A patch that tries to write saved_child_ages must NOT touch the column.
    // The type no longer permits the key, so cast to prove the runtime guard
    // (updateUserProfile's UPDATABLE_COLUMNS) drops it, not just the type-checker.
    await updateUserProfile(uid, { saved_child_ages: [1, 2, 3], home_postal: 'V6B 1A1' } as unknown as ProfilePatch);

    const rows = await query<{ saved_child_ages: number[]; home_postal: string | null }>(
      'SELECT saved_child_ages, home_postal FROM user_profile WHERE id = $1',
      [uid]
    );
    expect(rows[0].saved_child_ages).toEqual([24, 48]); // legacy value untouched
    expect(rows[0].home_postal).toBe('V6B 1A1'); // the valid field still applied
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
    const updated = await updateUserProfile(uid, { home_postal: 'V5K 0A1' });
    expect(updated.id).toBe(uid);
    expect(updated.home_postal).toBe('V5K 0A1');
    expect(updated.email_opt_in).toBe(false); // schema default preserved
  });
});
