// lib/testing/test-session.ts — mint a REAL Supabase Auth session for the dedicated
// E2E test user and serialize it into cookies that Playwright can inject.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN (both named safety requirements live here — see the two helpers below)
// ─────────────────────────────────────────────────────────────────────────────
// (A) NO app-level auth bypass. We do NOT add any special header/query-param that
//     makes the app skip real auth — that would be a backdoor exploitable outside
//     tests. Instead we reuse the SAME service-role admin capability the app
//     already ships for account operations (lib/db/auth-admin.ts's pattern:
//     createClient(url, SERVICE_ROLE_KEY, { auth: { persistSession:false } }) then
//     `admin.auth.admin.*`) to provision a genuine test user, then obtain a REAL
//     GoTrue session (a normal password grant) and hand its tokens to
//     @supabase/ssr to serialize into the exact cookies the app reads. The app's
//     auth code is exercised unchanged — it validates the session for real.
//
// (B) Categorically non-production. createTestUserSession() calls the default-deny
//     supabase-guard FIRST; it throws unless SUPABASE_URL is a loopback/allowlisted
//     TEST target and the app env is non-production. The service-role admin API is
//     never touched until the gate has passed.
//
// (C) Auditable test user. The user is created on the reserved `.test` domain and
//     stamped with a persisted app_metadata/user_metadata marker (see
//     lib/testing/test-user.ts). We refuse to operate on any non-test email.
//
// Under lib/testing/** — NEVER imported by app/**, worker/**, or production code.
import { createClient, type SupabaseClient, type Session, type User } from '@supabase/supabase-js';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { assertTestOnlySupabaseTarget, type SupabaseGuardResult } from './supabase-guard';
import {
  DEFAULT_TEST_USER,
  E2E_TEST_USER_MARKER,
  E2E_TEST_USER_PASSWORD,
  isE2ETestEmail,
} from './test-user';

/** Playwright-compatible cookie shape (matches @playwright/test's Cookie / storageState). */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // unix seconds; -1 = session cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** Playwright storageState shape. */
export interface StorageState {
  cookies: PlaywrightCookie[];
  origins: never[];
}

export interface MintedTestSession {
  user: Pick<User, 'id' | 'email'> & { app_metadata: Record<string, unknown> };
  session: Session;
  email: string;
  /** Which sanctioned target the session was minted against (for audit logging). */
  guard: SupabaseGuardResult;
}

interface EnvConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  appEnv: string | undefined;
  allowedHostsEnv: string | undefined;
}

function readEnv(): EnvConfig {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // The guard re-checks the URL, but surface a clear message if keys are missing.
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY is not set — required to mint a test session.');
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — required for the service-role admin API.');
  }
  return {
    url: url ?? '',
    anonKey,
    serviceRoleKey,
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    allowedHostsEnv: process.env.E2E_ALLOWED_SUPABASE_HOSTS,
  };
}

/** Find an existing auth user by email (paginated). Returns null if none. */
async function findUserByEmail(admin: SupabaseClient, email: string): Promise<User | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

/**
 * Ensure the dedicated, clearly-flagged test user exists via the SERVICE-ROLE admin
 * API, stamped with the audit marker. Idempotent: a returning run refreshes the
 * marker/password so the account stays consistent and re-signable.
 */
async function ensureTestUser(admin: SupabaseClient, email: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: E2E_TEST_USER_PASSWORD,
    email_confirm: true,
    app_metadata: { ...E2E_TEST_USER_MARKER },
    user_metadata: { ...E2E_TEST_USER_MARKER },
  });

  if (!error && data.user) return data.user;

  // Already registered (or a create race) → locate and normalise it.
  const existing = await findUserByEmail(admin, email);
  if (!existing) {
    throw error ?? new Error(`Could not create or locate the E2E test user (${email}).`);
  }
  const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(existing.id, {
    password: E2E_TEST_USER_PASSWORD,
    email_confirm: true,
    app_metadata: { ...E2E_TEST_USER_MARKER },
    user_metadata: { ...E2E_TEST_USER_MARKER },
  });
  if (updateError) throw updateError;
  return updated.user;
}

/**
 * Mint a REAL Supabase Auth session for the dedicated E2E test user.
 *
 * Order of operations is load-bearing for safety:
 *   1. assertTestOnlySupabaseTarget()  — throws before ANY privileged call if the
 *      target is not a sanctioned test Supabase (default-deny).
 *   2. enforce the reserved test-email domain.
 *   3. service-role admin: ensure the flagged, marker-stamped test user exists.
 *   4. normal password grant: obtain a genuine GoTrue session (access + refresh).
 */
export async function createTestUserSession(
  opts: { email?: string } = {},
): Promise<MintedTestSession> {
  const env = readEnv();

  // (1) SAFETY GATE — must pass before the service-role key is ever used.
  const guard = assertTestOnlySupabaseTarget({
    supabaseUrl: env.url,
    appEnv: env.appEnv,
    allowedHostsEnv: env.allowedHostsEnv,
  });

  const email = opts.email ?? DEFAULT_TEST_USER.email;

  // (2) Never operate on a non-test identity.
  if (!isE2ETestEmail(email)) {
    throw new Error(
      `Refusing to mint a session for "${email}": only reserved E2E test emails ` +
        `(@e2e.kids-fun.test) are permitted by the harness.`,
    );
  }

  // (3) Reuse the service-role admin capability (lib/db/auth-admin.ts pattern).
  const admin = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const user = await ensureTestUser(admin, email);

  // (4) A REAL session via a normal password grant against GoTrue. No app bypass.
  const authClient = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password: E2E_TEST_USER_PASSWORD,
  });
  if (error || !data.session) {
    throw error ?? new Error('Password grant returned no session for the E2E test user.');
  }

  return {
    user: { id: user.id, email: user.email ?? email, app_metadata: user.app_metadata ?? {} },
    session: data.session,
    email,
    guard,
  };
}

function mapSameSite(v: CookieOptions['sameSite']): 'Strict' | 'Lax' | 'None' {
  if (v === true || v === 'strict') return 'Strict';
  if (v === 'none') return 'None';
  return 'Lax';
}

/**
 * Serialize a session into Playwright storageState cookies using @supabase/ssr's
 * OWN cookie writer (the same createServerClient(url, anonKey, {cookies}) the app
 * uses in lib/db/auth.ts). Because the serializer and the app's reader are the
 * same library + same URL, the cookie name(s), chunking, and encoding match
 * exactly — no hand-rolled cookie format to drift from the app.
 */
export async function sessionToStorageState(session: Session, baseUrl: string): Promise<StorageState> {
  const url = process.env.SUPABASE_URL ?? '';
  const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
  const captured = new Map<string, { value: string; options: CookieOptions }>();

  const client = createServerClient(url, anonKey, {
    cookies: {
      get() {
        return undefined;
      },
      set(name: string, value: string, options: CookieOptions) {
        captured.set(name, { value, options });
      },
      remove(name: string) {
        captured.delete(name);
      },
    },
  });

  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw error;

  const target = new URL(baseUrl);
  const secure = target.protocol === 'https:';
  const nowSec = Math.floor(Date.now() / 1000);

  const cookies: PlaywrightCookie[] = [];
  for (const [name, { value, options }] of captured) {
    const maxAge = typeof options.maxAge === 'number' ? options.maxAge : undefined;
    cookies.push({
      name,
      value,
      domain: target.hostname,
      path: options.path ?? '/',
      expires: maxAge != null ? nowSec + maxAge : -1,
      httpOnly: options.httpOnly ?? false,
      // Force non-secure on http loopback so the browser actually sends the cookie.
      secure,
      sameSite: mapSameSite(options.sameSite),
    });
  }

  return { cookies, origins: [] };
}
