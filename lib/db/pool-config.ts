// lib/db/pool-config.ts — shared pg Pool connection options.
// Supabase direct Postgres requires SSL, while local/CI Postgres does not. Keep
// this in one place so service-level and user-scoped pools behave the same way
// without embedding sslmode requirements into stored secrets.
import type { PoolConfig } from 'pg';

import { isLocalDatabaseHost, resolveConnectionHost } from './connection-host';

/**
 * How long `pool.connect()` may wait for a free connection before giving up.
 *
 * ═══ WHY AN UNSET VALUE WAS A BUG, NOT A DEFAULT ═══
 * node-postgres treats `connectionTimeoutMillis: 0` (its default) as WAIT FOREVER. With
 * `max: 5` and /admin/operating fanning nine concurrent reads out of one Promise.all, four
 * of those reads necessarily queue — and if the five holding connections are running the
 * multi-minute analytics scans measured on 2026-09-14 (individual statements observed still
 * executing at 1m59s, after the HTTP request that started them had already 500'd), the four
 * waiters had no ceiling at all. They sat on a serverless function until something else
 * ended it.
 *
 * 10s is deliberately far SHORTER than ADMIN_ANALYTICS_QUERY_TIMEOUT_MS. Waiting longer than
 * that for a slot means the pool is saturated by work that is itself about to be cancelled,
 * and failing fast returns the serverless function instead of stacking another one behind it.
 */
export const CONNECTION_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * How long an unused connection may sit in the pool before we close it ourselves.
 *
 * Stated explicitly rather than inherited, because on this deployment the alternative to
 * closing it is that SOMEBODY ELSE does. Supabase/the platform reclaims server-side
 * backends, and a connection reclaimed while parked in our pool surfaces as
 * `57P01 terminating connection due to administrator command` on whichever unlucky request
 * picks it up next — an error about a query that did nothing wrong. Closing our own idle
 * connections first makes that race rarer; the pool `error` handler in client.ts is what
 * makes it survivable when it still happens.
 *
 * 10s matches node-postgres's own default; it is written down so it is a decision.
 */
const IDLE_CONNECTION_TIMEOUT_MS = 10_000;

/** Maximum concurrent connections this pool will open. Exported so error messages and
 *  diagnostics quote the real value rather than a copy that can drift from it. */
export const POOL_MAX = 5;

export function poolConfigFor(connectionString: string): PoolConfig {
  const config: PoolConfig = {
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_ACQUIRE_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_CONNECTION_TIMEOUT_MS,
  };
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
