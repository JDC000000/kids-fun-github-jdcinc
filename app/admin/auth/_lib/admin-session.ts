// app/admin/auth/_lib/admin-session.ts — the shared plumbing behind the ADMIN-ONLY Google
// sign-in (/admin/auth/signin + /admin/auth/callback).
//
// ── WHY THIS EXISTS AT ALL, AND WHY IT IS NOT app/auth/* ────────────────────────────────
// Jon's 2026-09-12 ruling — "nobody signs in with Google, full stop" — is a statement about
// the PUBLIC product, and lib/auth/google-signin-gate.ts makes it true by 404'ing
// /auth/signin and /auth/callback. That ruling is untouched here. What it left behind is a
// separate, unrelated problem: the admin console's real gate (app/admin/_lib/gate.ts) has a
// session path that can never fire, because there is no way for an admin to obtain a
// session — so the only working way into /admin/* is ADMIN_DASHBOARD_TOKEN in the URL, which
// is what Jon is currently blocked on.
//
// This module is the admin-scoped entry point that closes that gap WITHOUT reopening the
// public one. The separation is structural, not a convention:
//   · nothing in this file, or in either route that uses it, imports
//     lib/auth/google-signin-gate.ts — GOOGLE_SIGN_IN_ENABLED is not reachable from this
//     module graph, so its value (false, and staying false) cannot enable or disable
//     anything here, in either direction;
//   · conversely nothing here is imported by app/auth/* or app/account/*, so this code
//     cannot weaken the public gate either. The two subsystems share only
//     lib/db/auth.ts's createSupabaseServerClient — a transport-level Supabase client that
//     has no notion of the gate and is already shared by /api/me, /account and signout.
//
// ── WHAT STOPS THIS BEING A BACKDOOR INTO THE DISABLED PUBLIC FLOW ─────────────────────
// A session minted here is a REAL Supabase session, and it is worth being precise about what
// that buys its holder on the PUBLIC side of the app, because "they'd just be recognised as
// signed in" undersells it. Concretely, as of this change the holder can:
//   · GET /api/me — which does not merely report status: on first call it CREATES their
//     user_profile row via ensureUserProfile() (self-healing provisioning, app/api/me/route.ts);
//   · PATCH /api/me — which WRITES that row: home_postal and email_opt_in, the two fields in
//     profile-validate.ts's EDITABLE_KEYS. (Not saved_child_ages — F-8 / PIPEDA removed it as
//     an editable field and parseProfilePatch now rejects it as unknown.);
//   · use /search's saved-search controls, which read the same session.
// So the exposure is a small authenticated WRITE capability over the holder's OWN profile row
// (RLS-scoped, `auth.uid() = id`), not read-only recognition.
//
// That is acceptable ONLY because app/admin/auth/callback/route.ts REVOKES the session it just
// minted unless the user is an active admin_user row — see {@link AdminAuthClient.discardSession}.
// A non-admin who walks the whole flow ends with zero auth cookies, so none of the above is
// reachable by anyone the operator has not deliberately seeded; for a seeded admin it is inert
// (nobody is going to attack themselves with their own postal code). /account stays 404 for
// everyone regardless: it has its own GOOGLE_SIGN_IN_ENABLED check, which this code neither
// reads nor changes.
//
// If that tradeoff ever stops being acceptable — more than one admin, or admins who are not
// the product owner — the fix is a separately-namespaced admin session cookie plus a matching
// read in app/admin/_lib/gate.ts, NOT another flag on this path.
import type { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/db/auth';

type CookieStore = ReturnType<typeof cookies>;

export const ADMIN_AUTH_SIGNIN_PATH = '/admin/auth/signin';
export const ADMIN_AUTH_CALLBACK_PATH = '/admin/auth/callback';
/** Where a completed admin sign-in lands when no explicit (admin-scoped) `next` was given. */
export const ADMIN_DEFAULT_LANDING = '/admin/dashboard';

/** Supabase's auth cookies are all `sb-`-prefixed (session chunks + the PKCE verifier). */
const SUPABASE_COOKIE_PREFIX = 'sb-';

/** Control characters (NUL..US and DEL) — redirect/header smuggling, never legitimate in a `next` path. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Clamp a `?next=` value to a path INSIDE the admin console.
 *
 * This is what keeps the route from being a general-purpose "sign in and come back to any
 * page" mechanism: the admin entry point can only ever deposit you in /admin/*, never on a
 * public surface and never off-site. Anything else — an absolute URL, a protocol-relative
 * `//evil.example`, a traversal out of /admin, a backslash (which some browsers normalise to
 * `/`), a control character, or /admin/auth/* itself (a sign-in loop) — collapses to
 * {@link ADMIN_DEFAULT_LANDING} rather than erroring, because a bad `next` is not a reason to
 * fail a sign-in that otherwise succeeded.
 */
export function sanitizeAdminNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return ADMIN_DEFAULT_LANDING;

  // Check the decoded form too: a server or browser may normalise `%2e%2e` back to `..`
  // before the path is resolved, so validating only the raw string is not enough.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return ADMIN_DEFAULT_LANDING; // malformed percent-encoding — not worth reasoning about
  }

  const isHostile = (value: string): boolean =>
    value.startsWith('//') || // protocol-relative → a different origin
    value.includes('\\') ||
    value.includes('..') ||
    hasControlCharacters(value);

  if (isHostile(raw) || isHostile(decoded)) return ADMIN_DEFAULT_LANDING;

  // BOTH forms must clear the scope and loop guards (QA finding N1). The hostile-token check
  // above already looked at raw and decoded; these two did not, and a value can hide its shape
  // until it is decoded — `/admin/%61uth/signin` only reveals itself as the sign-in route after
  // decoding, and a proxy or CDN that normalises percent-escapes before Next sees the path would
  // hand us the decoded form in the first place.
  //
  // This was not exploitable as deployed — Next 14 does not normalise %2f, and the redirect is
  // built as `origin + next` where `next` always begins with a literal /admin/, so it cannot
  // leave the origin whatever the encoding. But "safe on today's infrastructure" is a fact about
  // the deployment, not a property of this function, and the guard costs one loop.
  for (const value of [raw, decoded]) {
    if (!value.startsWith('/admin/')) return ADMIN_DEFAULT_LANDING;
    if (value.startsWith(ADMIN_AUTH_SIGNIN_PATH) || value.startsWith(ADMIN_AUTH_CALLBACK_PATH)) {
      return ADMIN_DEFAULT_LANDING; // never land back on the sign-in machinery
    }
  }
  return raw;
}

export interface AdminAuthClient {
  /** Cookie-bound Supabase client for this request (initiation and code exchange). */
  supabase: ReturnType<typeof createSupabaseServerClient>;
  /**
   * Destroy any session this request created, leaving the browser with no auth cookies.
   *
   * Belt AND braces, deliberately: `signOut()` revokes the refresh token server-side and asks
   * the SSR client to clear its own cookies, but it is the library's bookkeeping that decides
   * WHICH cookie names get cleared — and the session may be split across numbered chunks
   * (`sb-<ref>-auth-token.0`, `.1`, …). So afterwards every cookie this request wrote, plus
   * every `sb-`-prefixed cookie that arrived with the request, is explicitly expired. A
   * revoked-but-still-present cookie would be a confusing half-state; "not an admin" must mean
   * the browser leaves holding nothing. Never throws — it runs on the failure path.
   */
  discardSession(): Promise<void>;
}

export interface AdminAuthClientOptions {
  /**
   * Whether this request arrived over HTTPS. Forwarded to createSupabaseServerClient, which
   * uses it to decide `Secure` on the auth cookies — derived from the request rather than
   * hardcoded so local http:// development still works (a `Secure` cookie is simply dropped by
   * the browser over plain http).
   *
   * The COOKIE HARDENING ITSELF LIVES IN lib/db/auth.ts (hardenCookieAdapter), not here. It
   * started in this file, which hardened the session as issued but left a later token refresh —
   * which goes through a different adapter entirely (lib/db/session-user.ts, /api/me) — free to
   * rewrite it with @supabase/ssr's defaults and silently drop httpOnly. Moving it into the
   * shared client factory is what makes the control hold for the life of the session instead of
   * for one request, and leaves exactly one definition of the rule rather than two that can
   * drift apart.
   */
  secure: boolean;
}

/**
 * Build the request-scoped Supabase client used by BOTH admin auth routes, tracking every
 * cookie name it writes so {@link AdminAuthClient.discardSession} can expire exactly those.
 */
export function createAdminAuthClient(
  cookieStore: CookieStore,
  options: AdminAuthClientOptions,
): AdminAuthClient {
  const writtenCookieNames = new Set<string>();

  const supabase = createSupabaseServerClient(
    {
      get: (name) => cookieStore.get(name),
      set: (name, value, cookieOptions) => {
        writtenCookieNames.add(name);
        // cookieOptions already carries the httpOnly/secure hardening: createSupabaseServerClient
        // wrapped this adapter before handing it to the library (lib/db/auth.ts
        // hardenCookieAdapter), so there is nothing to re-apply here.
        cookieStore.set({ name, value, ...cookieOptions });
      },
      remove: (name, cookieOptions) => {
        writtenCookieNames.add(name);
        cookieStore.set({ name, value: '', ...cookieOptions, maxAge: 0 });
      },
    },
    { secure: options.secure },
  );

  return {
    supabase,
    async discardSession(): Promise<void> {
      try {
        await supabase.auth.signOut();
      } catch {
        // Best-effort: a failed server-side revocation must not stop the cookie clearing
        // below, which is what actually protects the browser that is about to be told "no".
      }

      for (const name of authCookieNames(cookieStore, writtenCookieNames)) {
        try {
          cookieStore.set({ name, value: '', path: '/', maxAge: 0 });
        } catch {
          // Not writable in this context (never true for a route handler) — nothing to undo.
        }
      }
    },
  };
}

/** Every cookie name that could be carrying auth state for this request. */
function authCookieNames(cookieStore: CookieStore, written: Set<string>): Set<string> {
  const names = new Set(written);
  try {
    for (const cookie of cookieStore.getAll()) {
      if (cookie.name.startsWith(SUPABASE_COOKIE_PREFIX)) names.add(cookie.name);
    }
  } catch {
    // getAll() unavailable — the tracked set above still covers everything we wrote.
  }
  return names;
}

/**
 * Plain-text response for the admin auth routes.
 *
 * Not the app's styled error UI on purpose: these are machine-to-machine hops in an OAuth
 * round-trip that only an operator should ever see the failure side of, and a text body keeps
 * the message copy-pasteable (the not-an-admin case hands over a user id). `no-store` because
 * a cached auth response is never right; `noindex` because the admin console is unadvertised.
 */
export function adminAuthResponse(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
