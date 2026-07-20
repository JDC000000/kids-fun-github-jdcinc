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
import type { ProfilePatch } from '../user/profile-validate';

export interface UserProfile {
  id: string;
  home_postal: string | null;
  saved_child_ages: number[];
  email_opt_in: boolean;
}

// Only the columns this slice reads. Deliberately excludes google_identity (no
// longer written as of F-9 — email is resolved on-demand from auth.users) and the
// timestamps (not needed yet). saved_child_ages is still READ here so legacy rows
// stay visible on /account and remain exportable, even though F-8 stopped
// collecting new values (it is no longer a writable field — see UPDATABLE_COLUMNS).
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
  // Accepted for signature stability (callers pass the sign-in email), but as of
  // F-9 (PIPEDA / Round 25 Task WW) it is DELIBERATELY NOT PERSISTED. Storing the
  // Google email into user_profile.google_identity only duplicated what Supabase
  // already holds in auth.users; the weekly digest and the data export both
  // resolve the address on-demand via resolveRecipientEmail() (service-role admin
  // API), so the second copy bought nothing and added a redundant PII surface.
  _googleIdentity?: string | null
): Promise<{ profile: UserProfile; created: boolean }> {
  return withUserContext(userId, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO user_profile (id)
         VALUES ($1)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
      [userId]
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

// Editable columns → their patch keys. Order fixed so the generated SQL is stable
// (aids testing/logging). google_identity, id, home_geo and the timestamps are
// deliberately absent: identity/geocoded/auto-managed, not user-editable here.
// saved_child_ages was REMOVED here by F-8 (PIPEDA / Round 25 Task WW): the app no
// longer collects or writes children's ages. Even if a patch somehow carries the
// key it is silently ignored (parseProfilePatch already rejects it upstream as an
// unknown field); legacy values are left untouched and stay exportable/deletable.
const UPDATABLE_COLUMNS = ['home_postal', 'email_opt_in'] as const;

/**
 * Owner-scoped partial update of the current user's profile.
 *
 * Runs in ONE RLS-enforced transaction: first an idempotent
 * `INSERT ... ON CONFLICT DO NOTHING` self-heals the row if it wasn't provisioned
 * yet (auth.uid() = id satisfies the owner INSERT policy), then an UPDATE writes
 * only the fields present in `patch` (PATCH semantics — an absent key is left
 * untouched). The owner UPDATE policy (auth.uid() = id) guarantees a signed-in
 * user can only ever mutate their own row; there is no service-pool path here.
 * Returns the full, updated profile. A `patch` with no recognized fields is a
 * no-op that simply returns the current row (callers should reject empty patches
 * upstream via parseProfilePatch, but this stays safe regardless).
 */
export async function updateUserProfile(userId: string, patch: ProfilePatch): Promise<UserProfile> {
  return withUserContext(userId, async (db) => {
    // Self-heal: ensure the row exists before updating. Identical to the
    // provisioning INSERT in ensureUserProfile (id-only since F-9 stopped writing
    // google_identity) — an id-only owner INSERT satisfies auth.uid() = id.
    await db.query(
      `INSERT INTO user_profile (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId]
    );

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const col of UPDATABLE_COLUMNS) {
      if (col in patch) {
        params.push((patch as Record<string, unknown>)[col]);
        sets.push(`${col} = $${params.length}`);
      }
    }

    if (sets.length === 0) {
      const current = await readProfile(db, userId);
      if (!current) {
        throw new Error('updateUserProfile: profile not visible after upsert (RLS/role misconfiguration?)');
      }
      return current;
    }

    params.push(userId);
    const rows = await db.query<UserProfile>(
      `UPDATE user_profile SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING ${PROFILE_COLUMNS}`,
      params
    );
    if (!rows[0]) {
      // Unreachable in a correct config: we just ensured the row under this uid.
      throw new Error('updateUserProfile: no row updated (RLS/role misconfiguration?)');
    }
    return rows[0];
  });
}

async function readProfile(db: UserScopedQuery, userId: string): Promise<UserProfile | null> {
  const rows = await db.query<UserProfile>(
    `SELECT ${PROFILE_COLUMNS} FROM user_profile WHERE id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}
