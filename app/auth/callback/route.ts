import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';
import { ensureUserProfile } from '../../../lib/db/user-profile';
import { GOOGLE_SIGN_IN_ENABLED, googleSignInGoneResponse } from '@/lib/auth/google-signin-gate';

// G-T6-1 — Google OAuth callback (TSD §3A.1 FR-18; <L3>). Exchanges the
// OAuth `code` for a session, provisions the user's profile on first login,
// then redirects into the app.
//
// STATUS (corrected 2026-09-12). This comment used to read "merged and live on staging
// (verified up to Google's consent screen)". It was the ONLY one of three status claims in this
// repo that was true — docs/credentials.md and lib/db/auth.ts both said the Google/Supabase
// credentials were unfilled placeholders and that sign-in could not round-trip. Checked against
// reality rather than picking the newest-sounding version:
//   · the vault holds real values for kids-fun-google-oauth and kids-fun-supabase-prod;
//   · Supabase prod's /auth/v1/authorize?provider=google 302s to accounts.google.com with a real
//     client_id, so the provider is configured, not stubbed;
//   · https://kidsfunapp.ca/auth/signin 307'd into that flow on the live production domain.
// So this was live on PRODUCTION, not merely staging — the comment understated it.
// It is now GATED OFF (lib/auth/google-signin-gate.ts): wired, working, and deliberately
// unreachable. `auth.users` has 0 rows, so no session was ever actually minted through it.
//
// First-login provisioning
// (Task 21, M4) runs here as the natural first-login moment; it is best-effort
// so a transient DB hiccup can never fail the OAuth round-trip — /api/me
// self-heals the profile on the next request.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // ensureUserProfile uses the pg pool (Node, not edge).

export async function GET(request: Request): Promise<Response> {
  // GATED (Jon, 2026-09-12). NOT redundant with the guard on /auth/signin: this route is
  // INDEPENDENTLY REACHABLE — it is a bare GET taking a `code` param and never checks that the
  // visitor passed through the initiation route, so gating only /auth/signin would have left a
  // live path to exchange a code for a session. Checked before the exchange and before any
  // profile row can be provisioned.
  if (!GOOGLE_SIGN_IN_ENABLED) return googleSignInGoneResponse();

  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (!code) {
    return NextResponse.redirect(`${origin}/?auth_error=missing_code`);
  }

  const cookieStore = cookies();
  const supabase = createSupabaseServerClient({
    get: (name) => cookieStore.get(name),
    set: (name, value, options) => cookieStore.set({ name, value, ...options }),
    remove: (name, options) => cookieStore.set({ name, value: '', ...options, maxAge: 0 }),
  });

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(error.message)}`);
  }

  // First-login provisioning: ensure a user_profile row exists for the now-
  // authenticated user. Idempotent (ON CONFLICT DO NOTHING), so a returning
  // user's callback is a no-op. Best-effort ONLY — never block the sign-in
  // redirect on it; /api/me self-heals a missing row on the next request.
  const user = data.session?.user ?? data.user ?? null;
  if (user) {
    try {
      await ensureUserProfile(user.id, user.email ?? null);
    } catch {
      // Swallow: provisioning is not load-bearing for completing sign-in.
    }
  }

  return NextResponse.redirect(`${origin}${next}`);
}
