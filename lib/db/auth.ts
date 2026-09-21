// lib/db/auth.ts — G-T6-1: Supabase Auth + Google OAuth (TSD §3A.1 FR-18; <L3>).
//
// ⚠ STATUS — REWRITTEN 2026-09-12, BECAUSE THE PREVIOUS VERSION WAS FALSE AND LOAD-BEARING.
//
// This header used to read: "code scaffold only, not yet verified end-to-end. Google login can't
// round-trip until (a) a live Supabase project has the Google provider configured with a real
// client ID/secret (D-4, vault slug kids-fun-google-oauth — currently a placeholder, no value)
// and (b) SUPABASE_URL/SUPABASE_ANON_KEY are wired". Every part of that was out of date, and it
// was one of three disagreeing status claims in the repo (docs/credentials.md said the same
// thing; app/auth/callback/route.ts said the opposite and was right).
//
// CHECKED AGAINST REALITY on 2026-09-12 rather than resolved by picking the newest-sounding one:
//   · vault slug kids-fun-google-oauth holds a real client id/secret, not a placeholder;
//   · so do kids-fun-supabase-prod and kids-fun-supabase-staging;
//   · Supabase prod's /auth/v1/authorize?provider=google 302s to accounts.google.com with a real
//     client_id — the provider is genuinely configured;
//   · https://kidsfunapp.ca/auth/signin 307'd into that flow on the live production domain.
// Production has been live since Round 28 (2026-07-21) — see docs/infra.md, which was correct
// throughout while these two files were not.
//
// ACTUAL STATUS NOW: fully wired, and DELIBERATELY GATED OFF at the route layer
// (lib/auth/google-signin-gate.ts) per Jon's 2026-09-12 decision — "nobody can sign in with
// google." The helpers below still work; nothing calls them while the gate is closed.
//
// The one true thing in the old text: no user has ever completed a round-trip. `auth.users` had
// 0 rows when measured on 2026-09-12. That is a fact about ADOPTION, not about whether the
// plumbing works — and it was being read as the latter, which is how "there are no credentials"
// survived this long. Do not restore the old wording on the strength of that row count.
//
// Reuses the THE WIP OAuth pattern (@supabase/ssr createServerClient) per TSD §7.5.
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export interface CookieAdapter {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  remove(name: string, options: CookieOptions): void;
}

export interface SupabaseServerClientOptions {
  /**
   * Force `Secure` on the auth cookies. Callers that have a request should pass
   * `protocol === 'https:'` from it; omit it and {@link defaultSecureCookies} decides, which is
   * what the callers with no request in hand (a token refresh inside getRequestUser, /api/me)
   * rely on.
   */
  secure?: boolean;
}

/** Supabase's PKCE verifier cookie — excluded from the hardening below. */
const PKCE_VERIFIER_SUFFIX = '-code-verifier';

/**
 * Whether auth cookies should carry `Secure` when the caller did not say.
 *
 * Uses the app's own canonical origin, because "is this deployment served over https" is exactly
 * what that value already encodes; falls back to NODE_ENV when it is unset or unparseable.
 *
 * ── THIS IS A BUILD-TIME VALUE, NOT A RUNTIME READ ──────────────────────────────────────
 * It LOOKS like it reads the environment on every call. It does not. Next inlines every
 * `process.env.NEXT_PUBLIC_*` reference at BUILD time (webpack DefinePlugin), so what ships is
 * the literal string that was set when the app was last built — verified by finding the baked
 * literal in the compiled .next/server route bundles, with no surviving runtime lookup of the
 * variable in any executed file. NODE_ENV is inlined the same way, so this function is
 * effectively a per-deployment constant.
 *
 * The operational consequence, which is the only reason this matters: changing
 * NEXT_PUBLIC_SITE_URL in the hosting dashboard does NOT change cookie behaviour until the app
 * is REBUILT. Production is correct either way — Vercel sets the value at build time, and the
 * NODE_ENV fallback independently resolves true there — and the admin sign-in routes never
 * depend on this at all, since they pass `secure` explicitly from the request's own protocol.
 *
 * Deliberately does NOT reuse lib/{email,sms}/config.ts's `siteUrl()`: those throw on a
 * misconfigured value, and a cookie write must never be the thing that takes a request down. A
 * wrong answer here degrades to a cookie without `Secure` on http (correct for local dev) —
 * never to an exception.
 */
function defaultSecureCookies(): boolean {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl) {
    try {
      return new URL(siteUrl).protocol === 'https:';
    } catch {
      /* unparseable — fall through to the NODE_ENV answer */
    }
  }
  return process.env.NODE_ENV === 'production';
}

/** The attributes this module forces onto an auth cookie, by name. */
function hardenedAttributes(name: string, secure: boolean): { httpOnly: true; secure: boolean } | Record<string, never> {
  // The PKCE verifier stays under the library's own management: it is short-lived flow state,
  // not the credential that grants access, and Supabase owns its lifecycle.
  if (name.endsWith(PKCE_VERIFIER_SUFFIX)) return {};
  return { httpOnly: true, secure };
}

/**
 * Wrap a {@link CookieAdapter} so every auth cookie written through it is `HttpOnly` and
 * (on https) `Secure`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 * @supabase/ssr's DEFAULT_COOKIE_OPTIONS is `{ path, sameSite: 'lax', httpOnly: false,
 * maxAge: 400d }` — no `Secure`, and `httpOnly: false` so the session is readable by
 * `document.cookie`. That default is there for apps whose browser clients read the session in
 * JS. This app has none: every @supabase/supabase-js caller here is server-side
 * (lib/db/auth-admin.ts, lib/email/recipients.ts, lib/testing/*), and there is no
 * createBrowserClient anywhere. So the default is pure downside — it leaves the session
 * readable by any injected script, and sendable over plaintext http.
 *
 * ── WHY IT IS HERE AND NOT IN ONE ROUTE ─────────────────────────────────────────────────
 * It was first done in the admin sign-in's own adapter, which hardened the cookie AS ISSUED
 * but not afterwards: the session is later rewritten by whichever adapter happens to handle a
 * token REFRESH (lib/db/session-user.ts's read-only adapter, /api/me, session-revoke), and
 * those would have restored the library defaults — so the protection lasted until the first
 * refresh and then silently reverted. Centralising it here is the only version of this control
 * that actually holds: every path that writes a Supabase auth cookie goes through
 * {@link createSupabaseServerClient}, so there is one definition of the rule and no way to
 * acquire a downgraded cookie by taking a different route through the app.
 */
export function hardenCookieAdapter(
  cookies: CookieAdapter,
  options: SupabaseServerClientOptions = {},
): CookieAdapter {
  const secure = options.secure ?? defaultSecureCookies();
  return {
    get: (name) => cookies.get(name),
    // Hardening is spread LAST so it wins over whatever the library asked for.
    set: (name, value, cookieOptions) =>
      cookies.set(name, value, { ...cookieOptions, ...hardenedAttributes(name, secure) }),
    // Untouched: expiry is matched on name/path/domain, so adding attributes here would change
    // nothing except the chance of a mismatch with how the cookie was originally written.
    remove: (name, cookieOptions) => cookies.remove(name, cookieOptions),
  };
}

/**
 * Server-side Supabase client bound to the current request's cookies.
 *
 * Auth cookies written through this client are hardened — see {@link hardenCookieAdapter}.
 */
export function createSupabaseServerClient(cookies: CookieAdapter, options: SupabaseServerClientOptions = {}) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
  }

  const hardened = hardenCookieAdapter(cookies, options);

  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return hardened.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        hardened.set(name, value, options);
      },
      remove(name: string, options: CookieOptions) {
        hardened.remove(name, options);
      },
    },
  });
}

/** Builds the Google OAuth sign-in URL for the browser to redirect to. */
export function googleSignInUrl(redirectTo: string): { provider: 'google'; options: { redirectTo: string } } {
  return { provider: 'google', options: { redirectTo } };
}
