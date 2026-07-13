import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';

// G-T6-1 — Google OAuth callback (TSD §3A.1 FR-18; <L3>). Exchanges the
// OAuth `code` for a session, then redirects into the app.
//
// STATUS: scaffold only, unverified end-to-end — see lib/db/auth.ts header
// for what's blocking a real round-trip (live Supabase + Google OAuth
// credentials, D-4).
export const dynamic = 'force-dynamic';

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(error.message)}`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
