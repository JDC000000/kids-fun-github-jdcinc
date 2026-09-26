import { Client } from 'pg';
import { assertTestDatabaseUrl } from '../../../lib/testing/local-db-guard';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// tests/e2e/helpers/db.ts — small Postgres helpers for E2E fixtures.
//
// These use the SERVICE-level DATABASE_URL (owner role) purely to SET UP and TEAR
// DOWN test data (e.g. seed a saved_search row so the /account list has something
// to render, then delete it). This is test scaffolding, not the code under test:
// the app itself still reads that data through its RLS-enforcing USER_DATABASE_URL
// path, so what the E2E asserts is the real owner-scoped read.

function serviceDbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — required for E2E DB fixtures.');
  return url;
}

async function withServiceDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: serviceDbUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The id/email of the test user, written by tests/e2e/auth.setup.ts. */
export function readTestUser(): { id: string; email: string } {
  const raw = readFileSync(resolve('tests/e2e/.auth/user.json'), 'utf8');
  return JSON.parse(raw) as { id: string; email: string };
}

/**
 * Seed a saved_search row for the test user (upserting the user_profile row first
 * to satisfy the FK). Returns the new saved_search id. Owner-level write — RLS is
 * exercised on the READ side by the app.
 */
export async function seedSavedSearch(userId: string, name: string): Promise<string> {
  return withServiceDb(async (c) => {
    await c.query('INSERT INTO user_profile (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO saved_search (user_id, query_json)
       VALUES ($1, $2::jsonb)
       RETURNING id`,
      [userId, JSON.stringify({ name, params: { q: name } })],
    );
    return rows[0].id;
  });
}

/** Remove a single seeded saved_search row by id (fixture teardown, concurrency-safe). */
export async function clearSavedSearchById(id: string): Promise<void> {
  await withServiceDb(async (c) => {
    await c.query('DELETE FROM saved_search WHERE id = $1', [id]);
  });
}

/**
 * Verify the auditable marker (named safety requirement #2) is actually persisted
 * on the auth user's row — the same query an auditor/admin would run.
 */
export async function readAuthUserAuditMarker(
  userId: string,
): Promise<{ email: string | null; is_e2e_test_user: unknown; created_by: unknown } | null> {
  return withServiceDb(async (c) => {
    const { rows } = await c.query<{ email: string | null; app_meta: Record<string, unknown> }>(
      `SELECT email, raw_app_meta_data AS app_meta FROM auth.users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const meta = rows[0].app_meta ?? {};
    return {
      email: rows[0].email,
      is_e2e_test_user: meta.is_e2e_test_user,
      created_by: meta.created_by,
    };
  });
}

/**
 * Make the E2E test user an active admin in the LOCAL e2e database, so the admin a11y sweep can
 * reach /admin/* through the real session gate (app/admin/_lib/gate.ts) instead of the retired
 * `?token=` secret. Idempotent (the light and dark projects may both call it).
 *
 * LOCAL ONLY: refuses unless DATABASE_URL is a local/disposable test database (the same guard the
 * db test lane uses). This never runs against staging or production.
 */
export async function seedTestUserAsAdmin(userId: string): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
  await withServiceDb(async (c) => {
    await c.query('INSERT INTO user_profile (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
    await c.query(
      `INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)
       ON CONFLICT (user_id) DO UPDATE SET role = 'admin', active = true`,
      [userId],
    );
  });
}
