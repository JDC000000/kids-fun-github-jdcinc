// lib/llm/db.ts — a minimal service-pool transaction helper for the LLM batch job.
//
// A local, purpose-named wrapper rather than reusing lib/admin/audit.ts's
// withAdminTransaction: this job is a SYSTEM actor (no admin identity), so it must not
// borrow the admin mutation path's semantics. The mechanics are the same generic
// BEGIN/COMMIT/ROLLBACK on the service pool.
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/db/client';

/** Run `fn` inside one service-pool transaction; ROLLBACK on any throw. */
export async function withServiceTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback error — surface the original */
    }
    throw err;
  } finally {
    client.release();
  }
}
