import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';
import { GOOGLE_SIGN_IN_ENABLED, googleSignInGoneResponse } from '@/lib/auth/google-signin-gate';

// G-T6-1 — Google OAuth initiation (TSD §3A.1 FR-18; <L3>).
//
// ⚠ THIS ROUTE IS GATED OFF. See lib/auth/google-signin-gate.ts. The code below is intact and
// was verified working against production on 2026-09-12 — it is switched off by product
// decision, not broken or unfinished. Everything after the guard describes how it behaves WHEN
// RE-ENABLED, which is why it has not been deleted.
//
// Starts the PKCE
// flow: builds the Supabase `/auth/v1/authorize?provider=google` URL (storing
// the code_verifier cookie) and redirects the browser to it. Google consent →
// Supabase callback → app `/auth/callback` (see ../callback/route.ts) exchanges
// the code for a session. Completes the initiation half that the scaffold's
// `googleSignInUrl` helper described but never wired to a route.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // GATED (Jon, 2026-09-12): "nobody can sign in with google." Checked FIRST — before the URL is
  // parsed and before any Supabase client is constructed — so a disabled build cannot start a
  // PKCE flow, cannot set a code_verifier cookie, and cannot reach the provider at all.
  if (!GOOGLE_SIGN_IN_ENABLED) return googleSignInGoneResponse();

  const { origin, searchParams } = new URL(request.url);
  const next = searchParams.get('next') ?? '/';

  const cookieStore = cookies();
  const supabase = createSupabaseServerClient({
    get: (name) => cookieStore.get(name),
    set: (name, value, options) => cookieStore.set({ name, value, ...options }),
    remove: (name, options) => cookieStore.set({ name, value: '', ...options, maxAge: 0 }),
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });

  if (error || !data?.url) {
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(error?.message ?? 'no_authorize_url')}`);
  }

  return NextResponse.redirect(data.url);
}
