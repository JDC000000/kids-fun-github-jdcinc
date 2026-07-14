import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';
import { ensureUserProfile } from '../../../lib/db/user-profile';

// G-T6-1 — Google OAuth callback (TSD §3A.1 FR-18; <L3>). Exchanges the
// OAuth `code` for a session, provisions the user's profile on first login,
// then redirects into the app.
//
// STATUS: the OAuth initiation + callback plumbing is merged and live on
// staging (verified up to Google's consent screen). First-login provisioning
// (Task 21, M4) runs here as the natural first-login moment; it is best-effort
// so a transient DB hiccup can never fail the OAuth round-trip — /api/me
// self-heals the profile on the next request.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // ensureUserProfile uses the pg pool (Node, not edge).

export async function GET(request: Request): Promise<Response> {
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
