import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { query, closePool } from '../lib/db/client';

// G-T6-3 — RLS on user_profile + saved_search, owner-only (TSD §6.1, §9; <L3>).
// Runs each query as the local-dev `authenticated` role (supabase/local-dev/
// 000_auth_stub.sql) with a per-session `request.jwt.claim.sub` GUC standing
// in for a real JWT's sub claim — mirrors how PostgREST/Supabase drives
// auth.uid() in production, without needing a live Supabase project.
const hasDb = Boolean(process.env.DATABASE_URL);

function authenticatedConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'authenticated';
  url.password = 'local_dev_only_not_a_secret';
  return url.toString();
}

async function queryAs<T extends Record<string, unknown> = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = new Client({ connectionString: authenticatedConnectionString() });
  await client.connect();
  try {
    await client.query(`SET request.jwt.claim.sub = '${userId}'`);
    const res = await client.query<T>(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasDb)('RLS on user_profile + saved_search (G-T6-3, <L3>)', () => {
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

  it('user A can read their own user_profile', async () => {
    const rows = await queryAs(userAId, `SELECT id FROM user_profile WHERE id = $1`, [userAId]);
    expect(rows).toHaveLength(1);
  });

  it("user A cannot read user B's user_profile (security test)", async () => {
    const rows = await queryAs(userAId, `SELECT id FROM user_profile WHERE id = $1`, [userBId]);
    expect(rows).toHaveLength(0);
  });

  it('user A can read their own saved_search', async () => {
    const rows = await queryAs(userAId, `SELECT id FROM saved_search WHERE user_id = $1`, [userAId]);
    expect(rows).toHaveLength(1);
  });

  it("user A cannot read user B's saved_search (security test)", async () => {
    const rows = await queryAs(userAId, `SELECT id FROM saved_search WHERE user_id = $1`, [userBId]);
    expect(rows).toHaveLength(0);
  });

  it('an unauthenticated session (no jwt claim) sees no rows at all', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      const res = await client.query(`SELECT id FROM user_profile`);
      expect(res.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
