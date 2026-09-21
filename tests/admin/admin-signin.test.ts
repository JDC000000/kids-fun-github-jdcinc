// tests/admin/admin-signin.test.ts — the ADMIN-ONLY Google sign-in
// (app/admin/auth/signin + app/admin/auth/callback).
//
// Two things need proving here, and a code read proves neither:
//
//  1. THE PUBLIC RULING IS UNAFFECTED. Jon's "nobody signs in with Google" is enforced by
//     lib/auth/google-signin-gate.ts. The admin routes must be a genuinely separate path —
//     so these tests assert the admin flow works WHILE GOOGLE_SIGN_IN_ENABLED is false and
//     the public routes are still 404, in the same run. That is a structural claim (the
//     constant is not reachable from the new module graph), not a promise that a file was
//     not edited.
//
//  2. IT IS NOT A BACKDOOR. The callback mints a real Supabase session before it can know
//     who the user is. Every non-admin outcome — a stranger, a revoked admin, or a database
//     that cannot answer — must leave the browser holding NOTHING. These tests assert on the
//     cookie jar after the response, because "we called signOut()" is not the same statement
//     as "no session cookie survived".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotAdminError } from '@/lib/db/admin-guard';
import type { CookieAdapter } from '@/lib/db/auth';
import { GOOGLE_SIGN_IN_ENABLED } from '@/lib/auth/google-signin-gate';

// ── Test doubles ────────────────────────────────────────────────────────────────────────
// A cookie jar with the shape next/headers' cookies() exposes in a route handler.
interface JarEntry {
  name: string;
  value: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

function createCookieJar(initial: Record<string, string> = {}) {
  const jar = new Map<string, JarEntry>();
  for (const [name, value] of Object.entries(initial)) jar.set(name, { name, value });
  return {
    jar,
    get: (name: string) => jar.get(name),
    getAll: () => [...jar.values()],
    // Keeps the WHOLE option bag, not just maxAge: the httpOnly/secure assertions below are
    // about attributes the browser enforces, so the test has to see what was actually set.
    set: (entry: { name: string; value: string; maxAge?: number; httpOnly?: boolean; secure?: boolean }) => {
      jar.set(entry.name, { ...entry });
    },
  };
}

type Jar = ReturnType<typeof createCookieJar>;

const SESSION_COOKIE = 'sb-testproj-auth-token';
const VERIFIER_COOKIE = 'sb-testproj-auth-token-code-verifier';

const mocks = vi.hoisted(() => ({
  cookieStore: null as unknown,
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  signOut: vi.fn(),
  requireAdmin: vi.fn(),
  createClientThrows: null as Error | null,
  /**
   * The cookie adapter the route handed to createSupabaseServerClient — stored AFTER the real
   * hardenCookieAdapter has wrapped it, so writes made through it behave exactly as in
   * production. Typed as the real CookieAdapter so the wrapper's contract is type-checked here
   * too, not just at runtime.
   */
  adapter: null as null | CookieAdapter,
}));

vi.mock('next/headers', () => ({ cookies: () => mocks.cookieStore }));

// Only the NETWORK side of the Supabase client is faked. The cookie adapter is still wrapped by
// the REAL hardenCookieAdapter, exactly as createSupabaseServerClient does in production — so the
// httpOnly/secure assertions below exercise the shipping control rather than a mock that quietly
// skips it. (A mock that dropped the wrapper would have kept passing after the hardening moved to
// lib/db/auth.ts, which is precisely the failure this avoids.)
vi.mock('@/lib/db/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/auth')>();
  return {
    ...actual,
    createSupabaseServerClient: (adapter: CookieAdapter, options?: { secure?: boolean }) => {
      if (mocks.createClientThrows) throw mocks.createClientThrows;
      mocks.adapter = actual.hardenCookieAdapter(adapter, options);
      return {
        auth: {
          signInWithOAuth: mocks.signInWithOAuth,
          exchangeCodeForSession: mocks.exchangeCodeForSession,
          signOut: mocks.signOut,
        },
      };
    },
  };
});

vi.mock('@/lib/db/admin-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/admin-guard')>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});

// Imported AFTER the mocks (vi.mock is hoisted, so these bind the stubs).
import { GET as adminSigninGET } from '@/app/admin/auth/signin/route';
import { GET as adminCallbackGET } from '@/app/admin/auth/callback/route';
import { GET as publicSigninGET } from '@/app/auth/signin/route';
import { GET as publicCallbackGET } from '@/app/auth/callback/route';
import { sanitizeAdminNext, ADMIN_DEFAULT_LANDING } from '@/app/admin/auth/_lib/admin-session';

const ADMIN_USER = { id: 'admin-uuid-0001', email: 'jon@example.com' };

/**
 * Simulate what @supabase/ssr does on a successful exchange: write the session cookies with
 * ITS OWN DEFAULT_COOKIE_OPTIONS — `httpOnly: false`, no `secure`. Passing the real defaults
 * (rather than a bare `{ path }`) is the point: it is what makes the hardening assertions
 * meaningful, since they have to beat these values, not merely fill in a gap.
 */
function writeSessionCookies(): void {
  mocks.adapter?.set(SESSION_COOKIE, 'a-real-looking-session', {
    path: '/',
    sameSite: 'lax' as const,
    httpOnly: false,
    maxAge: 400 * 24 * 60 * 60,
  });
}

function jarValue(jar: Jar, name: string): string | undefined {
  return jar.jar.get(name)?.value;
}

/** A cookie is only gone if it is both emptied and expired. */
function isCleared(jar: Jar, name: string): boolean {
  const entry = jar.jar.get(name);
  return entry !== undefined && entry.value === '' && entry.maxAge === 0;
}

let jar: Jar;

beforeEach(() => {
  jar = createCookieJar({ [VERIFIER_COOKIE]: 'pkce-verifier-from-the-signin-hop' });
  mocks.cookieStore = jar;
  mocks.adapter = null;
  mocks.createClientThrows = null;
  mocks.signInWithOAuth.mockReset();
  mocks.exchangeCodeForSession.mockReset();
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.requireAdmin.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('structural separation from the public Google sign-in', () => {
  it('neither admin auth module imports the public gate — the constant is not in their graph', () => {
    const files = [
      'app/admin/auth/signin/route.ts',
      'app/admin/auth/callback/route.ts',
      'app/admin/auth/_lib/admin-session.ts',
    ];
    for (const file of files) {
      const source = readFileSync(resolve(file), 'utf8');
      // Prose mentions of the decision are expected and welcome; an IMPORT is what would make
      // the public kill-switch load-bearing for admin access. Only the latter is forbidden.
      const importsGate = /^\s*import[^\n]*google-signin-gate/m.test(source);
      expect(importsGate, `${file} must not import the public sign-in gate`).toBe(false);
    }
  });

  it('admin sign-in starts a real OAuth flow WHILE the public gate is closed, in the same run', async () => {
    expect(GOOGLE_SIGN_IN_ENABLED).toBe(false); // the public ruling, still in force

    mocks.signInWithOAuth.mockResolvedValue({ data: { url: 'https://supabase.example/authorize?provider=google' }, error: null });
    const res = await adminSigninGET(new Request('https://kidsfun.example/admin/auth/signin'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://supabase.example/authorize?provider=google');
  });

  it('leaves the public routes 404 — this change grants no public sign-in', async () => {
    const signin = await publicSigninGET(new Request('https://kidsfun.example/auth/signin'));
    const callback = await publicCallbackGET(new Request('https://kidsfun.example/auth/callback?code=abc'));
    expect(signin.status).toBe(404);
    expect(callback.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('sanitizeAdminNext — the admin entry point can only ever land inside /admin', () => {
  it('keeps an admin-scoped path', () => {
    expect(sanitizeAdminNext('/admin/sources')).toBe('/admin/sources');
    expect(sanitizeAdminNext('/admin/listings/new?draft=1')).toBe('/admin/listings/new?draft=1');
  });

  it('still keeps a legitimately percent-encoded admin path — the N1 fix is not a blanket ban on %', () => {
    // The decoded-form checks must reject encoded ATTACKS without rejecting encoded DATA; a
    // search term with an escaped space is ordinary admin-console usage.
    expect(sanitizeAdminNext('/admin/listings?q=a%20b')).toBe('/admin/listings?q=a%20b');
    expect(sanitizeAdminNext('/admin/sources?name=Parks%20%26%20Rec')).toBe('/admin/sources?name=Parks%20%26%20Rec');
  });

  it.each([
    ['null (no next given)', null],
    ['empty', ''],
    ['a public page', '/account'],
    ['the site root', '/'],
    ['an absolute URL', 'https://evil.example/steal'],
    ['protocol-relative', '//evil.example/steal'],
    ['a backslash host trick', '/admin/\\evil.example'],
    ['traversal out of /admin', '/admin/../account'],
    ['encoded traversal', '/admin/%2e%2e/account'],
    ['a prefix lookalike', '/administrator/evil'],
    ['the sign-in route itself (loop)', '/admin/auth/signin'],
    ['the callback route itself (loop)', '/admin/auth/callback?code=x'],
    // QA N1: these two only reveal their shape after decoding, and BOTH survived the pre-fix
    // guards (verified by running the old predicate against them). The encoded-traversal case
    // above is deliberately not repeated here — isHostile already caught it before this fix.
    ['the sign-in route, percent-encoded', '/admin/%61uth/signin'],
    ['the callback route, percent-encoded', '/admin/%61uth/callback?code=x'],
    ['malformed encoding', '/admin/%E0%A4%A'],
  ])('collapses %s to the default landing page', (_label, value) => {
    expect(sanitizeAdminNext(value)).toBe(ADMIN_DEFAULT_LANDING);
  });

  it('rejects a control character (redirect smuggling)', () => {
    expect(sanitizeAdminNext(`/admin/dashboard${String.fromCharCode(10)}Set-Cookie: x=1`)).toBe(ADMIN_DEFAULT_LANDING);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('GET /admin/auth/signin', () => {
  it('sends the provider back to the ADMIN callback on the same origin, carrying the clamped next', async () => {
    mocks.signInWithOAuth.mockResolvedValue({ data: { url: 'https://supabase.example/authorize' }, error: null });

    await adminSigninGET(new Request('https://kidsfun.example/admin/auth/signin?next=%2Fadmin%2Fsources'));

    const options = mocks.signInWithOAuth.mock.calls[0][0];
    expect(options.provider).toBe('google');
    expect(options.options.redirectTo).toBe('https://kidsfun.example/admin/auth/callback?next=%2Fadmin%2Fsources');
    // Never the public callback — that one is gated and must stay unreachable from here.
    expect(new URL(options.options.redirectTo).pathname).toBe('/admin/auth/callback');
  });

  it('clamps a hostile next before it ever reaches the provider', async () => {
    mocks.signInWithOAuth.mockResolvedValue({ data: { url: 'https://supabase.example/authorize' }, error: null });

    await adminSigninGET(new Request('https://kidsfun.example/admin/auth/signin?next=https%3A%2F%2Fevil.example'));

    const { redirectTo } = mocks.signInWithOAuth.mock.calls[0][0].options;
    expect(redirectTo).toBe(`https://kidsfun.example/admin/auth/callback?next=${encodeURIComponent(ADMIN_DEFAULT_LANDING)}`);
  });

  it('reports a provider error instead of bouncing an operator to the consumer home page', async () => {
    mocks.signInWithOAuth.mockResolvedValue({ data: null, error: { message: 'provider disabled' } });
    const res = await adminSigninGET(new Request('https://kidsfun.example/admin/auth/signin'));
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    await expect(res.text()).resolves.toContain('provider disabled');
  });

  it('names the missing configuration instead of a bare 500', async () => {
    mocks.createClientThrows = new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
    const res = await adminSigninGET(new Request('https://kidsfun.example/admin/auth/signin'));
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toContain('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('session cookie hardening — @supabase/ssr defaults are not inherited', () => {
  // @supabase/ssr's DEFAULT_COOKIE_OPTIONS ships `httpOnly: false` and no `Secure`, because the
  // library supports browser clients that read the session from document.cookie. This app has no
  // such client, and this route is the first live path in production that issues a real session
  // cookie at all — an ADMIN one. So the defaults are overridden rather than inherited.
  it('forces httpOnly on the session cookie, overriding the library default of false', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockResolvedValue({ userId: ADMIN_USER.id, role: 'superadmin' });

    await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));

    expect(jar.jar.get(SESSION_COOKIE)?.httpOnly).toBe(true);
  });

  it('marks the session cookie Secure over https, and not over plain http (local dev still works)', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockResolvedValue({ userId: ADMIN_USER.id, role: 'superadmin' });

    await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));
    expect(jar.jar.get(SESSION_COOKIE)?.secure).toBe(true);

    jar = createCookieJar();
    mocks.cookieStore = jar;
    await adminCallbackGET(new Request('http://127.0.0.1:3000/admin/auth/callback?code=good'));
    expect(jar.jar.get(SESSION_COOKIE)?.secure).toBe(false);
  });

  it('leaves the PKCE verifier under the library\'s own management', async () => {
    // Deliberately NOT hardened: it is Supabase's short-lived flow state, and this change is
    // scoped to the credential that actually grants access.
    mocks.signInWithOAuth.mockImplementation(async () => {
      mocks.adapter?.set(VERIFIER_COOKIE, 'a-verifier', { path: '/', httpOnly: false });
      return { data: { url: 'https://supabase.example/authorize' }, error: null };
    });

    await adminSigninGET(new Request('https://kidsfun.example/admin/auth/signin'));

    expect(jar.jar.get(VERIFIER_COOKIE)?.httpOnly).toBe(false);
  });

  it('still fully clears a hardened session cookie on the deny path', async () => {
    // Regression guard: the extra attributes must not stop discardSession from expiring it.
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());

    await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));

    expect(isCleared(jar, SESSION_COOKIE)).toBe(true);
  });
});

describe('GET /admin/auth/callback — an active admin', () => {
  it('keeps the session and lands inside the console', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER }, user: ADMIN_USER }, error: null };
    });
    mocks.requireAdmin.mockResolvedValue({ userId: ADMIN_USER.id, role: 'superadmin' });

    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`https://kidsfun.example${ADMIN_DEFAULT_LANDING}`);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(jarValue(jar, SESSION_COOKIE)).toBe('a-real-looking-session'); // session survives
  });

  it('honours an admin-scoped next, and only an admin-scoped one', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockResolvedValue({ userId: ADMIN_USER.id, role: 'admin' });

    const kept = await adminCallbackGET(
      new Request('https://kidsfun.example/admin/auth/callback?code=good&next=%2Fadmin%2Fqa-queue'),
    );
    expect(kept.headers.get('location')).toBe('https://kidsfun.example/admin/qa-queue');

    const clamped = await adminCallbackGET(
      new Request('https://kidsfun.example/admin/auth/callback?code=good&next=%2Faccount'),
    );
    expect(clamped.headers.get('location')).toBe(`https://kidsfun.example${ADMIN_DEFAULT_LANDING}`);
  });
});

describe('GET /admin/auth/callback — everyone who is not an active admin', () => {
  it('revokes the just-minted session and leaves no auth cookie behind', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());

    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull(); // no bounce into the console
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    // The actual guarantee: nothing usable is left in the browser.
    expect(isCleared(jar, SESSION_COOKIE)).toBe(true);
    expect(isCleared(jar, VERIFIER_COOKIE)).toBe(true);
  });

  it('hands back the user id the operator needs to seed, and says the session was revoked', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());

    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));
    const body = await res.text();

    expect(body).toContain(ADMIN_USER.id);
    expect(body).toContain(ADMIN_USER.email);
    expect(body).toMatch(/revoked/i);
  });

  it('denies (not grants) when admin status cannot be VERIFIED — fail-closed on a DB error', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));

    expect(res.status).toBe(403);
    expect(isCleared(jar, SESSION_COOKIE)).toBe(true);
    await expect(res.text()).resolves.toMatch(/could not verify/i);
    // The DB error is logged for observability but never shown to the caller.
    expect(warn).toHaveBeenCalled();
    await expect(
      adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good')).then((r) => r.text()),
    ).resolves.not.toContain('connection terminated');
    warn.mockRestore();
  });

  it('still clears cookies when the revocation call itself fails', async () => {
    mocks.exchangeCodeForSession.mockImplementation(async () => {
      writeSessionCookies();
      return { data: { session: { user: ADMIN_USER } }, error: null };
    });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());
    mocks.signOut.mockRejectedValue(new Error('supabase unreachable'));

    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));

    expect(res.status).toBe(403);
    expect(isCleared(jar, SESSION_COOKIE)).toBe(true);
  });
});

describe('GET /admin/auth/callback — malformed hops', () => {
  it('never consults the admin table when there is no code to exchange', async () => {
    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback'));

    expect(res.status).toBe(400);
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    // A verifier left over from an abandoned attempt is cleaned up rather than left to rot.
    expect(isCleared(jar, VERIFIER_COOKIE)).toBe(true);
  });

  it('clears up after a failed exchange', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ data: null, error: { message: 'invalid flow state' } });

    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=stale'));

    expect(res.status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(isCleared(jar, VERIFIER_COOKIE)).toBe(true);
    await expect(res.text()).resolves.toContain('invalid flow state');
  });

  it('names the missing configuration instead of a bare 500', async () => {
    mocks.createClientThrows = new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
    const res = await adminCallbackGET(new Request('https://kidsfun.example/admin/auth/callback?code=good'));
    expect(res.status).toBe(503);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });
});
