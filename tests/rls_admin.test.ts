import { describe, it, expect, afterAll } from 'vitest';
import { Client } from 'pg';
import { getPool, closePool } from '../lib/db/client';

// 0014_admin_rls.sql — security regression test: admin_user / admin_audit_log
// must be default-deny (no anon-key REST enumeration of the admin roster). See
// migration header for the finding this fixes. Covers TWO independent layers of
// the fix: the explicit GRANT revoke AND the RLS default-deny itself — so a
// regression in either is caught.
const hasDb = Boolean(process.env.DATABASE_URL);

function authenticatedConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'authenticated';
  url.password = 'local_dev_only_not_a_secret';
  return url.toString();
}

describe.skipIf(!hasDb)('admin_user / admin_audit_log RLS (security regression)', () => {
  afterAll(async () => {
    await closePool();
  });

  // ── Layer 1: the GRANT revoke denies the login `authenticated` role outright ──
  it('the authenticated role cannot SELECT from admin_user', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM admin_user')).rejects.toThrow();
    } finally {
      await client.end();
    }
  });

  it('the authenticated role cannot SELECT from admin_audit_log', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM admin_audit_log')).rejects.toThrow();
    } finally {
      await client.end();
    }
  });

  // ── Control: the two denials above are 0014-specific, NOT a blank harness ─────
  // Without this control the Layer-1 tests are ambiguous: the local-dev stub used
  // to grant the API roles NO table access, so `authenticated` got a generic
  // "permission denied" on EVERY public table — the same error with or without
  // 0014. The stub now models Supabase's default table grants, so `authenticated`
  // CAN read an ordinary RLS-free public table (region). That it can read region
  // but not admin_user/admin_audit_log proves those denials come from 0014's
  // ENABLE RLS + REVOKE, not from a role that simply can't see anything.
  it('control: authenticated CAN read a normal RLS-free public table (region)', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      const res = await client.query<{ c: number }>('SELECT count(*)::int AS c FROM region');
      expect(res.rows[0].c).toBeGreaterThan(0); // reads seeded rows, no permission error
    } finally {
      await client.end();
    }
  });

  // ── Layer 2: RLS itself is enabled and default-deny (structural invariant) ────
  // This is what the two tests above do NOT prove: they pass on the GRANT revoke
  // alone and would still be green if RLS were accidentally disabled. Assert the
  // real invariant directly.
  it('has RLS enabled and zero permissive policies on both admin tables', async () => {
    const rls = await getPool().query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('admin_user','admin_audit_log') ORDER BY relname`
    );
    expect(rls.rows.length).toBe(2);
    for (const row of rls.rows) expect(row.relrowsecurity).toBe(true);

    const pol = await getPool().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_policies
        WHERE schemaname='public' AND tablename IN ('admin_user','admin_audit_log')`
    );
    expect(pol.rows[0].c).toBe(0); // no permissive policy => deny for every RLS-subject role
  });

  // Reproduces the reviewer's exact bypass: a NON-owner role that DOES hold the
  // Supabase-default table SELECT grant. Default-deny RLS must still hide every
  // row (0 rows, not an error), while the privileged server path keeps working.
  // Everything runs inside a transaction that is rolled back — the throwaway role
  // and seed rows leave no residue.
  it('a non-admin role holding table grants sees zero rows via RLS', async () => {
    const uid = '4d0e0000-0000-4000-8000-000000000abc';
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP ROLE IF EXISTS kf_rls_test_nonadmin');
      await client.query('CREATE ROLE kf_rls_test_nonadmin NOLOGIN');
      await client.query('GRANT SELECT ON admin_user, admin_audit_log TO kf_rls_test_nonadmin');

      await client.query('INSERT INTO user_profile (id) VALUES ($1)', [uid]);
      await client.query("INSERT INTO admin_user (user_id, role, active) VALUES ($1,'admin',true)", [uid]);
      await client.query(
        "INSERT INTO admin_audit_log (admin_user_id, action, target_table) VALUES ($1,'test','admin_user')",
        [uid]
      );

      // Privileged path bypasses RLS and sees the rows (lib/db/admin-guard keeps working).
      const priv = await client.query<{ c: number }>('SELECT count(*)::int AS c FROM admin_user');
      expect(priv.rows[0].c).toBeGreaterThanOrEqual(1);

      // Impersonate the grant-holding non-admin role — default-deny RLS hides all rows.
      await client.query('SET LOCAL ROLE kf_rls_test_nonadmin');
      const naUsers = await client.query<{ c: number }>('SELECT count(*)::int AS c FROM admin_user');
      const naAudit = await client.query<{ c: number }>('SELECT count(*)::int AS c FROM admin_audit_log');
      expect(naUsers.rows[0].c).toBe(0);
      expect(naAudit.rows[0].c).toBe(0);
      await client.query('RESET ROLE');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
