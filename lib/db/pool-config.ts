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
 * /admin/operating fanning twelve concurrent reads out of one Promise.all, some necessarily
 * queue — and if the connections they are waiting on are running the multi-minute analytics
 * scans measured on 2026-09-14 (individual statements observed still executing at 1m59s,
 * after the HTTP request that started them had already 500'd), those waiters had no ceiling
 * at all. They sat on a serverless function until something else ended it.
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

/**
 * Maximum concurrent connections this pool will open, per serverless instance.
 *
 * ═══ RAISED 5 -> 10 ON 2026-09-14, AS A CAPACITY DECISION WITH NUMBERS BEHIND IT ═══
 * At 5 this was below what a single admin page asks for: /admin/operating fans TWELVE
 * concurrent reads out of one Promise.all and /admin/dashboard about eight, so reads queued
 * on every load and a page could exhaust the pool on its own. Reproduced on production: TWO
 * concurrent page loads — a refresh, or two open tabs — reliably returned a 500 at 10.20s,
 * which is exactly CONNECTION_ACQUIRE_TIMEOUT_MS. Not a spike; two requests.
 *
 * The budget it was approved against, read off production the same day: max_connections 60,
 * 24 in use, 3 superuser-reserved, ~33 free. 10 leaves /admin/dashboard queueing nothing and
 * /admin/operating queueing two.
 *
 * ⚠ THIS NUMBER IS ONLY SAFE ALONGSIDE THE IDLE-IN-TRANSACTION GUARD in client.ts, and the
 * dependency runs the wrong way round from how it looks. A bigger pool is WORSE during a
 * wedge, not better: when a torn-down function abandons open transactions, ten connections
 * get stuck instead of five and the pool takes longer to recover. It is only safe because
 * IDLE_IN_TRANSACTION_TIMEOUT_MS now makes a wedged slot self-clear in 15s. Do not raise this
 * further — and never ship a raise ahead of that guard — without re-reading both.
 *
 * Exported so error messages and diagnostics quote the real value rather than a copy that can
 * drift from it.
 */
export const POOL_MAX = 10;

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
