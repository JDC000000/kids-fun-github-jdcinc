// lib/testing/supabase-guard.ts — SAFETY GATE for the E2E test-session harness.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS (named safety requirement #1)
// ─────────────────────────────────────────────────────────────────────────────
// The E2E harness mints a REAL Supabase Auth session for a dedicated test user by
// calling the SERVICE-ROLE admin API (see lib/testing/test-session.ts, which reuses
// the same service-role admin pattern as lib/db/auth-admin.ts). The service-role key
// is an all-powerful secret: pointed at the wrong project it could create users in,
// or otherwise mutate, a REAL/production Supabase.
//
// This module is the single choke point that makes that categorically impossible by
// accident. Every code path that is about to use the service-role admin capability
// MUST call assertTestOnlySupabaseTarget() FIRST and let it throw. It is a
// DEFAULT-DENY allowlist, not a blocklist:
//
//   • Only loopback Supabase URLs (127.0.0.1 / localhost / ::1 / 0.0.0.0) are
//     allowed out of the box — i.e. a `supabase start` local stack.
//   • A non-loopback host is refused UNLESS it is *explicitly* named in the
//     E2E_ALLOWED_SUPABASE_HOSTS env var (for a deliberately-provisioned, throwaway
//     remote TEST project). Adding a host there is an auditable, intentional act.
//   • If NEXT_PUBLIC_APP_ENV is `production`, the gate refuses unconditionally —
//     even a loopback URL — belt-and-braces against a mis-set env.
//
// Because it is default-deny, a production project ref (e.g. https://<prod>.supabase.co)
// can NEVER match without someone deliberately pasting that exact host into the
// test-only allowlist AND setting the app env to non-production — two intentional,
// reviewable steps, not a silent default. On any mismatch the gate throws loudly
// (UnsafeSupabaseTargetError) rather than "trusting the env var is set correctly".
//
// This module is intentionally dependency-free (pure URL logic) so it is trivial to
// unit-test in the standard Vitest suite — see tests/testing/supabase-guard.test.ts.
// It is under lib/testing/** and is NEVER imported by app/**, worker/**, or any
// production code path.

/** Thrown when the configured Supabase target is not a sanctioned test target. */
export class UnsafeSupabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSupabaseTargetError';
  }
}

/** Hostnames that are always considered a local/test Supabase (a `supabase start` stack). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

export interface SupabaseGuardInput {
  /** process.env.SUPABASE_URL — the target the service-role admin call would hit. */
  supabaseUrl: string | undefined;
  /** process.env.NEXT_PUBLIC_APP_ENV — 'development' | 'staging' | 'production' | 'test'. */
  appEnv: string | undefined;
  /** process.env.E2E_ALLOWED_SUPABASE_HOSTS — comma-separated "host" or "host:port" allowlist for a remote TEST project. */
  allowedHostsEnv?: string | undefined;
}

export interface SupabaseGuardResult {
  /** The lower-cased hostname that was validated. */
  host: string;
  /** The port, if the URL specified one. */
  port: string | null;
  /** Why the target was accepted — useful for audit logging when minting a session. */
  reason: 'loopback' | 'allowlisted';
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Assert that `supabaseUrl` is a sanctioned TEST target for the service-role admin
 * capability. Returns a small result (for audit logging) on success; throws
 * UnsafeSupabaseTargetError otherwise. Never returns for a non-test target.
 */
export function assertTestOnlySupabaseTarget(input: SupabaseGuardInput): SupabaseGuardResult {
  const appEnv = (input.appEnv ?? '').trim().toLowerCase();

  // (0) Hard stop on production, regardless of URL. The E2E harness must never be
  //     wired into a production-flagged runtime.
  if (appEnv === 'production' || appEnv === 'prod') {
    throw new UnsafeSupabaseTargetError(
      'Refusing to mint a test session: NEXT_PUBLIC_APP_ENV is "production". ' +
        'The E2E service-role session harness must only run in development/test/CI.',
    );
  }

  // (1) A target is required.
  if (!input.supabaseUrl || !input.supabaseUrl.trim()) {
    throw new UnsafeSupabaseTargetError(
      'Refusing to mint a test session: SUPABASE_URL is not set. ' +
        'Point it at a local `supabase start` stack (http://127.0.0.1:54321) or an explicitly allowlisted test project.',
    );
  }

  // (2) Must be a parseable URL.
  let url: URL;
  try {
    url = new URL(input.supabaseUrl);
  } catch {
    throw new UnsafeSupabaseTargetError(
      `Refusing to mint a test session: SUPABASE_URL ("${input.supabaseUrl}") is not a valid URL.`,
    );
  }

  const host = url.hostname.toLowerCase();
  const port = url.port || null;

  // (3) Loopback is always a sanctioned test target.
  if (LOOPBACK_HOSTS.has(host)) {
    return { host, port, reason: 'loopback' };
  }

  // (4) DEFAULT DENY: any non-loopback host must be explicitly allowlisted.
  const allow = parseAllowlist(input.allowedHostsEnv);
  const hostPort = port ? `${host}:${port}` : host;
  if (allow.has(host) || allow.has(hostPort)) {
    return { host, port, reason: 'allowlisted' };
  }

  throw new UnsafeSupabaseTargetError(
    `Refusing to run E2E session injection against non-test Supabase target "${hostPort}". ` +
      'This is a default-deny safety gate (lib/testing/supabase-guard.ts): only loopback hosts ' +
      '(127.0.0.1 / localhost) are permitted by default. To use a dedicated, throwaway REMOTE test ' +
      'project, add its host to E2E_ALLOWED_SUPABASE_HOSTS (e.g. E2E_ALLOWED_SUPABASE_HOSTS="ref.supabase.co"). ' +
      'A production project can never match without deliberately allowlisting it AND running with a ' +
      'non-production NEXT_PUBLIC_APP_ENV.',
  );
}
