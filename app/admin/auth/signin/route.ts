import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  ADMIN_AUTH_CALLBACK_PATH,
  adminAuthResponse,
  createAdminAuthClient,
  sanitizeAdminNext,
} from '../_lib/admin-session';

// GET /admin/auth/signin — start the ADMIN-ONLY Google sign-in.
//
// This is NOT app/auth/signin. That route is the public product's sign-in and is gated off
// permanently by Jon's 2026-09-12 ruling (lib/auth/google-signin-gate.ts); it stays gated and
// is not touched by this change. This one exists for a different problem: an operator/admin
// currently has no way to obtain a session at all, so app/admin/_lib/gate.ts's session path can
// never match and the only way into /admin/* was ADMIN_DASHBOARD_TOKEN pasted into the URL —
// a secret that leaks through browser history,
// referrers and screenshots.
//
// WHY THIS IS NOT A REVERSAL OF THE PUBLIC DECISION. Neither this file nor anything it imports
// reaches lib/auth/google-signin-gate.ts, so GOOGLE_SIGN_IN_ENABLED cannot switch this route on
// or off — the two entry points are separate code paths, not the same path with two flags. And
// what completes here is not a general user sign-in: app/admin/auth/callback/route.ts revokes
// the session unless the user is an active admin_user row, so this route can only ever hand out
// access to someone the operator has already seeded. Public sign-in stays impossible.
//
// SUPABASE REDIRECT ALLOWLIST. `redirectTo` is built from THIS request's origin, so cookies and
// the callback always stay same-origin. Supabase only honours a redirect_to that is on its
// allowlist and SILENTLY falls back to the Site URL otherwise — no error, just a different
// Location — so a working-looking 302 to Google is not evidence the allowlist is right.
//
// As of 2026-09-21 the allowlist covers BOTH https://kids-fun-psi.vercel.app/<any path> and
// https://kidsfunapp.ca/** (plus an explicit /admin/auth/callback entry), so this flow completes
// from either origin. It did NOT always: the custom domain was missing earlier that day, which is
// the likely reason the older public sign-in never once minted a session — Google returned to
// Supabase and Supabase bounced the code to the vercel.app ROOT, where nothing exchanges it. The
// operator added the missing entries; confirmed against the Supabase Management API.
//
// To re-check the allowlist without dashboard access, and without writing anything to the project:
//   curl -sI "<supabase-url>/auth/v1/verify?token=bogus&type=signup&redirect_to=<encoded url>"
// If the Location keeps your URL it is allowlisted; a bare Site URL means it is not. Use /verify,
// NOT /authorize — authorize creates a flow_state row and its `state` is opaque, so it both tells
// you nothing and writes to the project.
//
// (Nothing is ever needed in Google Cloud Console for an app-side path change: Google always
// redirects to Supabase's own /auth/v1/callback, which this route does not alter.)
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { origin, protocol, searchParams } = new URL(request.url);
  // Clamped to /admin/* — see sanitizeAdminNext. The admin entry point cannot be used to bounce
  // a signed-in browser to an arbitrary (or off-site) destination.
  const next = sanitizeAdminNext(searchParams.get('next'));

  try {
    const { supabase } = createAdminAuthClient(cookies(), { secure: protocol === 'https:' });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}${ADMIN_AUTH_CALLBACK_PATH}?next=${encodeURIComponent(next)}`,
        // Always show the account chooser. An operator signing in to an admin console is very
        // likely to have more than one Google account in the browser, and silently reusing the
        // wrong one produces a confusing "you are not an admin" rejection that looks like a bug.
        queryParams: { prompt: 'select_account' },
      },
    });

    if (error || !data?.url) {
      // Deliberately NOT the public route's `/?auth_error=…` redirect: bouncing an operator to
      // the consumer home page with a query param hides the failure. The provider's message is
      // safe to show here (it describes provider/config state, never a secret) and is what makes
      // a misconfigured deploy diagnosable on the spot.
      return adminAuthResponse(
        502,
        `Admin sign-in could not start: ${error?.message ?? 'the provider returned no authorize URL'}`,
      );
    }

    return NextResponse.redirect(data.url);
  } catch (err) {
    // createSupabaseServerClient THROWS when SUPABASE_URL / SUPABASE_ANON_KEY are unset, which
    // on a route handler would otherwise surface as a bare 500. Naming the missing configuration
    // (variable NAMES only — never a value) turns a dead end into a one-line fix.
    return adminAuthResponse(
      503,
      `Admin sign-in is not configured on this deployment: ${(err as Error)?.message ?? 'unknown error'}`,
    );
  }
}
