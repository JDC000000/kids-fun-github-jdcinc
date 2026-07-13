import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { runWithUserContext, withUserContext, closeUserPool } from '../lib/db/user-scoped-client';
import { query, closePool } from '../lib/db/client';

// Code review 2026-07-13 (backend-auth-rls blocker 2): the raw-pg data layer
// didn't wire auth.uid() claims into DB sessions, so RLS on user_profile/
// saved_search would either be bypassed (privileged connection) or block
// everything (restricted connection, no claim set). These tests prove the fix
// (lib/db/user-scoped-client.ts) actually enforces per-user RLS.
//
// The CORE suite drives runWithUserContext against a raw Client connected as the
// local-dev `authenticated` role, derived from the SAME DATABASE_URL CI already
// sets (username/password swapped) — so the wiring is genuinely exercised in CI
// with NO extra env var. A separate suite drives the withUserContext pool wrapper
// when USER_DATABASE_URL is configured (ci.yml sets it to the authenticated role).
const hasDb = Boolean(process.env.DATABASE_URL);
const hasUserDb = hasDb && Boolean(process.env.USER_DATABASE_URL);

function authenticatedConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'authenticated';
  url.password = 'local_dev_only_not_a_secret';
  return url.toString();
}

async function withAuthenticatedClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: authenticatedConnectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ── CORE: runs under CI's existing DATABASE_URL, no USER_DATABASE_URL needed ────
describe.skipIf(!hasDb)('runWithUserContext — auth.uid()/SET LOCAL/RLS wiring (core)', () => {
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
    await closePool();
  });

  it('makes auth.uid() resolve to the scoped user id', async () => {
    const uid = await withAuthenticatedClient((client) =>
      runWithUserContext(client, userAId, async (db) => {
        const rows = await db.query<{ uid: string }>(`SELECT auth.uid() AS uid`);
        return rows[0].uid;
      })
    );
    expect(uid).toBe(userAId);
  });

  it('owner RLS lets the scoped user read only their own user_profile', async () => {
    const rows = await withAuthenticatedClient((client) =>
      runWithUserContext(client, userAId, (db) => db.query<{ id: string }>(`SELECT id FROM user_profile`))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userAId);
  });

  it("scoped user A cannot see user B's saved_search (cross-user isolation)", async () => {
    const rows = await withAuthenticatedClient((client) =>
      runWithUserContext(client, userAId, (db) =>
        db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userBId])
      )
    );
    expect(rows).toHaveLength(0);
  });

  it('an anonymous context (userId=null) sees no user_profile rows at all', async () => {
    const rows = await withAuthenticatedClient((client) =>
      runWithUserContext(client, null, (db) => db.query(`SELECT id FROM user_profile`))
    );
    expect(rows).toHaveLength(0);
  });

  it('the scope is transaction-local — auth.uid() reverts to NULL on the same connection after COMMIT', async () => {
    await withAuthenticatedClient(async (client) => {
      await runWithUserContext(client, userAId, async (db) => {
        const inside = await db.query<{ uid: string | null }>(`SELECT auth.uid() AS uid`);
        expect(inside[0].uid).toBe(userAId);
      });
      const after = await client.query<{ uid: string | null }>(`SELECT auth.uid() AS uid`);
      expect(after.rows[0].uid).toBeNull();
    });
  });

  it('rolls back and rethrows when the callback throws (no partial writes)', async () => {
    const marker = `rollback-probe-${userAId}`;
    await expect(
      withAuthenticatedClient((client) =>
        runWithUserContext(client, userAId, async (db) => {
          await db.query(`UPDATE user_profile SET google_identity = $1 WHERE id = $2`, [marker, userAId]);
          throw new Error('boom');
        })
      )
    ).rejects.toThrow('boom');

    const rows = await query<{ google_identity: string | null }>(
      `SELECT google_identity FROM user_profile WHERE id = $1`,
      [userAId]
    );
    expect(rows[0].google_identity).not.toBe(marker);
  });

  it('rejects a non-UUID userId before touching the DB (null is allowed = anonymous)', async () => {
    await withAuthenticatedClient(async (client) => {
      await expect(runWithUserContext(client, 'not-a-uuid', async () => 'x')).rejects.toThrow(/UUID/);
    });
  });
});

// ── Fail-closed guard: deterministic, no DB — always runs ──────────────────────
describe('withUserContext fails closed without USER_DATABASE_URL', () => {
  it('throws (never falls back to the service/owner pool) when USER_DATABASE_URL is unset', async () => {
    const saved = process.env.USER_DATABASE_URL;
    delete process.env.USER_DATABASE_URL;
    try {
      vi.resetModules();
      const mod = await import('../lib/db/user-scoped-client');
      await expect(
        mod.withUserContext('11111111-1111-1111-1111-111111111111', async () => 'unreachable')
      ).rejects.toThrow(/USER_DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.USER_DATABASE_URL = saved;
      vi.resetModules();
    }
  });
});

// ── Pool wrapper end-to-end: runs when USER_DATABASE_URL is configured (ci.yml) ─
describe.skipIf(!hasUserDb)('withUserContext — pool wrapper over USER_DATABASE_URL', () => {
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

  it('user A sees only their own saved_search via the production helper', async () => {
    const rows = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    expect(rows).toHaveLength(1);
  });

  it("user A cannot see user B's saved_search via the production helper", async () => {
    const rows = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userBId])
    );
    expect(rows).toHaveLength(0);
  });

  it('the claim does not leak across transactions on a pooled connection', async () => {
    const asA = await withUserContext(userAId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    const asB = await withUserContext(userBId, (db) =>
      db.query<{ id: string }>(`SELECT id FROM saved_search WHERE user_id = $1`, [userAId])
    );
    expect(asA).toHaveLength(1); // A sees their own row
    expect(asB).toHaveLength(0); // B does not, even reusing a connection A just used
  });
});
