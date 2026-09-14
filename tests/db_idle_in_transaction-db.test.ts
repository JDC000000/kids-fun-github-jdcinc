// tests/db_idle_in_transaction-db.test.ts — the transaction queryWithTimeout opens must never
// be able to wedge a pooled connection forever.
//
// REGRESSION, production 2026-09-14. queryWithTimeout wraps every read in BEGIN…COMMIT so that
// `SET LOCAL statement_timeout` cannot leak onto a pooled connection. Correct mechanism, but it
// made an abandoned request LETHAL rather than merely wasteful: when the serverless function was
// torn down mid-transaction (a sibling read in the same Promise.all had already rejected and
// returned a 500), nobody sent COMMIT, and Postgres kept that backend alive in
// `idle in transaction` — permanently, because the server's own idle_in_transaction_session_timeout
// is 0 and statement_timeout does not apply to a session running no statement.
//
// Five of five pool slots ended up wedged, so every later request failed at exactly the 10s
// acquire window: two admin pages returning 500 at ~10.3s with total consistency, one request at
// a time. Self-amplifying — each 500 wedged more connections and guaranteed the next one.
import { describe, expect, it, afterAll } from 'vitest';
import { Pool } from 'pg';
import { closePool, query, queryWithTimeout } from '../lib/db/client';
import { ADMIN_ANALYTICS_QUERY_TIMEOUT_MS } from '../lib/db/budgets';

const hasDb = Boolean(process.env.DATABASE_URL);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasDb)('queryWithTimeout — an abandoned transaction cannot wedge a connection', () => {
  afterAll(async () => {
    await closePool();
  });

  // Asked from INSIDE the transaction, so this reads what the query itself would be governed
  // by rather than what we hoped was set.
  it('arms idle_in_transaction_session_timeout on the transaction it opens', async () => {
    // Cast through interval: Postgres renders these with a unit ('45s', '15s'), so comparing
    // the raw strings would pin a formatting choice rather than the value.
    const rows = await queryWithTimeout<{ idle_ms: number; stmt_ms: number }>(
      `SELECT (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval) * 1000)::int AS idle_ms,
              (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::int AS stmt_ms`,
      undefined,
      ADMIN_ANALYTICS_QUERY_TIMEOUT_MS
    );
    expect(rows[0].idle_ms, 'an abandoned transaction must have a deadline').toBeGreaterThan(0);
    // …and the statement bound is still there; the new setting must not have displaced it.
    expect(rows[0].stmt_ms).toBe(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  // SET LOCAL is the whole reason the transaction exists. If either setting survived COMMIT it
  // would apply to whatever unrelated caller picked that pooled connection up next.
  it('leaves neither setting behind on the pooled connection', async () => {
    await queryWithTimeout(`SELECT 1`, undefined, ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
    const after = await query<{ idle: string; stmt: string }>(
      `SELECT current_setting('idle_in_transaction_session_timeout') AS idle,
              current_setting('statement_timeout') AS stmt`
    );
    expect(after[0].idle).toBe('0');
    expect(after[0].stmt).toBe('0');
  });

  // The behaviour itself, on a real server, at a scaled-down deadline so the suite does not
  // wait 15s. This is the case that was broken: hold a transaction open and walk away.
  it('Postgres reclaims the backend, and the holder survives the FATAL', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    pool.on('error', () => {});
    const watcher = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const client = await pool.connect();
      // The per-call listener queryWithTimeout installs. Without it this FATAL arrives on a
      // checked-out client with NO listener — pg-pool strips its own on checkout — and an
      // EventEmitter 'error' with no listener takes the whole process down.
      let fatal: Error | undefined;
      const onErr = (e: Error): void => { fatal = e; };
      client.on('error', onErr);

      await client.query(
        `BEGIN; SET LOCAL statement_timeout = 45000; SET LOCAL idle_in_transaction_session_timeout = 1500;`
      );
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0].pid;

      const stateOf = async (): Promise<string | null> => {
        const r = await watcher.query<{ state: string }>(
          'SELECT state FROM pg_stat_activity WHERE pid = $1',
          [pid]
        );
        return r.rows[0]?.state ?? null;
      };
      expect(await stateOf()).toBe('idle in transaction');

      await sleep(3000); // past the 1.5s deadline

      expect(await stateOf(), 'the wedged backend must be gone, not merely old').toBeNull();
      expect(fatal, 'and the FATAL must have been caught, not thrown at the process').toBeDefined();

      client.removeListener('error', onErr);
      client.release(fatal); // truthy => pg-pool destroys rather than re-pools a dead client
      expect((await pool.query<{ ok: number }>('SELECT 42 AS ok')).rows[0].ok).toBe(42);
    } finally {
      await pool.end().catch(() => {});
      await watcher.end().catch(() => {});
    }
  }, 20_000);
});
