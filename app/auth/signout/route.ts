import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../../../lib/db/auth';

// Sign-out (Task 21, M4 · CSRF-hardened Round 21 / Task JJ, security-review F-3).
//
// Sign-out is a real state change (it revokes the Supabase session), so it is
// **POST-only**. A GET that mutates state is the classic "logout CSRF" vector:
// any third-party page could force a logout with no interaction at all —
// `<img src=".../auth/signout">`, a prefetched link, a redirect. Requiring POST
// removes that: a bare image/link tag cannot issue a POST, and browsers will not
// attach the SameSite=Lax session cookies to a cross-site, non-top-level POST,
// so a cross-origin form auto-submit can't carry an authenticated session
// either. This route USED to be reached by the account nav's same-site
// `<form method="post">`; that component was deleted with Google sign-in
// (2026-09-12), so the route currently has no caller in the UI. It is left in
// place deliberately — retiring the auth subsystem is a separate, flagged
// decision — but note it is now unreachable by any rendered control.
//
// GET is intentionally NOT exported — Next returns 405 (Allow: POST) for it, so
// the old image-tag attack is inert.
//
// The redirect uses 303 (See Other) so the browser re-requests the landing page
// with GET after the POST, instead of re-POSTing to it (a default 307 would
// forward the POST method to the destination).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { origin, searchParams } = new URL(request.url);
  const next = searchParams.get('next') ?? '/';

  try {
    const cookieStore = cookies();
    const supabase = createSupabaseServerClient({
      get: (name) => cookieStore.get(name),
      set: (name, value, options) => cookieStore.set({ name, value, ...options }),
      remove: (name, options) => cookieStore.set({ name, value: '', ...options, maxAge: 0 }),
    });
    await supabase.auth.signOut();
  } catch {
    // Best-effort: even if constructing the SSR client (e.g. unset
    // SUPABASE_URL/SUPABASE_ANON_KEY) or the server-side revocation call fails,
    // the redirect still proceeds; the SSR client clears the local session
    // cookies when available. Mirrors /api/me's never-500 posture so signout
    // can never crash on a misconfigured environment.
  }

  return NextResponse.redirect(`${origin}${next}`, 303);
}
