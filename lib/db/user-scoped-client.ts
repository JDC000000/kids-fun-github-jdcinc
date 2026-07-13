// lib/db/user-scoped-client.ts — per-request RLS-enforcing data access.
//
// lib/db/client.ts's shared pool (DATABASE_URL) is SERVICE-LEVEL access —
// migrations, seeds, the ingestion worker, and lib/db/admin-guard.ts all need
// to read/write across every row, unrestricted by RLS. That pool must NOT be
// used for user-facing CRUD on RLS-protected tables (user_profile,
// saved_search): with the raw-`pg` data-layer decision (no supabase-js CRUD,
// Supabase Auth only at the OAuth/session boundary), nothing was otherwise
// wiring auth.uid() claims into a DB session, so RLS policies would either be
// silently bypassed (a privileged connection) or block everything (a
// restricted connection with no claim set) — a real gap, not caught until
// code review.
//
// This module is the fix: withUserContext() opens a dedicated connection on
// USER_DATABASE_URL (a low-privilege, RLS-subject role — `authenticated` on
// Supabase, or the local-dev stub's `authenticated` role), sets
// `request.jwt.claim.sub` for that transaction only (SET LOCAL semantics via
// set_config's third arg), runs the callback, and commits/rolls back. Every
// future user_profile/saved_search read or write MUST go through this, not
// lib/db/client.ts's query().
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let userPool: Pool | undefined;

function getUserPool(): Pool {
  if (!userPool) {
    const connectionString = process.env.USER_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'USER_DATABASE_URL is not set — required for RLS-enforcing user CRUD (see lib/db/user-scoped-client.ts header). ' +
          'Do not fall back to DATABASE_URL: that connection is service-level and bypasses RLS.'
      );
    }
    userPool = new Pool({ connectionString, max: 5 });
  }
  return userPool;
}

export interface UserScopedQuery {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Runs `fn` inside a transaction where `auth.uid()` resolves to `userId` for
 * every RLS check in that transaction only (set_config's is_local=true — the
 * Postgres equivalent of SET LOCAL, so it can't leak to a pooled connection's
 * next borrower). Pass `userId = null` for an anonymous request; RLS policies
 * then correctly see no owner match (auth.uid() IS NULL), same as a real
 * unauthenticated Supabase request.
 */
export async function withUserContext<T>(
  userId: string | null,
  fn: (db: UserScopedQuery) => Promise<T>
): Promise<T> {
  const client: PoolClient = await getUserPool().connect();
  try {
    await client.query('BEGIN');
    // set_config(name, value, is_local=true) == SET LOCAL — scoped to this
    // transaction, reverts automatically on COMMIT/ROLLBACK, safe on a pooled
    // connection that a later query will reuse for a different user.
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);

    const scoped: UserScopedQuery = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
        const { rows } = await client.query<R>(text, params);
        return rows;
      },
    };

    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closeUserPool(): Promise<void> {
  if (userPool) {
    await userPool.end();
    userPool = undefined;
  }
}
