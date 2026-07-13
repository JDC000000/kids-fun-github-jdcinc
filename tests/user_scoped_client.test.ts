import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withUserContext, closeUserPool } from '../lib/db/user-scoped-client';
import { query, closePool } from '../lib/db/client';

// Code review 2026-07-13 (backend-auth-rls blocker 2): the raw-pg data layer
// didn't wire auth.uid() claims into DB sessions, so RLS on user_profile/
// saved_search would either be bypassed (privileged connection) or block
// everything (restricted connection, no claim set). This proves the fix
// (lib/db/user-scoped-client.ts) actually enforces per-user RLS through the
// helper future app code is required to use — not just via an ad-hoc test
// Client construction like tests/rls_user.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

describe.skipIf(!hasDb)('withUserContext (code review backend-auth-rls blocker 2)', () => {
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
    await query(`INSERT INTO saved_search (user_id, query_json) VALUES ($1, '{}')`, [userAId]);
    await query(`INSERT INTO saved_search (user_id, query_json) VALUES ($1, '{}')`, [userBId]);
  });

  afterAll(async () => {
    await closeUserPool();
    await closePool();
  });

  it("user A's transaction sees only their own saved_search via the production helper", async () => {
    const rows = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    expect(rows).toHaveLength(1);
  });

  it("user A's transaction cannot see user B's saved_search via the production helper", async () => {
    const rows = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userBId])
    );
    expect(rows).toHaveLength(0);
  });

  it('an anonymous context (userId=null) sees no user_profile rows at all', async () => {
    const rows = await withUserContext(null, (db) => db.query(`SELECT id FROM user_profile`));
    expect(rows).toHaveLength(0);
  });

  it('the claim does not leak across transactions on a pooled connection (SET LOCAL semantics)', async () => {
    const asA = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    const asB = await withUserContext(userBId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    expect(asA).toHaveLength(1); // A sees their own row
    expect(asB).toHaveLength(0); // B does not, even reusing a connection A just used
  });

  it('a failed query rolls back cleanly (no dangling transaction/claim on the connection)', async () => {
    await expect(
      withUserContext(userAId, async (db) => {
        await db.query(`SELECT 1/0`); // force an error inside the transaction
      })
    ).rejects.toThrow();

    // Connection should be usable again afterwards with a clean state.
    const rows = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    expect(rows).toHaveLength(1);
  });
});
