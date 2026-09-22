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

/**
 * Canonical form of a host, for classification only.
 *
 * ═══ WHY THE TRAILING DOT MATTERS (both reviewers found this independently) ═══
 * `db.<ref>.supabase.co.` — with a trailing dot — is the DNS-ABSOLUTE (fully-qualified) form of
 * the same name. Resolvers and therefore node-postgres dial it identically, but a naive string
 * comparison does not: it is one character different, so it was NOT matching the managed-host
 * patterns and NOT matching the exact-host override's equality check. That defeated the
 * "refused absolutely, no env var can permit it" guarantee with a single keystroke, and QA
 * demonstrated it live — the connection got past both guards as far as a real DNS lookup.
 *
 * Normalising here rather than in each caller is deliberate: this is the one place that decides
 * what a host "is", so the local check, the managed check and the override comparison cannot
 * drift apart on the question of what counts as the same name.
 *
 * ═══ AND WHY NON-ASCII IS REFUSED RATHER THAN NORMALISED ═══
 * The trailing-dot fix was not enough: `db.<ref>.supabase．co` written with U+FF0E (or U+3002 /
 * U+FF61) matched none of the managed patterns and fell through to the overridable branch. A
 * reviewer showed this is not cosmetic — resolvers really do map those code points onto the real
 * host (one．one．one．one resolves to 1.1.1.1). Full IDNA normalisation would be the general
 * answer, but this is a SAFETY GUARD, not a DNS client: it does not need to understand every
 * internationalised name, it needs to never be fooled by one. So any non-ASCII hostname is treated
 * as unverifiable and refused outright — see hasNonAsciiHost and its callers.
 */
export function hasNonAsciiHost(rawHost: string | null | undefined): boolean {
  return typeof rawHost === 'string' && /[^\x00-\x7F]/.test(rawHost);
}

export function normaliseHost(rawHost: string): string {
  return rawHost
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, ''); // DNS-absolute form: `host.` is the same host as `host`
}

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
 * True when `rawHost` is a MANAGED/HOSTED Postgres endpoint — i.e. a host that, by its very
 * shape, can only be a real hosted database and never a disposable local one.
 *
 * ═══ WHY THIS EXISTS SEPARATELY FROM isLocalDatabaseHost ═══
 * "not local" and "definitely a real hosted database" are different claims, and the 2026-09-21
 * pollution incident turned on the difference. The test guard only asked "is this local?", and
 * its escape hatch (KIDS_FUN_ALLOW_NONLOCAL_DB=1) could then answer "run anyway" for ANY
 * non-local host — including the production Supabase endpoint. A full DB-lane run went into
 * production, minting 56 fixture `source` rows and, far worse, triggering the real scheduler's
 * table-wide writes against live data.
 *
 * A host matching THIS predicate is never a legitimate test target under any override, because
 * no local/disposable Postgres is ever reachable at one of these names: Supabase's local stack
 * serves 127.0.0.1:54322, and CI serves localhost. So the test guard refuses these outright
 * rather than making refusal contingent on an env var that can be set once and left set.
 *
 * Deliberately NOT used for the SSL decision (lib/db/pool-config.ts) — that correctly keys off
 * isLocalDatabaseHost, because a self-hosted remote Postgres also needs SSL.
 *
 * ═══ TWO KNOWN LIMITS, STATED RATHER THAN IMPLIED ═══
 * 1. A managed database reached by RAW IP is not matched. These patterns are hostname shapes, and
 *    an IP carries no name to match. Such a host still falls to the non-local branch and therefore
 *    still needs the exact-host override plus a disposability marker — it is not silently allowed —
 *    but it will not get the "refused absolutely" treatment a named endpoint does.
 * 2. A unix-socket path (`?host=/var/run/postgresql`) is trusted unconditionally as local. That is
 *    correct for a real socket, but a socket is a filesystem object and nothing here proves what is
 *    on the other end of it.
 * Both are narrower than the loopback port-forward gap documented in lib/testing/disposable-db.ts,
 * and all three share one root: an ADDRESS is not an IDENTITY. Closing them properly means asking
 * the server who it is (pg_control_system(), inet_server_addr()), which is a design change owed its
 * own review rather than a mid-incident patch.
 */
export function isManagedDatabaseHost(rawHost: string | null | undefined): boolean {
  if (rawHost == null) return false;
  const host = normaliseHost(rawHost);
  // Behaviour-neutral early-out, verified by mutation: the isLocalDatabaseHost check below answers
  // false for both of these anyway. Kept for readability, and labelled so a future mutation sweep
  // does not mistake a surviving mutant here for an untested branch — it is untestable, not
  // untested.
  if (host === '' || host.startsWith('/')) return false;
  if (isLocalDatabaseHost(host)) return false; // e.g. a ?host=127.0.0.1 override really is local
  // A homoglyph host cannot be pattern-matched safely; treat it as managed so it can never take
  // the overridable branch. Callers that can produce a better message refuse it earlier.
  if (hasNonAsciiHost(rawHost)) return true;
  return MANAGED_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Host shapes that only ever denote a hosted/managed Postgres. Kept narrow and literal: each
 * entry is a provider endpoint format, not a guess about private infrastructure. A remote host
 * that is NOT on this list is still refused by the test guard by default — this list only marks
 * the hosts for which refusal is absolute (no override).
 */
const MANAGED_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)supabase\.co$/, // db.<ref>.supabase.co — Supabase direct connection
  /(^|\.)supabase\.com$/, // aws-0-<region>.pooler.supabase.com — Supabase pooler
  /(^|\.)supabase\.net$/,
  /(^|\.)rds\.amazonaws\.com$/,
  /(^|\.)neon\.tech$/,
  /(^|\.)render\.com$/,
  /(^|\.)railway\.app$/,
  /(^|\.)azure\.com$/,
  /(^|\.)cloudsql\..*\.goog$/,
  /(^|\.)timescaledb\.io$/,
  /(^|\.)cockroachlabs\.cloud$/,
  /(^|\.)digitalocean\.com$/,
  /(^|\.)fly\.dev$/,
  /(^|\.)heroku(app)?\.com$/,
];

/** Where the effective host came from. `default` means nothing specified it — see resolveEffectiveHost. */
export type HostSource = 'url' | 'PGHOST' | 'default';

export interface EffectiveHost {
  /** The host pg will actually dial, or null when the connection string is unparseable. */
  host: string | null;
  source: HostSource;
}

/**
 * The host node-postgres will ACTUALLY dial — including its environment fallback.
 *
 * ═══ WHY resolveConnectionHost ALONE WAS A BYPASS ═══
 * resolveConnectionHost achieves parity with pg-connection-string's PARSER. That is not the same
 * thing as parity with pg's CONNECTION BEHAVIOUR, and the difference was a complete bypass of every
 * guard built on it. In pg/lib/connection-parameters.js the host is resolved by
 * `val('host', config)`, and `val` is:
 *
 *     config[key] || process.env['PG' + KEY] || defaults[key]      (defaults.host = 'localhost')
 *
 * So `postgres:///dbname` — no host at all — parses to an EMPTY host, which the old code classified
 * as local ("a unix socket never reaches a remote server"), while pg would happily connect to
 * whatever PGHOST names. A reviewer proved it end to end: with PGHOST pointed at a Supabase host the
 * guard allowed the connection AND provisioned the disposability marker inside that remote database
 * — which would then have made that host permanently self-vouching for the exact-host override too,
 * i.e. the guard poisoning its own strongest remaining check.
 *
 * It is not a contrived shape either: `set -a; . file` exports PGHOST exactly the way the original
 * incident exported KIDS_FUN_ALLOW_NONLOCAL_DB.
 *
 * Only PGHOST redirects — verified against that file: `val()` is called for host/port/user/password/
 * database/options/binary/replication/sslnegotiation, and node-postgres reads neither PGHOSTADDR nor
 * PGSERVICE. `source` is returned so a caller can be STRICTER than pg where that is appropriate: the
 * test guard refuses `default`, because a destructive lane must never resolve its target from
 * ambient defaults, even though pg itself would happily use localhost.
 */
export function resolveEffectiveHost(connectionString: string): EffectiveHost {
  const parsed = resolveConnectionHost(connectionString);
  // Behaviour-neutral early-out, verified by mutation: `parsed !== ''` below is true for null and
  // returns the identical value. Explicit because "unparseable" and "absent" are different ideas
  // even when they take the same branch.
  if (parsed === null) return { host: null, source: 'url' };
  if (parsed !== '') return { host: parsed, source: 'url' };

  const pgHost = (process.env.PGHOST ?? '').trim();
  if (pgHost !== '') return { host: pgHost, source: 'PGHOST' };

  return { host: 'localhost', source: 'default' }; // pg/lib/defaults.js: host = 'localhost'
}

/**
 * True when `rawHost` is a loopback/local database host.
 *
 * NOTE ON THE EMPTY HOST. This still answers `true` for `''`, because an empty string genuinely is
 * the unix-socket/default case at the level this predicate operates on. But callers must NOT feed
 * it the raw parser output: an absent host means "pg will decide", and pg consults PGHOST. Resolve
 * with resolveEffectiveHost() FIRST and classify that. The old comment here claimed an empty host
 * "never reaches a remote server", which was simply wrong and was the hinge of a full bypass.
 */
export function isLocalDatabaseHost(rawHost: string | null | undefined): boolean {
  if (rawHost == null) return true; // no TCP host at all → local (unix socket / default)
  if (hasNonAsciiHost(rawHost)) return false; // homoglyphs are never classified local
  const host = normaliseHost(rawHost);
  if (host === '') return true; // empty host → local
  if (host.startsWith('/')) return true; // unix-socket path (e.g. ?host=/var/run/postgresql)
  if (LOOPBACK_HOSTS.has(host)) return true; // localhost / 127.0.0.1 / 0.0.0.0 / ::1
  if (host.endsWith('.localhost')) return true; // RFC 6761 loopback TLD (e.g. db.localhost)
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // 127.0.0.0/8
  return false;
}
