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
// ═══ 2026-09-21 INCIDENT: WHY THE ESCAPE HATCH NO LONGER APPLIES TO TEST RUNS ═══
// The Round 27 design above had ONE bypass: KIDS_FUN_ALLOW_NONLOCAL_DB=1 downgraded the
// refusal to an allow for ANY non-local host, so that an operator could point a read-only
// probe at a remote DB. On 2026-09-21 an env file (.env.qa in a QA worktree) bundled, in a
// single file, a PRODUCTION superuser DATABASE_URL *and* KIDS_FUN_ALLOW_NONLOCAL_DB=1. One
// `set -a; . .env.qa; npm test` later, the whole DB lane had run against production: 56
// fixture `source` rows, an unscoped `DELETE FROM job_queue`
// that destroyed pending prod ingest jobs, a corrupted llm_batch_run watermark, two orphan
// `admin_user` rows, and — the real damage — 16,561 REAL occurrences flipped to 'stale' by
// the genuine scheduler that tests/scheduler/*-db.test.ts deliberately runs for real.
//
// THE LESSON IS ABOUT THE SHAPE OF THE OVERRIDE, NOT ABOUT DISCIPLINE. A boolean env var is
// exactly the wrong shape for this: it is target-independent, so it keeps applying to every
// database the process is later pointed at, and it is sticky — `export`ed once for a
// legitimate read probe, it silently authorises the next thing that runs in that shell. The
// snapshot runbook already warned against setting it and leaving it set; the warning was
// correct and insufficient, because the failure mode did not require anyone to ignore it.
//
// SO THE TEST PATH NOW HAS NO BOOLEAN OVERRIDE AT ALL (assertTestDatabaseUrl below):
//   • a MANAGED/hosted host (db.*.supabase.co, *.pooler.supabase.com, RDS, …) is refused
//     ABSOLUTELY — no env var can permit it, because no such host is ever a disposable DB;
//   • any other non-local host is refused unless KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST names
//     that EXACT resolved host. Naming the target is what makes the override non-sticky: a
//     value left over from another database simply does not match, and fails closed.
//
// `assertLocalDatabaseUrl` keeps its original boolean-hatch semantics for NON-TEST callers
// (operator read-probe scripts that import it directly). Nothing in the test path calls it.

// Host classification + resolution live in a shared, side-effect-free module so this guard
// and the runtime pool config (lib/db/pool-config.ts) resolve the connection host the SAME
// way node-postgres does — honoring a `?host=` override. See lib/db/connection-host.ts for
// the full rationale (Round 27 approval-bypass incident).
import { hasNonAsciiHost, isLocalDatabaseHost, isManagedDatabaseHost, normaliseHost, resolveConnectionHost } from '@/lib/db/connection-host';

// Re-exported so existing importers (and tests) can keep importing them from this module.
export { isLocalDatabaseHost, isManagedDatabaseHost };

/**
 * Extract the host node-postgres will ACTUALLY connect to for a Postgres URL — honoring a
 * `?host=` override the same way pg does (a `?host=` value OVERRIDES the URL hostname, in both
 * directions; `?host=/path` yields the unix-socket path). Returns `''` when no host is present,
 * or `null` when the string cannot be parsed as a connection URL at all (unverifiable).
 *
 * Previously this read `new URL(url).hostname` first and only fell back to `?host=` when the
 * hostname was empty — the exact bug that let `postgres://127.0.0.1/db?host=db.x.supabase.co`
 * (which really connects to remote Supabase) masquerade as local and slip past the guard.
 */
export function databaseUrlHost(url: string): string | null {
  return resolveConnectionHost(url);
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

/** Env var that may name ONE exact non-local, non-managed host as a permitted test target. */
export const TEST_HOST_OVERRIDE_ENV = 'KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST';

/**
 * The assertion the TEST path uses. Unlike assertLocalDatabaseUrl it has no boolean override:
 *
 *   • unset URL            → no-op (DB-gated suites skip themselves via their own `hasDb`)
 *   • local host           → allowed
 *   • unparseable          → refused (fails closed; unverifiable target)
 *   • MANAGED/hosted host  → refused ABSOLUTELY, no override honoured
 *   • other non-local host → refused unless KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST === that host
 *
 * The override compares against the RESOLVED host (so a `?host=` override cannot smuggle a
 * different target past it) and must match exactly — case-insensitively, brackets stripped.
 */
export function assertTestDatabaseUrl(url: string | undefined, label = 'DATABASE_URL'): void {
  if (!url) return;

  const host = resolveConnectionHost(url);
  if (host === null) {
    throw new Error(
      `[local-db-guard] ${label} is set but is not a parseable connection URL — refusing to ` +
        `run DB-backed tests against an unverifiable target. Check the value, or unset it.`
    );
  }
  // A non-ASCII hostname is refused before any classification: `supabase．co` with U+FF0E is a
  // different STRING from `supabase.co` but resolvers map it to the same HOST, so pattern matching
  // cannot be trusted on it. Refused outright rather than normalised — this is a guard, not a DNS
  // client, and it only has to be un-foolable.
  if (hasNonAsciiHost(host)) {
    throw new Error(
      `[local-db-guard] REFUSING TO RUN: ${label} has a non-ASCII hostname ("${host}"). ` +
        `Homoglyph characters (U+FF0E / U+3002 / U+FF61 full stops, among others) resolve to the ` +
        `same host as their ASCII form while defeating string matching, so such a host can never ` +
        `be classified safely here. Use the plain ASCII hostname.`
    );
  }
  if (isLocalDatabaseHost(host)) return;

  if (isManagedDatabaseHost(host)) {
    throw new Error(
      `[local-db-guard] REFUSING TO RUN: ${label} points at the MANAGED/HOSTED database host ` +
        `"${host}". DB-backed suites here mint fixtures AND run the real scheduler, whose writes ` +
        `(flipStaleOccurrences, DELETE FROM job_queue) are table-wide — on 2026-09-21 exactly ` +
        `this mistake flipped 16,561 real production occurrences to 'stale'. There is NO ` +
        `environment variable that permits this: a hosted endpoint is never a disposable test ` +
        `database. Point ${label} at a local Postgres (scripts/local-db-bootstrap.sh), or unset ` +
        `it to skip the DB suites. If you need to READ production, use a purpose-built ` +
        `read-only probe with its own env var — never ${label}.`
    );
  }

  // Both sides go through the SAME normaliser, so `db.x.supabase.co.` cannot be presented as a
  // different host from `db.x.supabase.co` to slip past an allowlist entry (or past the managed
  // check above).
  const allowed = normaliseHost(process.env[TEST_HOST_OVERRIDE_ENV] ?? '');
  const normalised = normaliseHost(host);
  if (allowed !== '' && allowed === normalised) return;

  throw new Error(
    `[local-db-guard] ${label} points at non-local host "${host}". DB-backed integration tests ` +
      `write throwaway fixtures and run table-wide scheduler writes, so they must NEVER target a ` +
      `real or staging database (Round 27 approval-bypass incident; 2026-09-21 production ` +
      `pollution). Point it at a local Postgres (localhost / 127.0.0.1 — e.g. ` +
      `scripts/local-db-bootstrap.sh). If this really is a disposable remote test database, name ` +
      `it EXACTLY: ${TEST_HOST_OVERRIDE_ENV}="${normalised}". A boolean opt-out is deliberately ` +
      `not accepted here — it was the 2026-09-21 root cause.`
  );
}

// Self-execute when loaded as a Vitest setup file: guard every DB URL a test pool may
// connect to (lib/db/client → DATABASE_URL; lib/db/user-scoped-client → USER_DATABASE_URL).
// NOTE: assertTestDatabaseUrl, NOT assertLocalDatabaseUrl — the test path does not honour the
// KIDS_FUN_ALLOW_NONLOCAL_DB boolean (see the incident note in this file's header).
assertTestDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
assertTestDatabaseUrl(process.env.USER_DATABASE_URL, 'USER_DATABASE_URL');
