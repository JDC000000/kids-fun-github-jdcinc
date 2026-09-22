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
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { getPool, query } from '@/lib/db/client';
import { assertDisposableDatabase, DISPOSABLE_MARKER_SCHEMA, markerExists } from '@/lib/testing/disposable-db';

const hasDb = Boolean(process.env.DATABASE_URL);
const ROLE = 'kf_disposable_lowpriv_probe';
/** Generated per run rather than hardcoded — a fixed password in a test file is a credential that
 *  outlives the test, and this role is created on whatever local database the lane is pointed at. */
const PASSWORD = `probe_${randomBytes(12).toString('hex')}`;

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
    // Restore what this file revoked. The second test REVOKEs on the marker schema to force the
    // unreadable state; leaving that in place would silently change the marker's behaviour for
    // every later run against the same database — a test that mutates shared state and does not
    // put it back is a flaky neighbour, which is exactly the class of problem this suite exists
    // to prevent.
    await query(`GRANT USAGE ON SCHEMA ${DISPOSABLE_MARKER_SCHEMA} TO PUBLIC`).catch(() => {});

    // Drop only what this file created, by name. Never a blanket sweep — and never silently: a
    // failure here leaves a login role behind, which is worth seeing rather than swallowing.
    await query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`).catch(() => {});
    await query(`REVOKE ALL ON DATABASE "${dbName}" FROM ${ROLE}`).catch(() => {});
    try {
      await query(`DROP ROLE IF EXISTS ${ROLE}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[privileges-db] FAILED to drop probe role ${ROLE}: ${(err as Error).message}`);
      throw err;
    }
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
      // ═══ THIS TEST HAS NOW CORRECTED THE GUARD'S WORDING TWICE, IN OPPOSITE DIRECTIONS ═══
      // v1 said "no marker, create one" — wrong, and it told the reader to create a table that
      // was already there. v2 (which this assertion used to pin) said "it already exists, do NOT
      // create a second one" — also wrong, because Postgres raises 42501 from the permission
      // check BEFORE it looks for the relation, so the guard cannot see the difference. The
      // marker really does exist in THIS test, which is exactly why the case is instructive: even
      // here, where the claim would happen to be true, the code has no way to know it.
      //
      // So the assertion is no longer about which of the two stories the message tells. It is
      // that the message tells NEITHER, states the limit plainly, and hands the reader a way to
      // find out for themselves.
      const err: Error = await assertDisposableDatabase(pool, 'postgres://u:p@10.0.0.5:5432/db').then(
        () => { throw new Error('expected a refusal, got success'); },
        (e: Error) => e
      );
      expect(err.message).toMatch(/CANNOT BE DETERMINED/);
      expect(err.message).toMatch(/to_regclass/);            // how to actually settle it
      expect(err.message).toMatch(/GRANT SELECT/);           // what to do if it is there
      expect(err.message).not.toMatch(/carries no disposability marker/); // v1's false claim
      expect(err.message).not.toMatch(/it already exists/);               // v2's false claim
    } finally {
      await pool.end();
    }
  });
});
