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
// This module is the fix, in two layers:
//   • runWithUserContext(client, userId, fn) — the CORE: given ANY pg connection,
//     opens a transaction, sets `request.jwt.claim.sub` for that transaction only
//     (SET LOCAL semantics via set_config's is_local=true arg), runs the
//     callback, commits/rolls back. Dependency-injected on the client so it is
//     exercisable in CI against a raw Client connected as the local `authenticated`
//     role — under the existing DATABASE_URL, no extra env var required.
//   • withUserContext(userId, fn) — the RUNTIME wrapper: borrows a connection from
//     a dedicated pool on USER_DATABASE_URL (a low-privilege, RLS-subject role —
//     `authenticated` on Supabase, or the local-dev stub's `authenticated` role)
//     and delegates to the core. Every future user_profile/saved_search read or
//     write MUST go through this, not lib/db/client.ts's query().
import { Pool, type ClientBase, type QueryResultRow } from 'pg';

// auth.uid() expects the sub claim to be a uuid. Validate the format (null-aware —
// null is a legitimate anonymous request) BEFORE it reaches Postgres, so a
// malformed id fails with a clear error here rather than as an opaque uuid-cast
// error inside a policy check. This is defense-in-depth on top of parameterization.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * CORE. Runs `fn` inside a transaction on `client` where `auth.uid()` resolves to
 * `userId` for every RLS check in that transaction only (set_config's is_local=true
 * — the Postgres equivalent of SET LOCAL, so it can't leak to a pooled connection's
 * next borrower). Pass `userId = null` for an anonymous request; RLS policies then
 * correctly see no owner match (auth.uid() IS NULL), same as a real unauthenticated
 * Supabase request. Exported (and client-injected) so it can be exercised against
 * any pg connection — e.g. the local-dev `authenticated` role in tests — without a
 * pool or process env.
 */
export async function runWithUserContext<T>(
  client: ClientBase,
  userId: string | null,
  fn: (db: UserScopedQuery) => Promise<T>
): Promise<T> {
  if (userId !== null && !UUID_RE.test(userId)) {
    throw new Error('runWithUserContext: userId must be a UUID (the authenticated user id) or null (anonymous)');
  }
  await client.query('BEGIN');
  try {
    // Parameterized set_config (NOT string interpolation) — userId never enters
    // SQL text. is_local=true scopes the setting to this transaction, so it
    // reverts automatically on COMMIT/ROLLBACK and is safe on a pooled connection
    // a later query reuses for a different user.
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
  }
}

/**
 * RUNTIME wrapper. Borrows a connection from the dedicated USER_DATABASE_URL pool
 * (a non-owner, RLS-subject role — never the service/owner role, which bypasses
 * RLS) and delegates to runWithUserContext. Always releases the connection.
 *
 * Usage (from a server route, once a live CRUD endpoint exists):
 *   const rows = await withUserContext(session.userId, (db) =>
 *     db.query('SELECT id, home_postal FROM user_profile WHERE id = $1', [session.userId])
 *   );
 */
export async function withUserContext<T>(
  userId: string | null,
  fn: (db: UserScopedQuery) => Promise<T>
): Promise<T> {
  const client = await getUserPool().connect();
  try {
    return await runWithUserContext(client, userId, fn);
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
