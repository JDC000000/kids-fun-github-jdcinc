import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { NotAdminError, requireAdmin } from '@/lib/db/admin-guard';
import { adminAuthResponse, createAdminAuthClient, sanitizeAdminNext } from '../_lib/admin-session';

// GET /admin/auth/callback — complete the ADMIN-ONLY Google sign-in started by
// /admin/auth/signin, and hand out a session ONLY to an already-seeded admin.
//
// ── THE RULE THIS ROUTE ENFORCES ────────────────────────────────────────────────────────
// Exchanging the OAuth code mints a real Supabase session, and a real Supabase session is
// exactly what the public product is not allowed to hand out (Jon, 2026-09-12 — gated in
// lib/auth/google-signin-gate.ts, untouched by this change). So the exchange is not the end of
// this route: immediately after it, the user is checked against admin_user via the SAME
// requireAdmin() choke point the admin console itself uses, and ANYTHING other than an active
// admin — a stranger, a signed-out-of-the-console ex-admin, or an unverifiable answer because
// the database is unreachable — has the session revoked and every auth cookie expired before
// the response is returned (adminAuthClient.discardSession).
//
// That is what makes this route un-abusable as a backdoor into the disabled public sign-in: a
// non-admin who walks the entire flow ends up with no session, so they gain nothing that the
// gated /auth/signin would have given them. The check is fail-CLOSED on purpose — an
// infrastructure error denies rather than grants; the admin signs in again once it recovers.
// (There is no fallback path: the interim ADMIN_DASHBOARD_TOKEN was removed on 2026-09-24.)
//
// ── WHY IT IS SEPARATELY GUARDED FROM /auth/callback ────────────────────────────────────
// This handler is independently reachable (a bare GET with a `code`), which is precisely why
// the public callback needed its own gate rather than relying on its sign-in route's. The same
// reasoning is why the admin check lives HERE and not only in /admin/auth/signin: nothing stops
// someone presenting a code straight to this URL, and the answer must still be "not an admin,
// session revoked".
//
// ── FIRST SIGN-IN IS EXPECTED TO BE REJECTED, AND THAT IS THE POINT ─────────────────────
// admin_user is operator-seeded; this route never writes to it (and never writes to any table).
// So Jon's FIRST pass through lands on the 403 below — which prints the Supabase user id his
// Google account was just given, because that id is what the operator needs to seed and there
// is otherwise no way to discover it without querying prod auth.users. The seed is two rows,
// not one: admin_user.user_id is a FK to user_profile(id), and nothing creates a user_profile
// row automatically (supabase/migrations/0007 declares no trigger into auth.users — see the
// header of lib/db/user-profile.ts). So:
//     INSERT INTO user_profile (id)          VALUES ('<uid>');
//     INSERT INTO admin_user   (user_id,role) VALUES ('<uid>','superadmin');
// After that, the same sign-in succeeds and /admin/* works with no token in the URL.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // requireAdmin uses the pg pool (Node, not edge).

export async function GET(request: Request): Promise<Response> {
  const { origin, protocol, searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = sanitizeAdminNext(searchParams.get('next'));

  let client: ReturnType<typeof createAdminAuthClient>;
  try {
    client = createAdminAuthClient(cookies(), { secure: protocol === 'https:' });
  } catch (err) {
    // Unset SUPABASE_URL / SUPABASE_ANON_KEY (names only, never values) — same posture as the
    // sign-in route: say what is missing instead of a bare 500.
    return adminAuthResponse(
      503,
      `Admin sign-in is not configured on this deployment: ${(err as Error)?.message ?? 'unknown error'}`,
    );
  }

  if (!code) {
    // No code to exchange: nothing was minted, but clear anyway — this URL is reachable
    // directly, and a half-finished earlier attempt could have left a PKCE verifier behind.
    await client.discardSession();
    return adminAuthResponse(400, 'Admin sign-in failed: no authorization code was returned. Start again at /admin/auth/signin');
  }

  const { data, error } = await client.supabase.auth.exchangeCodeForSession(code);
  const user = data?.session?.user ?? data?.user ?? null;

  if (error || !user) {
    await client.discardSession();
    return adminAuthResponse(
      400,
      `Admin sign-in failed: ${error?.message ?? 'the provider returned no user'}. Start again at /admin/auth/signin`,
    );
  }

  // The session now exists in this browser. Everything below decides whether it is allowed to
  // survive the response.
  let denial: string | null = null;
  try {
    await requireAdmin(user.id);
  } catch (err) {
    denial =
      err instanceof NotAdminError
        ? [
            'Admin sign-in: this Google account is not an admin, so the session has been revoked.',
            '',
            `  signed in as : ${user.email ?? '(no email on the Google account)'}`,
            `  user id      : ${user.id}`,
            '',
            'Give that user id to the operator to be granted access, then sign in again.',
          ].join('\n')
        : // Could not VERIFY admin status (database unreachable, misconfigured role). Deny:
          // an unverifiable session must never be left in the browser.
          'Admin sign-in could not verify admin status right now, so the session has been revoked. Try again shortly.';

    if (!(err instanceof NotAdminError)) {
      // Observability without leaking the session or any secret — message only, same shape as
      // app/admin/_lib/gate.ts's fallback warning.
      // eslint-disable-next-line no-console
      console.warn(`[admin-signin] admin check errored, denying: ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }

  if (denial) {
    await client.discardSession();
    return adminAuthResponse(403, denial);
  }

  // Active admin: keep the session (the cookies the exchange already set) and land inside the
  // console. The first admin page load is what writes the admin_audit_log access row, via
  // app/admin/_lib/gate.ts — sign-in is not separately audited because that would mean
  // recording a 'view' of something that was not viewed.
  return NextResponse.redirect(`${origin}${next}`);
}
