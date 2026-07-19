import { describe, it, expect, afterAll } from 'vitest';
import { Client } from 'pg';
import { getPool, closePool } from '../lib/db/client';

// 0018_public_tables_default_deny_rls.sql — security regression test (Round 20 /
// Task HH, F-1). The 18 public-schema catalog/taxonomy/ops tables below must be
// default-deny to the Supabase API roles (`anon`, `authenticated`): no anon-key
// REST/GraphQL read or write of search data, analytics_event, correction_report,
// job_queue, etc. Mirrors tests/rls_admin.test.ts's layered approach so a
// regression in EITHER barrier — the RLS default-deny OR the GRANT revoke — is
// caught, and adds an effective-privilege matrix over all four DML verbs.
const hasDb = Boolean(process.env.DATABASE_URL);

// The exact 18 tables locked down by 0018 (must match the migration).
const LOCKED_TABLES = [
  'source',
  'activity_series',
  'activity_occurrence',
  'venue',
  'region',
  'organisation',
  'category',
  'tag',
  'age_band',
  'occurrence_age',
  'occurrence_category_tag',
  'synonym_alias',
  'provenance',
  'source_check_run',
  'correction_report',
  'analytics_event',
  'job_queue',
  'app_meta',
] as const;

function authenticatedConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'authenticated';
  url.password = 'local_dev_only_not_a_secret';
  return url.toString();
}

describe.skipIf(!hasDb)('public catalog/ops tables default-deny RLS (0018 security regression)', () => {
  afterAll(async () => {
    await closePool();
  });

  // ── Layer 1: reproduce QA's exact live-verified exploit, now closed. The login
  //    `authenticated` role (the role PostgREST switches into for an anon-key
  //    request bearing a user JWT) must not be able to SELECT ANY of these tables.
  //    Each failed statement is its own implicit transaction, so the loop is safe
  //    on a plain (non-transaction) connection. ─────────────────────────────────
  it('the authenticated role cannot SELECT from any of the 18 tables', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      for (const t of LOCKED_TABLES) {
        await expect(client.query(`SELECT * FROM ${t} LIMIT 1`), `authenticated SELECT ${t}`).rejects.toThrow();
      }
    } finally {
      await client.end();
    }
  });

  // ── Layer 1 (anon): `anon` is NOLOGIN, so exercise it by role-switching inside a
  //    transaction (the same technique tests/rls_admin.test.ts uses for its
  //    grant-holding non-admin role). One rolled-back transaction per table keeps
  //    each check isolated and leaves no residue. ───────────────────────────────
  it('the anon role cannot SELECT from any of the 18 tables', async () => {
    const client = await getPool().connect();
    try {
      for (const t of LOCKED_TABLES) {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE anon');
        await expect(client.query(`SELECT * FROM ${t} LIMIT 1`), `anon SELECT ${t}`).rejects.toThrow();
        await client.query('ROLLBACK'); // failed stmt aborted the txn; ROLLBACK clears it + reverts SET LOCAL ROLE
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // ── Control: the denials above are 0018-specific, NOT a blank harness. The
  //    local-dev auth stub grants the API roles Supabase's DEFAULT table access
  //    via ALTER DEFAULT PRIVILEGES, so a throwaway table the owner creates is
  //    readable by `authenticated` — proving the API roles DO get access by
  //    default and the denials on the 18 tables come from 0018's REVOKE/RLS, not
  //    from a role that can see nothing. Runs inside a rolled-back transaction. ──
  it('control: authenticated CAN read a fresh owner table granted by default', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE IF EXISTS kf_rls0018_control');
      await client.query('CREATE TABLE kf_rls0018_control (id int)');
      await client.query('INSERT INTO kf_rls0018_control (id) VALUES (1)');
      await client.query('SET LOCAL ROLE authenticated');
      const res = await client.query<{ c: number }>('SELECT count(*)::int AS c FROM kf_rls0018_control');
      expect(res.rows[0].c).toBe(1); // default GRANT is visible => harness grants API roles
      await client.query('RESET ROLE');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // ── Layer 2: effective-privilege matrix. Directly assert `anon` and
  //    `authenticated` hold NONE of SELECT/INSERT/UPDATE/DELETE on any of the 18
  //    tables — column-agnostic and unambiguous (does not depend on seed rows or
  //    table shape). This is the full four-verb, two-role denial the task calls
  //    for; it also catches a partial revoke the SELECT-only behavioral checks
  //    would miss (e.g. INSERT/UPDATE/DELETE left granted). ─────────────────────
  it('anon and authenticated have no SELECT/INSERT/UPDATE/DELETE on any of the 18 tables', async () => {
    const { rows } = await getPool().query<{
      relname: string;
      anon_select: boolean;
      anon_insert: boolean;
      anon_update: boolean;
      anon_delete: boolean;
      auth_select: boolean;
      auth_insert: boolean;
      auth_update: boolean;
      auth_delete: boolean;
    }>(
      `SELECT c.relname,
              has_table_privilege('anon',          c.oid, 'SELECT') AS anon_select,
              has_table_privilege('anon',          c.oid, 'INSERT') AS anon_insert,
              has_table_privilege('anon',          c.oid, 'UPDATE') AS anon_update,
              has_table_privilege('anon',          c.oid, 'DELETE') AS anon_delete,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
              has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert,
              has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_update,
              has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_delete
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [LOCKED_TABLES as unknown as string[]]
    );

    // Every one of the 18 tables must be present (guards against a typo in the
    // migration/table list silently skipping a table).
    expect(rows.map((r) => r.relname).sort()).toEqual([...LOCKED_TABLES].sort());

    for (const r of rows) {
      expect(r.anon_select, `anon SELECT ${r.relname}`).toBe(false);
      expect(r.anon_insert, `anon INSERT ${r.relname}`).toBe(false);
      expect(r.anon_update, `anon UPDATE ${r.relname}`).toBe(false);
      expect(r.anon_delete, `anon DELETE ${r.relname}`).toBe(false);
      expect(r.auth_select, `authenticated SELECT ${r.relname}`).toBe(false);
      expect(r.auth_insert, `authenticated INSERT ${r.relname}`).toBe(false);
      expect(r.auth_update, `authenticated UPDATE ${r.relname}`).toBe(false);
      expect(r.auth_delete, `authenticated DELETE ${r.relname}`).toBe(false);
    }
  });

  // ── Layer 3: structural invariant. RLS enabled + ZERO permissive policies on
  //    all 18 => true default-deny for every RLS-subject role. This is what the
  //    behavioral/grant checks alone do NOT prove: they'd still pass on the REVOKE
  //    if RLS were accidentally left disabled. Assert the invariant directly. ────
  it('all 18 tables have RLS enabled and zero permissive policies', async () => {
    const rls = await getPool().query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [LOCKED_TABLES as unknown as string[]]
    );
    expect(rls.rows.length).toBe(LOCKED_TABLES.length);
    for (const row of rls.rows) expect(row.relrowsecurity, `RLS enabled on ${row.relname}`).toBe(true);

    const pol = await getPool().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [LOCKED_TABLES as unknown as string[]]
    );
    expect(pol.rows[0].c).toBe(0); // no permissive policy => deny for every RLS-subject role
  });
});
