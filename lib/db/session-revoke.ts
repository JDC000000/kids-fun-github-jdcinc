// lib/db/session-revoke.ts — revoke the current request's Supabase/Google OAuth
// session (Task C, M4). Used by the account-deletion flow to sign the user out
// after their data is removed, so the session cookie can't linger against a
// now-deleted account.
//
// Mirrors app/auth/signout/route.ts's mechanism (supabase.auth.signOut() via the
// SSR cookie adapter, which both revokes the refresh token server-side and clears
// the local auth cookies through the cookie writes) but is extracted so the
// deletion route can call it directly and so it's independently mockable in tests.
//
// Contract: NEVER throws. An unset SUPABASE_URL/ANON_KEY or a signOut hiccup must
// not break the deletion response — the app data is already gone by the time this
// runs. Best-effort, exactly like the signout route.
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from './auth';

export async function revokeCurrentSession(): Promise<void> {
  try {
    const cookieStore = cookies();
    const supabase = createSupabaseServerClient({
      get: (name) => cookieStore.get(name),
      set: (name, value, options) => {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          /* not writable in this context — ignore */
        }
      },
      remove: (name, options) => {
        try {
          cookieStore.set({ name, value: '', ...options, maxAge: 0 });
        } catch {
          /* not writable in this context — ignore */
        }
      },
    });
    await supabase.auth.signOut();
  } catch {
    /* best-effort: never block the deletion response on a session-revoke failure */
  }
}
