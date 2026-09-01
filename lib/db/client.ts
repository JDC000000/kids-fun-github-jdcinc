// lib/db/client.ts — shared Postgres pool wrapper (server-side only).
// Reads DATABASE_URL (TSD §3A.1). Used by lib/*, tests, and app/api routes.
// NOT for client/browser code — this touches `pg` directly.
import { Pool, type QueryResultRow } from 'pg';
import { poolConfigFor } from './pool-config';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool(poolConfigFor(connectionString));
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await getPool().query<T>(text, params);
  return rows;
}

/**
 * Run one query under a PER-QUERY `statement_timeout`, so an abandoned HTTP request cannot leave
 * an uncancellable scan burning production I/O.
 *
 * ═══ WHY PER-QUERY AND NOT A POOL-LEVEL DEFAULT ═══
 * This pool is shared by everything: the Fly worker's retention purge (lib/retention/sms.ts) runs
 * deliberately long bounded batches through it, and so do the analytics/corrections purges. A
 * connection-level timeout tuned for a sub-second admin read would start killing legitimate
 * maintenance work that deletes people's data on a schedule. So the default stays unbounded and a
 * caller opts in — reads opt in, purges do not.
 *
 * ═══ WHY A TRANSACTION ═══
 * `SET LOCAL` is scoped to the transaction and is reverted by COMMIT/ROLLBACK, which is the whole
 * point on a POOLED connection: a bare `SET statement_timeout` would persist on that connection
 * and silently apply to whatever unrelated caller picked it up next. The transaction is not for
 * atomicity; it is the mechanism that guarantees the setting cannot leak.
 *
 * `SET` cannot take a bind parameter, so the value is interpolated — hence the truncation and
 * clamp, which make it structurally impossible for this to be an injection point.
 *
 * On expiry Postgres raises 57014 (`query_canceled`) and THIS THROWS. That is deliberate: the
 * caller gets a real error to handle rather than a silently empty result.
 */
export async function queryWithTimeout<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] | undefined,
  timeoutMs: number
): Promise<T[]> {
  const ms = Math.min(Math.max(Math.trunc(timeoutMs), 1), 600_000);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${ms}`);
    const { rows } = await client.query<T>(text, params);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be unusable; the original error is the one worth raising.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
