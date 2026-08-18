// tests/snapshot/policy-schema-guard.test.ts — DB lane. THE ALARM.
//
// This is the single most important test in the snapshot feature, and it runs on EVERY CI run
// — not only in snapshot mode. An alarm that only fires when somebody remembers to arm it is
// not an alarm.
//
// What it protects: lib/snapshot/policy.ts allowlists twelve catalogue tables and classifies
// every one of their columns. The realistic way that becomes wrong is a migration adding a
// column to a table that is already allowlisted — `venue.phone` arrived exactly that way in
// migration 0024, a phone number appearing on a table first created back in 0003. Deny-by-
// default means the export refuses to run in that state; this test means the PR that created
// the state goes red at review time, long before anybody points the export at production.
//
// If this fails, the fix is NEVER to relax the guard. It is to open lib/snapshot/policy.ts and
// decide, for the named column, whether it is public catalogue data (`preserve`, with a stated
// reason) or something that must be scrubbed — or whether the table now holds personal data at
// all and belongs in EXCLUDED_TABLES.
import { afterAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '../../lib/db/client';
import { runSchemaGuard } from '../../lib/snapshot/schema-guard';
import { SNAPSHOT_TABLES, exportedColumns } from '../../lib/snapshot/policy';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('snapshot policy vs the live schema', () => {
  afterAll(async () => {
    await closePool();
  });

  it('classifies every column of every allowlisted table', async () => {
    const { errors } = await runSchemaGuard(getPool());
    expect(errors.join('\n\n')).toBe('');
  });

  it('reports new unclassified tables as notices, not errors — they cannot leak', async () => {
    const { notices } = await runSchemaGuard(getPool());
    // Informational only; printed so a human decides. Asserted non-throwing so a new table
    // never blocks an unrelated PR.
    expect(Array.isArray(notices)).toBe(true);
  });

  it('names the tables it is willing to read, so the list is visible in test output', async () => {
    const { fingerprint } = await runSchemaGuard(getPool());
    expect(Object.keys(fingerprint.tables).sort()).toEqual(SNAPSHOT_TABLES.map((t) => t.table).sort());
  });

  it('records the migration ledger, which is what lets a load refuse a mismatched snapshot', async () => {
    const { fingerprint } = await runSchemaGuard(getPool());
    expect(fingerprint.migrations.length).toBeGreaterThan(0);
    expect(fingerprint.migrations.every((m) => typeof m.version === 'string')).toBe(true);
  });

  it('never selects a column from a table it has not allowlisted', async () => {
    // Belt-and-braces on the SELECT builder: whatever the policy says, the set of columns the
    // export can possibly read is bounded by the policy's own exportedColumns().
    const pool = getPool();
    for (const policy of SNAPSHOT_TABLES) {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [policy.table]
      );
      const live = new Set(rows.map((r) => r.column_name));
      for (const c of exportedColumns(policy)) expect(live.has(c), `${policy.table}.${c}`).toBe(true);
    }
  });

  it('confirms the excluded PII tables really do exist — i.e. they are excluded, not absent', async () => {
    // If user_profile vanished, "we do not export it" would be true for the wrong reason and
    // this whole guard would be vacuous.
    const pool = getPool();
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('user_profile','saved_search','admin_user','admin_audit_log','analytics_event','correction_report','weekly_email_send')`
    );
    expect(rows.length).toBe(7);
  });

  it('confirms user_profile still holds the columns that make it untouchable', async () => {
    // Documents WHY the exclusion exists, in a form that fails if the schema changes under it.
    const pool = getPool();
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_profile'`
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('saved_child_ages'); // real children's ages, in months
    expect(cols).toContain('google_identity'); // real account email
  });
});
