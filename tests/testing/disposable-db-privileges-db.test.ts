// tests/testing/disposable-db-privileges-db.test.ts — the disposability guard against a REAL
// low-privilege role, not a stubbed pool.
//
// tests/testing/disposable-db.test.ts stubs pg.Pool entirely. That is the right shape for testing
// the DECISION, but it meant the guard's first version shipped a defect no unit test could see:
// `CREATE SCHEMA IF NOT EXISTS` checks CREATE-on-database even when the schema already exists, so
// under CI's deliberately low-privilege `authenticated` role it raised "permission denied for
// database" and took the ENTIRE db lane down. A reviewer found it by running a real role.
//
// So this file exercises the two directions that only a real privilege boundary can show:
//   1. loopback + a role that CANNOT provision the marker  -> allowed (the address already decided
//      it; the marker is a convenience there), with a warning rather than a crash
//   2. a non-local host + a role that cannot READ the marker -> REFUSED, even when the marker
//      physically exists. "Cannot verify" must never read as "verified".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getPool, query } from '@/lib/db/client';
import { assertDisposableDatabase, DISPOSABLE_MARKER_SCHEMA, markerExists } from '@/lib/testing/disposable-db';

const hasDb = Boolean(process.env.DATABASE_URL);
const ROLE = 'kf_disposable_lowpriv_probe';
const PASSWORD = 'lowpriv_probe_local_only';

/** The low-privilege URL, built from DATABASE_URL so it targets the same database. */
function lowPrivUrl(): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.username = ROLE;
  u.password = PASSWORD;
  return u.toString();
}

describe.skipIf(!hasDb)('disposable-db guard under a real low-privilege role', () => {
  let dbName = '';

  beforeAll(async () => {
    dbName = (await query<{ d: string }>('SELECT current_database() d'))[0].d;
    await query(`DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
         CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
       END IF;
     END $$;`);
    // CI's shape: can connect and read, cannot create schemas.
    await query(`REVOKE CREATE ON DATABASE "${dbName}" FROM ${ROLE}`);
    await query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${ROLE}`);
    await query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    const [{ c }] = await query<{ c: boolean }>(
      `SELECT has_database_privilege($1, $2, 'CREATE') c`, [ROLE, dbName]
    );
    expect(c, 'the probe role must genuinely lack CREATE, or this file proves nothing').toBe(false);
  });

  afterAll(async () => {
    // Drop only what this file created, by name. Never a blanket sweep.
    await query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`).catch(() => {});
    await query(`REVOKE ALL ON DATABASE "${dbName}" FROM ${ROLE}`).catch(() => {});
    await query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await getPool().end().catch(() => {});
  });

  it('LOOPBACK: a role that cannot provision the marker is still allowed through', async () => {
    const pool = new Pool({ connectionString: lowPrivUrl(), max: 1 });
    try {
      // The real CI failure was an unhandled "permission denied for database" here.
      await expect(assertDisposableDatabase(pool, lowPrivUrl())).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('NON-LOCAL: an unverifiable marker is refused, even when the marker exists', async () => {
    // Provision the marker as the privileged role, then take the schema away from the probe role.
    await query(`CREATE SCHEMA IF NOT EXISTS ${DISPOSABLE_MARKER_SCHEMA}`);
    await query(
      `CREATE TABLE IF NOT EXISTS ${DISPOSABLE_MARKER_SCHEMA}.kf_disposable_test_db (
         marked_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL)`
    );
    await query(`REVOKE ALL ON SCHEMA ${DISPOSABLE_MARKER_SCHEMA} FROM ${ROLE}, PUBLIC`);

    const pool = new Pool({ connectionString: lowPrivUrl(), max: 1 });
    try {
      await expect(markerExists(pool), 'cannot-verify must fail closed').resolves.toBe(false);
      await expect(
        assertDisposableDatabase(pool, 'postgres://u:p@10.0.0.5:5432/db')
      ).rejects.toThrow(/carries no disposability marker/);
    } finally {
      await pool.end();
    }
  });
});
