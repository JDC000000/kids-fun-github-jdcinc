// lib/db/user-profile.ts — first-login provisioning + owner-scoped profile read.
//
// Task 21 (M4, account/session foundation). The account tables (user_profile,
// saved_search) and their owner-only RLS already exist and are proven end-to-end
// by tests/rls_user.test.ts (0007_user_admin.sql + 0013_rls_user.sql). This
// module is the APPLICATION layer on top.
//
// There is NO auth.users -> user_profile database trigger: 0007 deliberately
// declares no FK into the Supabase-managed `auth` schema (so migrations apply on
// a bare Postgres too), and no trigger was ever added. So on a user's first
// successful Google sign-in, nothing creates their profile row automatically —
// the application must do it. Every access here goes through withUserContext
// (RLS-enforcing, USER_DATABASE_URL role), NEVER lib/db/client.ts's service pool,
// so an owner can only ever touch their own row.
import { withUserContext, type UserScopedQuery } from './user-scoped-client';

export interface UserProfile {
  id: string;
  home_postal: string | null;
  saved_child_ages: number[];
  email_opt_in: boolean;
}

// Only the columns this first slice reads. Deliberately excludes google_identity
// (set once at provisioning, never surfaced) and the timestamps (not needed yet).
const PROFILE_COLUMNS = 'id, home_postal, saved_child_ages, email_opt_in';

/**
 * Idempotent first-login provisioning + read, in ONE RLS-scoped transaction.
 *
 * INSERT ... ON CONFLICT (id) DO NOTHING creates the row only on first login —
 * `auth.uid() = id` satisfies the owner INSERT policy, and DO NOTHING makes a
 * repeat login a no-op (never consults the SELECT policy, so it can't error).
 * The follow-up SELECT returns the profile whether it was just created or already
 * existed. `created` lets callers distinguish a first login from a returning one.
 */
export async function ensureUserProfile(
  userId: string,
  googleIdentity?: string | null
): Promise<{ profile: UserProfile; created: boolean }> {
  return withUserContext(userId, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO user_profile (id, google_identity)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
      [userId, googleIdentity ?? null]
    );
    const created = inserted.length > 0;

    const profile = await readProfile(db, userId);
    if (!profile) {
      // Unreachable in a correctly-configured environment: we just inserted-or-
      // confirmed the row under this same uid. If RLS hides it, that's a real
      // misconfiguration (wrong role / claim) worth surfacing, not swallowing.
      throw new Error('ensureUserProfile: profile not visible after upsert (RLS/role misconfiguration?)');
    }
    return { profile, created };
  });
}

/** Owner-scoped read of the current user's profile. Null if none exists yet. */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  return withUserContext(userId, (db) => readProfile(db, userId));
}

async function readProfile(db: UserScopedQuery, userId: string): Promise<UserProfile | null> {
  const rows = await db.query<UserProfile>(
    `SELECT ${PROFILE_COLUMNS} FROM user_profile WHERE id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}
