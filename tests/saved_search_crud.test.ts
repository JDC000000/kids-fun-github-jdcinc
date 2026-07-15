// tests/saved_search_crud.test.ts — real-Postgres ownership proof for the
// saved-search data layer (Task 38, M4/G5).
//
// Proves the application CRUD (lib/db/saved-search.ts) is genuinely owner-scoped
// end-to-end through the production withUserContext helper (RLS `authenticated`
// role), NOT just by our own WHERE clauses: a user creates + lists only their own
// saved searches, and can neither see nor delete another user's — enforced by the
// owner-only RLS policies (0013_rls_user.sql). Mirrors the setup of
// tests/user_scoped_client.test.ts: profiles/rows are seeded via the SERVICE pool
// (lib/db/client), the assertions run through the RLS-subject pool.
//
// Runs only when USER_DATABASE_URL is configured (ci.yml sets it to the
// authenticated role); otherwise it skips, exactly like the existing RLS suites.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  listSavedSearches,
  createSavedSearch,
  deleteSavedSearch,
} from '../lib/db/saved-search';
import { withUserContext, closeUserPool } from '../lib/db/user-scoped-client';
import { query, closePool } from '../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const hasUserDb = hasDb && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasUserDb)('saved-search CRUD is owner-scoped via RLS (Task 38)', () => {
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    const [a] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    const [b] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    userAId = a.id;
    userBId = b.id;
  });

  afterAll(async () => {
    await closeUserPool();
    await closePool();
  });

  it('creates a saved search and reads it back (name + params round-trip)', async () => {
    const created = await createSavedSearch(userAId, {
      name: 'Toddler swim',
      params: { q: 'swim', region: 'van', sort: 'soonest' },
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe('Toddler swim');
    expect(created.params).toEqual({ q: 'swim', region: 'van', sort: 'soonest' });
    expect(created.last_run_at).toBeNull();

    const list = await listSavedSearches(userAId);
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  it('lists only the current user’s saved searches', async () => {
    await createSavedSearch(userAId, { name: 'A-only', params: { q: 'a' } });
    const bSearch = await createSavedSearch(userBId, { name: 'B-only', params: { q: 'b' } });

    const aList = await listSavedSearches(userAId);
    expect(aList.every((s) => s.name !== 'B-only')).toBe(true);
    expect(aList.some((s) => !s.id)).toBe(false);
    // A cannot even see B's row id.
    expect(aList.find((s) => s.id === bSearch.id)).toBeUndefined();
  });

  it("a user cannot delete another user's saved search (returns false, row survives)", async () => {
    const aSearch = await createSavedSearch(userAId, { name: 'Guard me', params: { q: 'guard' } });

    // B attempts to delete A's row via the production helper.
    const deletedByB = await deleteSavedSearch(userBId, aSearch.id);
    expect(deletedByB).toBe(false);

    // And RLS itself hides it: scoped as B, a raw unfiltered delete affects zero rows.
    const rawByB = await withUserContext(userBId, (db) =>
      db.query<{ id: string }>(`DELETE FROM saved_search WHERE id = $1 RETURNING id`, [aSearch.id])
    );
    expect(rawByB).toHaveLength(0);

    // A's row is still there and still visible to A.
    const aList = await listSavedSearches(userAId);
    expect(aList.some((s) => s.id === aSearch.id)).toBe(true);
  });

  it('a user can delete their own saved search', async () => {
    const aSearch = await createSavedSearch(userAId, { name: 'Delete me', params: { q: 'del' } });
    const deleted = await deleteSavedSearch(userAId, aSearch.id);
    expect(deleted).toBe(true);

    const aList = await listSavedSearches(userAId);
    expect(aList.some((s) => s.id === aSearch.id)).toBe(false);
  });

  it("a user cannot see another user's saved search by id (RLS SELECT)", async () => {
    const bSearch = await createSavedSearch(userBId, { name: 'B secret', params: { q: 'secret' } });
    const seenByA = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE id = $1`, [bSearch.id])
    );
    expect(seenByA).toHaveLength(0);
  });
});
