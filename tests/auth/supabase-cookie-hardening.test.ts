// tests/auth/supabase-cookie-hardening.test.ts — lib/db/auth.ts hardenCookieAdapter.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT IN THE ADMIN SUITE. The hardening started life inside
// the admin sign-in's own adapter, where it protected the session AS ISSUED and nothing more: the
// session cookie is rewritten later by whichever adapter handles a token REFRESH
// (lib/db/session-user.ts, /api/me, session-revoke), and those restored @supabase/ssr's defaults —
// `httpOnly: false`, no `Secure`. So the control reverted on the first refresh, which is the same
// as not having it. It now lives in the shared client factory, and these tests are about that
// shared guarantee: EVERY adapter that goes through createSupabaseServerClient is hardened,
// whatever route it belongs to.
//
// The assertions are on the options actually handed to the underlying adapter, because the whole
// control is "which attributes reach the browser" — a test that only checked a function was
// called would prove nothing about that.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hardenCookieAdapter, type CookieAdapter } from '@/lib/db/auth';

const SESSION_COOKIE = 'sb-projectref-auth-token';
const SESSION_CHUNK = 'sb-projectref-auth-token.0';
const VERIFIER_COOKIE = 'sb-projectref-auth-token-code-verifier';

/** @supabase/ssr's real DEFAULT_COOKIE_OPTIONS — what the library asks for, unprompted. */
const LIBRARY_DEFAULTS = {
  path: '/',
  sameSite: 'lax' as const,
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60,
};

function spyAdapter() {
  const set = vi.fn();
  const remove = vi.fn();
  const get = vi.fn((name: string) => ({ value: `value-of-${name}` }));
  const adapter: CookieAdapter = { get, set, remove };
  return { adapter, set, remove, get };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hardenCookieAdapter — session cookies', () => {
  it('forces httpOnly, overriding the library default of false', () => {
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: true }).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set).toHaveBeenCalledWith(SESSION_COOKIE, 'token', expect.objectContaining({ httpOnly: true }));
  });

  it('adds Secure, which the library never sets at all', () => {
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: true }).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it('keeps the library options it is not overriding (path, sameSite, maxAge)', () => {
    // Hardening must ADD attributes, not replace the bag — dropping maxAge would silently turn
    // the session into a browser-session cookie.
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: true }).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({
      path: '/',
      sameSite: 'lax',
      maxAge: LIBRARY_DEFAULTS.maxAge,
    });
  });

  it('hardens every chunk of a split session, not just the unsuffixed name', () => {
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: true }).set(SESSION_CHUNK, 'chunk', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: true });
  });

  it('omits Secure over plain http so local development still works', () => {
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: false }).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: false });
  });
});

describe('hardenCookieAdapter — the PKCE verifier is deliberately left alone', () => {
  it('does not harden the verifier cookie', () => {
    // Short-lived flow state owned by Supabase, not the credential that grants access.
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: true }).set(VERIFIER_COOKIE, 'verifier', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: false });
    expect(set.mock.calls[0][2]).not.toHaveProperty('secure');
  });
});

describe('hardenCookieAdapter — pass-throughs', () => {
  it('reads through untouched', () => {
    const { adapter, get } = spyAdapter();
    expect(hardenCookieAdapter(adapter, { secure: true }).get(SESSION_COOKIE)).toEqual({
      value: `value-of-${SESSION_COOKIE}`,
    });
    expect(get).toHaveBeenCalledWith(SESSION_COOKIE);
  });

  it('removes through untouched — expiry matches on name/path, not on attributes', () => {
    const { adapter, remove } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: true }).remove(SESSION_COOKIE, { path: '/' });

    expect(remove).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/' });
  });
});

describe('hardenCookieAdapter — the default when no caller said', () => {
  // This is the case that actually protects a REFRESH: lib/db/session-user.ts and /api/me build
  // their adapters with no request protocol in hand, so the default is what they get.
  it('derives Secure from the app\'s own canonical origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: true });
  });

  it('is not Secure when that origin is http (local/dev)', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1:3000');
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: false });
  });

  it('falls back to NODE_ENV when the origin is unset or unparseable, and never throws', () => {
    for (const siteUrl of ['', 'not a url']) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', siteUrl);
      vi.stubEnv('NODE_ENV', 'production');
      const { adapter, set } = spyAdapter();
      expect(() => hardenCookieAdapter(adapter).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS)).not.toThrow();
      expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: true });
    }
  });

  it('still hardens httpOnly even when Secure resolves to false — the two are independent', () => {
    // The XSS mitigation must not be collateral damage of a non-https environment.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    vi.stubEnv('NODE_ENV', 'development');
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: false });
  });

  it('an explicit caller option beats the environment-derived default', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    const { adapter, set } = spyAdapter();
    hardenCookieAdapter(adapter, { secure: false }).set(SESSION_COOKIE, 'token', LIBRARY_DEFAULTS);

    expect(set.mock.calls[0][2]).toMatchObject({ secure: false });
  });
});

describe('hardenCookieAdapter — the refresh path specifically', () => {
  it('hardens a session rewritten through the read-only adapter shape used by getRequestUser', () => {
    // lib/db/session-user.ts wraps its writes in try/catch because a Server Component render
    // cannot mutate cookies. That shape must still come out hardened when the write DOES land
    // (route handlers can write) — this is the exact path that used to downgrade the cookie.
    const written: Array<{ name: string; options: Record<string, unknown> }> = [];
    const sessionUserShaped: CookieAdapter = {
      get: () => undefined,
      set: (name, _value, options) => {
        try {
          written.push({ name, options: options as unknown as Record<string, unknown> });
        } catch {
          /* not writable in this context */
        }
      },
      remove: () => {},
    };

    hardenCookieAdapter(sessionUserShaped, { secure: true }).set(SESSION_COOKIE, 'refreshed', LIBRARY_DEFAULTS);

    expect(written).toHaveLength(1);
    expect(written[0].options).toMatchObject({ httpOnly: true, secure: true });
  });
});
