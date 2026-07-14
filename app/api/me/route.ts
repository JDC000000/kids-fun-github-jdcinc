// app/api/me/route.ts — GET /api/me: the session-check endpoint.
//
// Task 21 (M4, account/session foundation). Reports whether the current request
// is signed in (via the Supabase SSR session cookies), and if so, ensures the
// user's user_profile row exists (first-login self-heal) and reports it. Search
// and browse never depend on this — it is a pure account probe the header polls,
// so it must NEVER 500: a missing/misconfigured auth or DB reads as "not signed
// in" / "profile unknown", never a crash (mirrors the never-load-bearing posture
// of app/api/analytics/event/route.ts).
//
// Response (always 200):
//   anonymous     -> { authenticated: false, user: null, profile: null }
//   signed in     -> { authenticated: true,  user: { id, email }, profile: { exists, id } }
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/db/auth';
import { ensureUserProfile, getUserProfile } from '@/lib/db/user-profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Supabase SSR + pg pool need Node, not edge.

interface ProfileStatus {
  exists: boolean;
  id: string | null;
}

export async function GET(): Promise<NextResponse> {
  // 1. Resolve the session. Any failure (unset SUPABASE_URL/ANON_KEY, an expired
  //    or malformed cookie) reads the same as anonymous for a session probe.
  let userId: string | null = null;
  let email: string | null = null;
  try {
    const cookieStore = cookies();
    const supabase = createSupabaseServerClient({
      get: (name) => cookieStore.get(name),
      set: (name, value, options) => cookieStore.set({ name, value, ...options }),
      remove: (name, options) => cookieStore.set({ name, value: '', ...options, maxAge: 0 }),
    });
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      userId = data.user.id;
      email = data.user.email ?? null;
    }
  } catch {
    return NextResponse.json({ authenticated: false, user: null, profile: null });
  }

  if (!userId) {
    return NextResponse.json({ authenticated: false, user: null, profile: null });
  }

  // 2. Signed in. Ensure a profile row exists (self-heals if callback
  //    provisioning was skipped) and report it. A DB hiccup / unset
  //    USER_DATABASE_URL must not fail the probe — report profile unknown.
  let profile: ProfileStatus = { exists: false, id: null };
  try {
    let row = await getUserProfile(userId);
    if (!row) {
      ({ profile: row } = await ensureUserProfile(userId, email));
    }
    profile = { exists: true, id: row.id };
  } catch {
    profile = { exists: false, id: null };
  }

  return NextResponse.json({
    authenticated: true,
    user: { id: userId, email },
    profile,
  });
}
