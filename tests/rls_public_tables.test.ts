import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { getPool, closePool } from '../lib/db/client';

// Security regression test for the "unlocked public table" class — Round 20 / Task HH
// (F-1, migration 0018) and Round 25 / Task VV (migration 0019, llm_batch_run /
// llm_batch_decision).
//
// WHY THIS FILE WAS REWRITTEN (0019 regression): the previous version asserted against a
// HARDCODED list of the 18 F-1 tables (`LOCKED_TABLES`). That list could not, by
// construction, catch a NEW table added by a later migration — 0019 shipped two tables
// with RLS DISABLED + Supabase default grants and this suite stayed green because those
// tables simply were not on the list. The fix is to stop hardcoding the set under test:
// enumerate EVERY public-schema table live from the catalog and assert the invariant on
// all of them, so any future migration that forgets to lock a table fails CI here.
//
// THE INVARIANT (two barriers, matching 0014/0017/0018):
//   • Every governed public table has RLS ENABLED (default-deny for RLS-subject roles); and
//   • Every service-role-only table (RLS on with NO policies) additionally has ZERO
//     anon/authenticated grants (the REVOKE barrier).
// Tables that are RLS-enabled WITH row policies are the deliberate USER-SCOPED pattern
// (user_profile / saved_search, 0013): their anon/authenticated grants are mediated by the
// policies and are exercised by tests/rls_user.test.ts — asserting "zero grants" on them
// would be wrong, so they are partitioned out by policy presence, not hardcoded.
const hasDb = Boolean(process.env.DATABASE_URL);

// The ONLY allowlist in this file. Small, and every entry carries a reviewed reason. These
// are public tables that are legitimately NOT under the app's default-deny RLS posture.
// Everything else is enumerated live — so a new table can never "pass" merely by being
// absent from a list.
const RLS_DISABLED_EXEMPT: Record<string, string> = {
  // PostGIS SRID → projection reference data. Owned by the postgis extension, meant to be
  // world-readable, holds no app/user data. Supabase's own database linter special-cases
  // this exact table for the same reason.
  spatial_ref_sys:
    'PostGIS SRID reference data — public-read by design, no app/user data (matches the Supabase lint exception).',
  // The forward-only migration LEDGER created by scripts/migrate.sh — runner infrastructure,
  // NOT a migration-defined app table (it lives outside supabase/migrations/). Its columns
  // (version, checksum, applied_at) are all derivable from the committed repo. Locking it
  // (in the runner, or moving it to a dedicated schema as real Supabase does) is tracked as
  // a separate low-severity infra follow-up; it is out of scope for the app data schema this
  // suite governs.
  schema_migrations:
    'migrate.sh migration ledger (runner infra, outside supabase/migrations/) — tracked as a separate infra follow-up.',
};

// The ONLY tables that legitimately carry row-level policies (RLS on + grants, mediated by
// the policy). Adding a permissive policy to any OTHER table would silently reopen it to the
// API roles, so we pin this set: an unexpected policied table fails below. Kept tiny and
// reviewed for exactly that reason (see 0013_rls_user.sql).
const EXPECTED_USER_SCOPED = ['saved_search', 'user_profile'] as const;

type TableRow = { relname: string; rls: boolean; n_policies: number };

function authenticatedConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'authenticated';
  url.password = 'local_dev_only_not_a_secret';
  return url.toString();
}

describe.skipIf(!hasDb)('public tables default-deny RLS — dynamic, all-tables (F-1 / 0018 / 0019 regression)', () => {
  // Live inventory of EVERY ordinary/partitioned table in the public schema, with its RLS
  // flag and policy count — fetched once from the catalog at test time. No table list is
  // hardcoded, so a migration that adds a table without locking it down is caught here.
  let allTables: TableRow[] = [];
  let governed: TableRow[] = []; // non-exempt
  let lockedTables: string[] = []; // RLS on + 0 policies  => service-role-only default-deny
  let policiedTables: string[] = []; // RLS on + >=1 policy => user-scoped (grants mediated by policy)

  beforeAll(async () => {
    const { rows } = await getPool().query<TableRow>(
      `SELECT c.relname,
              c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS n_policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`
    );
    allTables = rows;
    governed = rows.filter((r) => !(r.relname in RLS_DISABLED_EXEMPT));
    lockedTables = governed.filter((r) => r.rls && r.n_policies === 0).map((r) => r.relname);
    policiedTables = governed.filter((r) => r.rls && r.n_policies > 0).map((r) => r.relname);
  });

  afterAll(async () => {
    await closePool();
  });

  // ── Guard against the classic dynamic-test failure mode: an enumeration that silently
  //    returns nothing (wrong DB, empty schema, typo) would make every check below pass
  //    vacuously. Assert the inventory is real, includes known sentinels, and that no
  //    exemption is stale. ────────────────────────────────────────────────────────────
  it('enumerates a real, populated public-schema inventory (no vacuous pass)', () => {
    expect(allTables.length).toBeGreaterThanOrEqual(20);
    const names = allTables.map((t) => t.relname);
    for (const sentinel of ['source', 'analytics_event', 'user_profile', 'llm_batch_run', 'llm_batch_decision']) {
      expect(names, `sentinel table ${sentinel} present in inventory`).toContain(sentinel);
    }
    // Every exemption must correspond to a table that actually exists — no stale allowlist.
    for (const t of Object.keys(RLS_DISABLED_EXEMPT)) {
      expect(names, `exempt table ${t} still exists (otherwise remove the stale exemption)`).toContain(t);
    }
  });

  // ── THE bug-class guard (this is what migration 0019 originally violated). Every
  //    governed (non-exempt) public table MUST have RLS enabled. Because the list is
  //    enumerated live, ANY future unlocked table fails here too — there is no hardcoded
  //    allowlist to silently fall out of. ───────────────────────────────────────────────
  it('every non-exempt public table has RLS enabled', () => {
    const offenders = governed.filter((t) => !t.rls).map((t) => t.relname);
    expect(offenders, `RLS disabled on public table(s): ${offenders.join(', ') || '(none)'}`).toEqual([]);
  });

  // ── REVOKE barrier (defense in depth, dynamic). Service-role-only tables — RLS on with
  //    ZERO policies — must additionally hold NO anon/authenticated grant on any DML verb.
  //    Catches a partial revoke, AND a new table that got RLS but not the REVOKE. Runs the
  //    same four-verb, two-role effective-privilege matrix the prior suite had, but over
  //    the live-derived locked set instead of a hardcoded list. ─────────────────────────
  it('every service-role-only table (RLS + 0 policies) has no anon/authenticated DML grant', async () => {
    expect(lockedTables.length, 'sane number of locked tables (F-1 eighteen + admin + email + llm…)').toBeGreaterThanOrEqual(18);
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
      [lockedTables]
    );

    // Every locked table must be present (guards against a typo silently skipping one).
    expect(rows.map((r) => r.relname).sort()).toEqual([...lockedTables].sort());

    for (const r of rows) {
      for (const [verb, granted] of Object.entries(r)) {
        if (verb === 'relname') continue;
        expect(granted, `${verb} on ${r.relname}`).toBe(false);
      }
    }
  });

  // ── Behavioral (Layer 1, dynamic) — reproduce QA's live-verified exploit, now closed,
  //    across the WHOLE locked set: the login `authenticated` role (the role PostgREST
  //    switches into for an anon-key request bearing a user JWT) cannot SELECT any of them.
  //    Each failed statement is its own implicit transaction, so the loop is safe on a
  //    plain (non-transaction) connection. ──────────────────────────────────────────────
  it('the authenticated role cannot SELECT from any service-role-only table', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      for (const t of lockedTables) {
        await expect(client.query(`SELECT * FROM ${t} LIMIT 1`), `authenticated SELECT ${t}`).rejects.toThrow();
      }
    } finally {
      await client.end();
    }
  });

  // ── Behavioral (anon). `anon` is NOLOGIN, so exercise it by role-switching inside a
  //    transaction. One rolled-back transaction per table keeps each check isolated. ─────
  it('the anon role cannot SELECT from any service-role-only table', async () => {
    const client = await getPool().connect();
    try {
      for (const t of lockedTables) {
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

  // ── Control: the denials above are real, NOT a blank harness. The local/CI auth stub
  //    grants the API roles Supabase's DEFAULT table access via ALTER DEFAULT PRIVILEGES,
  //    so a throwaway owner-created table IS readable by `authenticated` — proving the API
  //    roles get access by default and the denials come from the migrations' RLS/REVOKE,
  //    not from a role that can see nothing. Runs inside a rolled-back transaction. ───────
  it('control: authenticated CAN read a fresh owner table granted by default', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE IF EXISTS kf_rls_dyn_control');
      await client.query('CREATE TABLE kf_rls_dyn_control (id int)');
      await client.query('INSERT INTO kf_rls_dyn_control (id) VALUES (1)');
      await client.query('SET LOCAL ROLE authenticated');
      const res = await client.query<{ c: number }>('SELECT count(*)::int AS c FROM kf_rls_dyn_control');
      expect(res.rows[0].c).toBe(1); // default GRANT is visible => harness grants API roles
      await client.query('RESET ROLE');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // ── Pin the user-scoped set. The only tables that may carry row policies are the
  //    deliberate user-scoped ones (0013). If a future change adds a permissive policy to a
  //    should-be-locked table, that table moves into this partition and is no longer grant-
  //    checked above — catch that here by asserting the policied set is EXACTLY the expected
  //    user-scoped tables. (A new legitimately user-scoped table is a security-relevant
  //    decision and must be added here on purpose.) ─────────────────────────────────────
  it('only the expected user-scoped tables carry row policies', () => {
    expect([...policiedTables].sort()).toEqual([...EXPECTED_USER_SCOPED].sort());
  });

  // ── Direct verification of the 0019 fix subject: both new LLM-batch tables are in the
  //    service-role-only locked partition (RLS on, no policies, no grants — the earlier
  //    matrix already proved zero grants for every locked table). ──────────────────────
  it('the 0019 llm_batch_run / llm_batch_decision tables are locked service-role-only', () => {
    const locked = new Set(lockedTables);
    for (const t of ['llm_batch_run', 'llm_batch_decision']) {
      expect(locked.has(t), `${t} in the service-role-only locked set`).toBe(true);
    }
  });
});
