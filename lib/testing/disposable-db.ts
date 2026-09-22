// lib/testing/disposable-db.ts — the THIRD layer of the 2026-09-21 fix: a POSITIVE proof that the
// attached database is disposable, rather than an absence of evidence that it isn't.
//
// ═══ WHAT THIS ADDS THAT local-db-guard.ts DOES NOT ═══
// local-db-guard answers "is this host local?" — a claim about the ADDRESS. It is the right first
// gate and it now refuses managed hosts absolutely. But it leaves one door: the exact-host override
// (KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST) exists so a genuinely disposable REMOTE Postgres — a
// throwaway container on a build box, a private-IP CI service — can still be used. Past that door,
// the DB-backed suites run `DELETE FROM job_queue` and flipStaleOccurrences, which are TABLE-WIDE.
// An address is a weak thing to stake that on: addresses get reused, DNS gets repointed, a
// port-forward gets left open.
//
// So for any host that is not loopback, this module demands a marker that lives INSIDE the target
// database and must have been put there deliberately. The database itself has to say "I am
// disposable". That is a claim only someone with write access to that specific database can make,
// it travels with the data rather than with the connection string, and it cannot be satisfied by
// an environment variable set in the wrong shell — which is the exact failure mode that caused the
// incident.
//
// ═══ WHY LOOPBACK AUTO-PROVISIONS INSTEAD OF DEMANDING THE MARKER ═══
// Requiring it everywhere would have broken every existing local database on day one (the docker
// scratch instances, the `supabase start` e2e harness, a fresh CI service container) and the
// predictable result of a gate that fires on correct usage is that someone disables the gate. On a
// loopback host the marker is created automatically and silently, so the common path is unchanged
// and the friction lands only where the risk actually is.
import type { Pool } from 'pg';
import { isLocalDatabaseHost, isManagedDatabaseHost, resolveConnectionHost } from '@/lib/db/connection-host';

/** Schema the marker lives in — deliberately NOT `public`. See DISPOSABLE_MARKER_TABLE. */
export const DISPOSABLE_MARKER_SCHEMA = 'kf_testing';

/**
 * Table whose mere existence asserts "this database is disposable; tests may mutate it freely."
 *
 * ═══ WHY IT IS NOT IN `public` ═══
 * The first cut created it in `public`, which turned the db lane red on every run including CI:
 * tests/rls_public_tables.test.ts enumerates public tables LIVE and requires each non-exempt one to
 * be default-deny. Enabling RLS alone did not satisfy it either — Supabase's default privileges
 * still leave anon/authenticated holding a SELECT grant, and the suite (correctly) wants the read
 * to be REJECTED, not merely empty.
 *
 * Chasing that with RLS + REVOKEs would mean role-existence guards for bare (non-Supabase) local
 * Postgres, to make a test marker look like an app table. It is not one. A dedicated schema says
 * exactly what this is, keeps it outside the invariant that governs production's data schema, and
 * needs no grants, no policies and no allowlist entry. Adding it to RLS_DISABLED_EXEMPT would have
 * been worse still: that list documents PRODUCTION tables, and this must never exist in production.
 */
export const DISPOSABLE_MARKER_TABLE = `${DISPOSABLE_MARKER_SCHEMA}.kf_disposable_test_db`;

/** SQL that creates the marker. Also used by scripts/local-db-bootstrap.sh, via this constant's
 *  twin in that script — kept trivial precisely so the two cannot drift in any meaningful way. */
export const CREATE_MARKER_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ${DISPOSABLE_MARKER_SCHEMA}`;

export const CREATE_MARKER_SQL = `
  CREATE TABLE IF NOT EXISTS ${DISPOSABLE_MARKER_TABLE} (
    marked_at timestamptz NOT NULL DEFAULT now(),
    note      text        NOT NULL
  )`;


export async function markerExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [DISPOSABLE_MARKER_TABLE]
  );
  return rows[0]?.ok === true;
}

/**
 * Refuse to proceed unless the database behind `pool` is provably safe to mutate.
 *
 *  • managed/hosted host → throw (belt-and-braces; local-db-guard should already have refused)
 *  • loopback host       → auto-provision the marker, then allow
 *  • other remote host   → allow ONLY if the marker already exists in that database
 *
 * `connectionString` is passed explicitly rather than read from the pool, because a pool built
 * from a hardcoded URL would otherwise be checked against the wrong target — the one case where
 * reading the environment instead of the actual connection would reintroduce the whole bug class.
 */
export async function assertDisposableDatabase(pool: Pool, connectionString: string): Promise<void> {
  const host = resolveConnectionHost(connectionString);

  if (host === null) {
    throw new Error(
      `[disposable-db] the connection string is not parseable, so the target cannot be verified. Refusing.`
    );
  }
  if (isManagedDatabaseHost(host)) {
    throw new Error(
      `[disposable-db] REFUSING: "${host}" is a managed/hosted database endpoint. DB suites run ` +
        `table-wide writes and must never touch one. (If you are seeing this, local-db-guard was ` +
        `bypassed — that is itself a bug worth reporting.)`
    );
  }
  if (isLocalDatabaseHost(host)) {
    await pool.query(CREATE_MARKER_SCHEMA_SQL);
    await pool.query(CREATE_MARKER_SQL);
    await pool.query(
      `INSERT INTO ${DISPOSABLE_MARKER_TABLE} (note)
       SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM ${DISPOSABLE_MARKER_TABLE})`,
      ['auto-marked by lib/testing/disposable-db.ts: loopback host, treated as disposable']
    );
    return;
  }

  // Non-local but permitted by the exact-host override. The database must vouch for itself.
  if (await markerExists(pool)) return;

  throw new Error(
    `[disposable-db] REFUSING: "${host}" is not a loopback host and carries no disposability ` +
      `marker. The DB-backed suites run TABLE-WIDE writes (DELETE FROM job_queue, ` +
      `flipStaleOccurrences), so a host allowlist alone is not enough to stake real data on. If ` +
      `this database really is disposable, say so from inside it:\n\n` +
      `    psql "$DATABASE_URL" -c "CREATE TABLE ${DISPOSABLE_MARKER_TABLE} (marked_at timestamptz ` +
      `NOT NULL DEFAULT now(), note text NOT NULL)" \\\n` +
      `      -c "INSERT INTO ${DISPOSABLE_MARKER_TABLE} (note) VALUES ('disposable: <who/why>')"\n\n` +
      `Creating that table in a database you care about is the mistake this guard is asking you ` +
      `not to make.`
  );
}

/**
 * Convenience wrapper for the setup file: classify + (when needed) probe a URL using a pool of its
 * own, so USER_DATABASE_URL is checked against the database IT points at rather than whichever pool
 * happened to be open. Closes the pool it creates.
 *
 * USER_DATABASE_URL matters here and was originally missed: the db lane's RLS and user-scoped
 * suites write through that role, so a guard that only covered DATABASE_URL left a second door on
 * the same lane.
 */
export async function assertDisposableDatabaseUrl(connectionString: string, label = 'DATABASE_URL'): Promise<void> {
  const host = resolveConnectionHost(connectionString);
  // Cheap classification first — a managed or unparseable target never earns a connection.
  if (host === null) {
    throw new Error(`[disposable-db] ${label} is not a parseable connection URL — refusing.`);
  }
  if (isManagedDatabaseHost(host)) {
    throw new Error(
      `[disposable-db] REFUSING: ${label} points at the managed/hosted host "${host}". DB suites ` +
        `run table-wide writes and must never touch one.`
    );
  }
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await assertDisposableDatabase(pool, connectionString);
  } finally {
    await pool.end();
  }
}
