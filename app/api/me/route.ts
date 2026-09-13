// app/api/me/route.ts — the current-user endpoint.
//
// GET  /api/me  — Task 21 (M4): the session-check probe. Reports whether the
//   request is signed in and, if so, self-heals + reports the user_profile row.
//   It was written to be polled by AccountNav, which was deleted with Google
//   sign-in (2026-09-12) — so GET currently has NO caller. The never-500 posture
//   is kept anyway (a missing/misconfigured auth or DB reads as "not signed in" /
//   "profile unknown", never a crash; mirrors app/api/analytics/event/route.ts).
//   PATCH below is still live: /account's AccountForm calls it.
//
// PATCH /api/me — Task 24 (M4): let the signed-in user edit their own profile
//   (home_postal / saved_child_ages / email_opt_in). Unlike GET this is a
//   deliberate write, so it uses real status codes:
//     • 401 when not signed in (anonymous or unresolvable session),
//     • 400 on a malformed body / invalid field,
//     • 200 with the updated profile on success,
//     • 500 only on a genuine unexpected write failure.
//   The write goes through withUserContext (RLS `authenticated` role) inside
//   updateUserProfile — never the service pool — so a user can only touch their
//   own row.
//
// GET response (always 200):
//   anonymous     -> { authenticated: false, user: null, profile: null }
//   signed in     -> { authenticated: true,  user: { id, email }, profile: { exists, id } }
import { NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/db/session-user';
import { ensureUserProfile, getUserProfile, updateUserProfile } from '@/lib/db/user-profile';
import { parseProfilePatch } from '@/lib/user/profile-validate';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Supabase SSR + pg pool need Node, not edge.

interface ProfileStatus {
  exists: boolean;
  id: string | null;
}

export const GET = withObservedRoute(meGet, { tags: { route: 'api/me', method: 'GET' } });
export const PATCH = withObservedRoute(mePatch, { tags: { route: 'api/me', method: 'PATCH' } });

async function meGet(): Promise<NextResponse> {
  // 1. Resolve the session. getRequestUser never throws — any failure (unset
  //    SUPABASE_URL/ANON_KEY, an expired/malformed cookie) reads as anonymous.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ authenticated: false, user: null, profile: null });
  }

  // 2. Signed in. Ensure a profile row exists (self-heals if callback
  //    provisioning was skipped) and report it. A DB hiccup / unset
  //    USER_DATABASE_URL must not fail the probe — report profile unknown.
  let profile: ProfileStatus = { exists: false, id: null };
  try {
    let row = await getUserProfile(user.userId);
    if (!row) {
      ({ profile: row } = await ensureUserProfile(user.userId, user.email));
    }
    profile = { exists: true, id: row.id };
  } catch (err) {
    await captureAndFlush(err, undefined, { route: 'api/me', operation: 'profile_probe' });
    profile = { exists: false, id: null };
  }

  return NextResponse.json({
    authenticated: true,
    user: { id: user.userId, email: user.email },
    profile,
  });
}

async function mePatch(request: Request): Promise<NextResponse> {
  // 1. Must be signed in. A null user (anonymous or unresolvable session) is a
  //    clean 401, not a crash.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  // 2. Parse the body.
  let json: unknown;
  try {
    const raw = await request.text();
    json = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // 3. Validate into a normalized patch (unknown/invalid fields rejected here).
  const parsed = parseProfilePatch(json);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // 4. RLS-scoped write. A genuine DB failure is a real 500 (this is a write, not
  //    the never-500 probe) — with a generic message so nothing internal leaks.
  try {
    const profile = await updateUserProfile(user.userId, parsed.value);
    return NextResponse.json({ ok: true, profile });
  } catch (err) {
    await captureAndFlush(err, undefined, { route: 'api/me', operation: 'update_profile' });
    return NextResponse.json({ ok: false, error: 'could not update profile' }, { status: 500 });
  }
}
