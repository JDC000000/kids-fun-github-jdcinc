// lib/db/auth.ts — G-T6-1: Supabase Auth + Google OAuth (TSD §3A.1 FR-18; <L3>).
//
// ⚠ STATUS — REWRITTEN 2026-09-12, BECAUSE THE PREVIOUS VERSION WAS FALSE AND LOAD-BEARING.
//
// This header used to read: "code scaffold only, not yet verified end-to-end. Google login can't
// round-trip until (a) a live Supabase project has the Google provider configured with a real
// client ID/secret (D-4, vault slug kids-fun-google-oauth — currently a placeholder, no value)
// and (b) SUPABASE_URL/SUPABASE_ANON_KEY are wired". Every part of that was out of date, and it
// was one of three disagreeing status claims in the repo (docs/credentials.md said the same
// thing; app/auth/callback/route.ts said the opposite and was right).
//
// CHECKED AGAINST REALITY on 2026-09-12 rather than resolved by picking the newest-sounding one:
//   · vault slug kids-fun-google-oauth holds a real client id/secret, not a placeholder;
//   · so do kids-fun-supabase-prod and kids-fun-supabase-staging;
//   · Supabase prod's /auth/v1/authorize?provider=google 302s to accounts.google.com with a real
//     client_id — the provider is genuinely configured;
//   · https://kidsfunapp.ca/auth/signin 307'd into that flow on the live production domain.
// Production has been live since Round 28 (2026-07-21) — see docs/infra.md, which was correct
// throughout while these two files were not.
//
// ACTUAL STATUS NOW: fully wired, and DELIBERATELY GATED OFF at the route layer
// (lib/auth/google-signin-gate.ts) per Jon's 2026-09-12 decision — "nobody can sign in with
// google." The helpers below still work; nothing calls them while the gate is closed.
//
// The one true thing in the old text: no user has ever completed a round-trip. `auth.users` had
// 0 rows when measured on 2026-09-12. That is a fact about ADOPTION, not about whether the
// plumbing works — and it was being read as the latter, which is how "there are no credentials"
// survived this long. Do not restore the old wording on the strength of that row count.
//
// Reuses the THE WIP OAuth pattern (@supabase/ssr createServerClient) per TSD §7.5.
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export interface CookieAdapter {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  remove(name: string, options: CookieOptions): void;
}

/** Server-side Supabase client bound to the current request's cookies. */
export function createSupabaseServerClient(cookies: CookieAdapter) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
  }

  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        cookies.set(name, value, options);
      },
      remove(name: string, options: CookieOptions) {
        cookies.remove(name, options);
      },
    },
  });
}

/** Builds the Google OAuth sign-in URL for the browser to redirect to. */
export function googleSignInUrl(redirectTo: string): { provider: 'google'; options: { redirectTo: string } } {
  return { provider: 'google', options: { redirectTo } };
}
