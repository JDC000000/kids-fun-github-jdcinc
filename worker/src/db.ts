import { Pool, type PoolClient, type PoolConfig } from 'pg';

// Single place that builds the worker's Postgres pool so every entrypoint
// (scheduler loop, ingest-once) connects identically. Supabase — pooler or
// direct — terminates TLS; a local dev Postgres usually does not. We enable TLS
// by default and only turn it off for localhost or an explicit opt-out, so the
// exact same image works against the staging Supabase pooler (on Fly or in local
// Docker) and against a developer's local database.

export function shouldUseSsl(connectionString: string): boolean {
  if (process.env.WORKER_DB_SSL === 'disable') return false;
  if (/[?&]sslmode=disable\b/.test(connectionString)) return false;
  if (/@(localhost|127\.0\.0\.1|host\.docker\.internal|\[::1\])[:/]/.test(connectionString)) return false;
  return true;
}

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const config: PoolConfig = {
    connectionString,
    max: Number(process.env.WORKER_DB_POOL_MAX ?? 4),
  };
  if (shouldUseSsl(connectionString)) {
    // Supabase presents a managed cert chain Node doesn't bundle; the wire is
    // still encrypted. rejectUnauthorized:false matches Supabase's documented
    // node-postgres setup and the repo's migration/CI harness.
    config.ssl = { rejectUnauthorized: false };
  }
  return attachConnectionErrorHandlers(new Pool(config));
}

/** Receives one line per drop event (see LOG LINES below). Never the client object: it carries connectionParameters. */
export type ConnectionDropLogger = (message: string) => void;

// eslint-disable-next-line no-console
const logToStderr: ConnectionDropLogger = (message) => console.error(message);

/**
 * Make a dropped Postgres connection a logged, recoverable event instead of a process crash.
 *
 * ═══ THE CRASH (reproduced against a real Postgres, 2026-09-22) ═══
 * pg Pool and pg Client are both EventEmitters, and an EventEmitter that emits 'error' with no
 * listener THROWS. The worker's pool had none, so a server-side termination of one idle pooled
 * backend — Supavisor recycling, a failover, `pg_terminate_backend` — became an uncaught
 * exception, and index.ts's uncaughtException handler turned that into process.exit(1).
 *
 * TWO listeners are needed, because pg-pool only guards a client while it is IDLE:
 *   • IDLE client dies → pg-pool's own idle listener discards it and re-emits on the POOL
 *     (`pool.emit('error', err, client)`). Needs `pool.on('error')`. The client is already
 *     removed by then; the next checkout opens a fresh connection. Nothing to clean up.
 *   • CHECKED-OUT client dies (pool.connect() — e.g. the global-jobs tick transaction) →
 *     pg-pool strips its idle listener on checkout, so the Client itself emits 'error' with
 *     nobody listening. `pool.on('error')` does NOT cover this; a per-client listener does.
 *     The caller still finds out: an active query rejects with the error, and a query issued
 *     afterwards rejects with "not queryable". pg-pool's release() discards a client whose
 *     `_queryable` is false, so the dead connection never goes back into the pool.
 *
 * LOG LINES — measured per case against a real Postgres, not the same count for every case:
 *   • idle client dies                          → exactly 1 line (pool listener)
 *   • pool.query() killed mid-query             → 0 lines: pg-pool's own per-query listener
 *     handles it and the query rejects to its caller. That was ALREADY the behaviour before this
 *     change; it is not something these listeners add.
 *   • checked-out client killed mid-query       → 1 line
 *   • checked-out client killed between queries → 2 lines: the server's 57P01, then the socket's
 *     "Connection terminated unexpectedly" — both are real events on the same client.
 *
 * Deliberately not reported to Sentry: an idle drop is routine under a recycling pooler and the
 * pool heals itself. Anything that actually failed because of a drop surfaces as a rejected
 * query in its caller, which already reports it.
 */
export function attachConnectionErrorHandlers(
  pool: Pool,
  log: ConnectionDropLogger = logToStderr
): Pool {
  // Only so the per-client listener stays quiet for IDLE drops, which the pool listener below
  // already reports — an idle drop logs once, not twice. (Checked-out drops can log 0–2 lines; see
  // LOG LINES above.)
  const checkedOut = new WeakSet<PoolClient>();
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_err, client) => checkedOut.delete(client));

  pool.on('connect', (client) => {
    client.on('error', (err) => {
      if (!checkedOut.has(client)) return;
      log(describeDrop('pooled connection died while checked out; the caller sees the error and it will be discarded on release', err, client, pool));
    });
  });

  pool.on('error', (err, client) => {
    log(describeDrop('idle pooled connection died and was discarded; the pool will open a fresh one on demand', err, client, pool));
  });

  return pool;
}

function describeDrop(what: string, err: Error, client: PoolClient | undefined, pool: Pool): string {
  const code = (err as { code?: unknown }).code;
  // processID is the server backend pid — the handle for matching this line to Postgres/pooler logs.
  const backendPid = (client as { processID?: unknown } | undefined)?.processID;
  return (
    `[db] ${what}: ${err.message}` +
    ` (backendPid=${backendPid ?? 'unknown'} code=${typeof code === 'string' ? code : 'none'}` +
    ` at=${new Date().toISOString()} pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount})`
  );
}
