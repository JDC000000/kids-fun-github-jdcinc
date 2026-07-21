// lib/db/pool-config.ts — shared pg Pool connection options.
// Supabase direct Postgres requires SSL, while local/CI Postgres does not. Keep
// this in one place so service-level and user-scoped pools behave the same way
// without embedding sslmode requirements into stored secrets.
import type { PoolConfig } from 'pg';
import { isLocalDatabaseHost, resolveConnectionHost } from './connection-host';

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

  // Decide SSL from the host pg will ACTUALLY connect to — honoring a `?host=` override the
  // same way node-postgres does (see lib/db/connection-host.ts). Reading `url.hostname` alone
  // ignored that override, so `postgres://127.0.0.1/db?host=db.x.supabase.co` (which really
  // lands on remote Supabase, requiring SSL) looked local here and disabled SSL — the same
  // root-cause gap fixed in lib/testing/local-db-guard.ts (Round 27 approval-bypass incident).
  // Local / loopback / unix-socket → no SSL; anything else (real Supabase/RDS) → SSL.
  const host = resolveConnectionHost(connectionString);
  if (host === null) return false; // unparseable — consistent with the new URL() guard above
  return !isLocalDatabaseHost(host);
}
