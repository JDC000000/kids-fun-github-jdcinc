// lib/db/saved-search.ts — owner-scoped CRUD for a parent's saved searches.
//
// Task 38 (M4 / G5). The saved_search table + its owner-only RLS already exist
// (0007_user_admin.sql + 0013_rls_user.sql, owner select/insert/update/delete on
// auth.uid() = user_id) and are proven live by tests/user_scoped_client.test.ts.
// Nothing in the app read or wrote the table yet — this module is the APPLICATION
// layer on top, mirroring lib/db/user-profile.ts.
//
// EVERY access goes through withUserContext (the RLS-enforcing USER_DATABASE_URL
// role), NEVER lib/db/client.ts's service pool — so a signed-in user can only
// ever see or delete their OWN saved searches. RLS is the real ownership boundary;
// the explicit `user_id = $userId` filters below are defense-in-depth and keep
// delete's "was anything there?" answer honest.
//
// Persistence shape: saved_search has one jsonb payload column, `query_json`, and
// no name column, so a saved search is stored as the canonical envelope
//   query_json = { name: string | null, params: {...} }
// (see lib/user/saved-search-validate.ts).
import { withUserContext } from './user-scoped-client';
import type { SavedSearchInput } from '../user/saved-search-validate';

/** A saved search as surfaced to the API/UI (envelope unwrapped). */
export interface SavedSearch {
  id: string;
  name: string | null;
  params: Record<string, unknown>;
  created_at: string;
  last_run_at: string | null;
}

interface SavedSearchRow {
  id: string;
  query_json: unknown;
  created_at: string;
  last_run_at: string | null;
}

const COLUMNS = 'id, query_json, created_at, last_run_at';

/** Unwrap the stored envelope defensively — a row written by an older/other path
 *  (e.g. the raw `'{}'` rows the RLS tests insert) still maps cleanly. */
function mapRow(row: SavedSearchRow): SavedSearch {
  const envelope =
    row.query_json && typeof row.query_json === 'object' && !Array.isArray(row.query_json)
      ? (row.query_json as Record<string, unknown>)
      : {};
  const name = typeof envelope.name === 'string' ? envelope.name : null;
  const params =
    envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
      ? (envelope.params as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    name,
    params,
    created_at: row.created_at,
    last_run_at: row.last_run_at,
  };
}

/** Owner-scoped list of the current user's saved searches, newest first. */
export async function listSavedSearches(userId: string): Promise<SavedSearch[]> {
  return withUserContext(userId, async (db) => {
    const rows = await db.query<SavedSearchRow>(
      `SELECT ${COLUMNS} FROM saved_search WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map(mapRow);
  });
}

/**
 * Create a saved search for the current user. The owner INSERT policy
 * (auth.uid() = user_id) guarantees the row is written under this user only;
 * passing user_id = userId is what satisfies that WITH CHECK.
 */
export async function createSavedSearch(userId: string, input: SavedSearchInput): Promise<SavedSearch> {
  const envelope = { name: input.name, params: input.params };
  return withUserContext(userId, async (db) => {
    const rows = await db.query<SavedSearchRow>(
      `INSERT INTO saved_search (user_id, query_json)
         VALUES ($1, $2::jsonb)
         RETURNING ${COLUMNS}`,
      [userId, JSON.stringify(envelope)]
    );
    if (!rows[0]) {
      // Unreachable in a correct config: we just inserted under this uid.
      throw new Error('createSavedSearch: insert returned no row (RLS/role misconfiguration?)');
    }
    return mapRow(rows[0]);
  });
}

/**
 * Owner-scoped delete. Returns true if a row was deleted, false if none matched —
 * either because the id doesn't exist OR because it belongs to another user (the
 * owner DELETE policy, auth.uid() = user_id, hides other users' rows entirely, so
 * a cross-user delete simply affects zero rows). Callers map false → 404.
 */
export async function deleteSavedSearch(userId: string, id: string): Promise<boolean> {
  return withUserContext(userId, async (db) => {
    const rows = await db.query<{ id: string }>(
      `DELETE FROM saved_search WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );
    return rows.length > 0;
  });
}
