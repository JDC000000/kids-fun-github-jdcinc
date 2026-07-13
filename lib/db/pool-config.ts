// lib/db/pool-config.ts — shared pg Pool connection options.
// Supabase direct Postgres requires SSL, while local/CI Postgres does not. Keep
// this in one place so service-level and user-scoped pools behave the same way
// without embedding sslmode requirements into stored secrets.
import type { PoolConfig } from 'pg';

export function poolConfigFor(connectionString: string): PoolConfig {
  const config: PoolConfig = { connectionString, max: 5 };
  if (shouldUseSsl(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

function shouldUseSsl(connectionString: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return false;
  }

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode === 'disable') return false;
  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') return true;

  const host = url.hostname.toLowerCase();
  return !['localhost', '127.0.0.1', '::1'].includes(host);
}
