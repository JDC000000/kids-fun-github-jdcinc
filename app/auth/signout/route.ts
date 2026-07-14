import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';

// Sign-out (Task 21, M4). Clears the Supabase session (which removes the auth
// cookies via the cookie adapter) and redirects back into the app. GET is
// supported to mirror the existing /auth/signin GET-link convention so the
// account nav can link to it directly; POST is also accepted for callers that
// prefer a non-navigational sign-out. CSRF hardening (POST-only + token) is a
// deferred account-hardening item, not part of this first slice.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return signOut(request);
}

export function POST(request: Request): Promise<Response> {
  return signOut(request);
}

async function signOut(request: Request): Promise<Response> {
  const { origin, searchParams } = new URL(request.url);
  const next = searchParams.get('next') ?? '/';

  const cookieStore = cookies();
  const supabase = createSupabaseServerClient({
    get: (name) => cookieStore.get(name),
    set: (name, value, options) => cookieStore.set({ name, value, ...options }),
    remove: (name, options) => cookieStore.set({ name, value: '', ...options, maxAge: 0 }),
  });

  try {
    await supabase.auth.signOut();
  } catch {
    // Best-effort: even if the server-side revocation call fails, the redirect
    // proceeds; the SSR client still clears the local session cookies.
  }

  return NextResponse.redirect(`${origin}${next}`);
}
