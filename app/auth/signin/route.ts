import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';

// G-T6-1 — Google OAuth initiation (TSD §3A.1 FR-18; <L3>). Starts the PKCE
// flow: builds the Supabase `/auth/v1/authorize?provider=google` URL (storing
// the code_verifier cookie) and redirects the browser to it. Google consent →
// Supabase callback → app `/auth/callback` (see ../callback/route.ts) exchanges
// the code for a session. Completes the initiation half that the scaffold's
// `googleSignInUrl` helper described but never wired to a route.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
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
