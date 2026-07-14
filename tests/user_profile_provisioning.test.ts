// tests/user_profile_provisioning.test.ts — first-login provisioning against a
// real Postgres, driven through the RLS-enforcing user pool (withUserContext).
//
// This is the honest-boundary verification for Task 21: without a human OAuth
// click-through we cannot mint a real Supabase JWT, but GIVEN a valid user id
// the provisioning LOGIC is fully exercisable — ensureUserProfile runs under the
// non-owner `authenticated` role with `request.jwt.claim.sub` set (exactly how
// Supabase/PostgREST drives auth.uid() in production), so a passing run proves
// the owner INSERT/SELECT RLS policies accept a first-login upsert. Mirrors the
// SET-LOCAL-role + set_config harness of tests/rls_user.test.ts.
//
// Requires USER_DATABASE_URL (the non-owner role) — CI sets it; the suite skips
// otherwise. Rows are left in place (ephemeral CI DB), same as the sibling RLS
// tests.
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensureUserProfile, getUserProfile } from '../lib/db/user-profile';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { query, closePool } from '../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const hasUserDb = hasDb && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('first-login provisioning (ensureUserProfile / getUserProfile)', () => {
  afterAll(async () => {
    await closeUserPool();
    await closePool();
  });

  it('getUserProfile returns null before the user has ever signed in', async () => {
    const uid = randomUUID();
    expect(await getUserProfile(uid)).toBeNull();
  });

  it('creates the profile row on first login (created=true) and it is owner-visible', async () => {
    const uid = randomUUID();
    const { profile, created } = await ensureUserProfile(uid, 'first@example.com');

    expect(created).toBe(true);
    expect(profile.id).toBe(uid);
    expect(profile.saved_child_ages).toEqual([]); // schema default
    expect(profile.email_opt_in).toBe(false); // schema default

    // A fresh owner-scoped read now sees the row.
    const read = await getUserProfile(uid);
    expect(read?.id).toBe(uid);
  });

  it('is idempotent on a returning login (created=false, no duplicate row)', async () => {
    const uid = randomUUID();
    await ensureUserProfile(uid, 'returning@example.com');
    const second = await ensureUserProfile(uid, 'returning@example.com');

    expect(second.created).toBe(false);
    expect(second.profile.id).toBe(uid);

    // Exactly one row — verified via the service pool (bypasses RLS).
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_profile WHERE id = $1`,
      [uid]
    );
    expect(rows[0].n).toBe('1');
  });

  it('provisions each user under their own id independently', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const ra = await ensureUserProfile(a, 'a@example.com');
    const rb = await ensureUserProfile(b, 'b@example.com');

    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
    expect((await getUserProfile(a))?.id).toBe(a);
    expect((await getUserProfile(b))?.id).toBe(b);
  });
});
