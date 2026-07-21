// lib/testing/local-db-guard.ts — Vitest safety net (Round 27 approval-bypass incident:
// documents/execution/kids-fun-round27-incident-approval-bypass-2026-07-21.md).
//
// WHY: the incident's root cause was a DB-backed integration test run pointed at the
// REAL staging database, which wrote synthetic 'confirmed' fixtures straight into
// user-visible data. DB-backed suites here mint throwaway rows (uniquely-named sources,
// series, occurrences) and are only safe against a LOCAL, disposable Postgres. This
// module refuses to let ANY test run when DATABASE_URL / USER_DATABASE_URL point at a
// non-local host, so a mis-set env can never again target a real database by accident.
//
// It is wired as a Vitest `setupFiles` entry (vitest.config.ts), so it runs once per
// test file BEFORE any test — including future DB-backed suites — with zero per-test
// wiring. When DATABASE_URL is unset (pure-unit runs) it is a no-op; the DB-gated
// suites skip themselves via their own `hasDb` checks.
//
// This is the complementary, cheaper half of the Round 27 fix. The primary, structural
// guarantee is the DB trigger in supabase/migrations/0021_confirmed_requires_terms_approval.sql
// (a confirmed occurrence can never persist against a non-terms-approved source). This
// guard stops the *accident vector* — a test aimed at prod — one layer earlier.
//
// Escape hatch (deliberate, loud — mirrors migrate.sh's MIGRATE_ALLOW_CHECKSUM_MISMATCH):
//   KIDS_FUN_ALLOW_NONLOCAL_DB=1   downgrades the refusal to allow, for the rare case
//   an operator intentionally runs read-only checks against a remote DB. NEVER set this
//   in CI or when a suite writes fixtures.

/** Loopback / local host literals a disposable test DB may legitimately use. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1']);

/**
 * True when `rawHost` is a loopback/local database host. An empty/omitted host (unix
 * socket or libpq default) is treated as local — those never reach a remote server.
 */
export function isLocalDatabaseHost(rawHost: string | null | undefined): boolean {
  if (rawHost == null) return true; // no TCP host at all → local (unix socket / default)
  const host = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') return true; // empty host → local
  if (host.startsWith('/')) return true; // unix-socket path (e.g. ?host=/var/run/postgresql)
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true; // RFC 6761 loopback TLD
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // 127.0.0.0/8
  return false;
}

/**
 * Extract the connection host from a Postgres URL. Returns the hostname, or the unix
 * socket path if the URL uses one (`?host=/path`), or `''` when neither is present.
 * Returns `null` when the string cannot be parsed as a URL at all (unverifiable).
 */
export function databaseUrlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname) return u.hostname;
    return u.searchParams.get('host') ?? '';
  } catch {
    return null;
  }
}

function isTruthyEnv(v: string | undefined): boolean {
  return v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
}

/**
 * Throw unless `url` is unset or points at a local database. `label` names the env var
 * in the error. The `KIDS_FUN_ALLOW_NONLOCAL_DB` escape hatch bypasses the check.
 */
export function assertLocalDatabaseUrl(url: string | undefined, label = 'DATABASE_URL'): void {
  if (!url) return; // unset → nothing to guard (DB-gated suites skip via hasDb)
  if (isTruthyEnv(process.env.KIDS_FUN_ALLOW_NONLOCAL_DB)) return;

  const host = databaseUrlHost(url);
  if (host === null) {
    throw new Error(
      `[local-db-guard] ${label} is set but is not a parseable connection URL — refusing to ` +
        `run DB-backed tests against an unverifiable target. Check the value, or set ` +
        `KIDS_FUN_ALLOW_NONLOCAL_DB=1 to override deliberately.`
    );
  }
  if (!isLocalDatabaseHost(host)) {
    throw new Error(
      `[local-db-guard] ${label} points at non-local host "${host}". DB-backed integration ` +
        `tests write throwaway fixtures and must NEVER target a real or staging database ` +
        `(Round 27 approval-bypass incident). Point it at a local Postgres ` +
        `(localhost / 127.0.0.1 — e.g. scripts/local-db-bootstrap.sh), or, only if you ` +
        `truly mean to, set KIDS_FUN_ALLOW_NONLOCAL_DB=1.`
    );
  }
}

// Self-execute when loaded as a Vitest setup file: guard every DB URL a test pool may
// connect to (lib/db/client → DATABASE_URL; lib/db/user-scoped-client → USER_DATABASE_URL).
assertLocalDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
assertLocalDatabaseUrl(process.env.USER_DATABASE_URL, 'USER_DATABASE_URL');
