// lib/db/session-user.ts — resolve the signed-in user from request cookies.
//
// Task 24 (M4). Extracted from app/api/me/route.ts so the same session read is
// reused by GET /api/me (session probe), PATCH /api/me (profile write), and the
// /account server component — one place that knows how to turn the request's
// Supabase SSR cookies into a user id.
//
// Contract: NEVER throws. An anonymous request, an unset SUPABASE_URL/ANON_KEY,
// or a malformed/expired cookie all resolve the same way — `null` (not signed
// in). Callers decide the consequence (probe → anonymous body, write → 401,
// page → redirect to sign-in). The cookie adapter's set/remove are made
// error-tolerant so this is safe to call during a Server Component render, where
// mutating cookies would otherwise throw.
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from './auth';

export interface RequestUser {
  userId: string;
  email: string | null;
}

export async function getRequestUser(): Promise<RequestUser | null> {
  try {
    const cookieStore = cookies();
    const supabase = createSupabaseServerClient({
      get: (name) => cookieStore.get(name),
      // Supabase may attempt a token refresh (cookie write) during getUser().
      // In a Server Component render that write throws; swallow it so a read-only
      // session check still succeeds. Route handlers can write, so this is a
      // no-op cost there.
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
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      return { userId: data.user.id, email: data.user.email ?? null };
    }
    return null;
  } catch {
    return null;
  }
}
