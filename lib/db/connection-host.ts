// lib/db/connection-host.ts — single source of truth for "what host will pg ACTUALLY
// connect to for this connection string, and is that host local?".
//
// Used by both the runtime pool config (lib/db/pool-config.ts — to decide SSL) and the
// Vitest test safety net (lib/testing/local-db-guard.ts — to refuse remote/staging DBs).
// This module is deliberately SIDE-EFFECT-FREE (no top-level env reads, no throws on load)
// so it is safe to import from production runtime code; the guard keeps its own import-time
// self-execution.
//
// WHY it exists (Round 27 approval-bypass incident:
// documents/execution/kids-fun-round27-incident-approval-bypass-2026-07-21.md):
//
//   node-postgres derives its connection host from pg-connection-string's parse().host
//   (see pg/lib/connection-parameters.js: `parse(config)` with NO options, then
//   `this.host = val('host', config)`). That parser treats a `?host=` query parameter as an
//   OVERRIDE of the URL's hostname — in BOTH directions:
//
//     postgres://127.0.0.1/db?host=db.real.supabase.co  → pg connects to db.real.supabase.co
//     postgres://db.real.supabase.co/db?host=127.0.0.1  → pg connects to 127.0.0.1
//
//   Both the SSL decision and the test guard previously read `new URL(url).hostname` and only
//   consulted `?host=` when the hostname was empty. So a remote-via-?host= URL reported as
//   local (127.0.0.1) to both — SSL got silently disabled, and the guard let a test run
//   against a real database, reopening the exact accident vector the guard exists to close.
//
//   Delegating host resolution to the SAME parser pg uses guarantees parity with what really
//   connects — not just today's understanding of the precedence rule.
import { parse } from 'pg-connection-string';

/** Loopback / local host literals a disposable/local database may legitimately use. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1']);

/**
 * Resolve the host node-postgres will ACTUALLY connect to for `connectionString`, honoring a
 * `?host=` override exactly as pg does (pg calls pg-connection-string's `parse()` with no
 * options; see pg/lib/connection-parameters.js).
 *
 * Returns:
 *  - the resolved host (may be a hostname, an IP, or a unix-socket path from `?host=/path`),
 *  - `''` when no host is present (unix-socket default / libpq default → treated as local),
 *  - `null` when the string is not a parseable connection URL at all (unverifiable — callers
 *    should fail closed).
 *
 * Note: pg-connection-string's `parse()` is deliberately lenient and NEVER throws — it returns
 * a placeholder host (`"base"`) for non-URL garbage. We therefore gate on `new URL()` first to
 * preserve the "unverifiable → null" contract instead of letting garbage look like a real host.
 */
export function resolveConnectionHost(connectionString: string): string | null {
  try {
    new URL(connectionString);
  } catch {
    return null;
  }
  return parse(connectionString).host ?? '';
}

/**
 * True when `rawHost` is a loopback/local database host. An empty/omitted host (unix socket or
 * libpq default) is treated as local — those never reach a remote server.
 */
export function isLocalDatabaseHost(rawHost: string | null | undefined): boolean {
  if (rawHost == null) return true; // no TCP host at all → local (unix socket / default)
  const host = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') return true; // empty host → local
  if (host.startsWith('/')) return true; // unix-socket path (e.g. ?host=/var/run/postgresql)
  if (LOOPBACK_HOSTS.has(host)) return true; // localhost / 127.0.0.1 / 0.0.0.0 / ::1
  if (host.endsWith('.localhost')) return true; // RFC 6761 loopback TLD (e.g. db.localhost)
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // 127.0.0.0/8
  return false;
}
