import { Pool, type PoolConfig } from 'pg';

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
  return new Pool(config);
}
