// lib/db/auth.ts — G-T6-1: Supabase Auth + Google OAuth (TSD §3A.1 FR-18; <L3>).
//
// STATUS: code scaffold only, not yet verified end-to-end. Google login can't
// round-trip until (a) a live Supabase project has the Google provider
// configured with a real client ID/secret (D-4, vault slug
// kids-fun-google-oauth — currently a placeholder, no value) and (b)
// SUPABASE_URL/SUPABASE_ANON_KEY are wired for the target environment. This
// reuses the THE WIP OAuth pattern (@supabase/ssr createServerClient) per
// TSD §7.5. Do not mark G-T6-1 "done" until the live round-trip is verified.
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
