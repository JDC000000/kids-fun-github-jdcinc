// app/api/account/delete/route.ts — POST /api/account/delete (Task C, M4/G5).
//
// Self-service account deletion (PIPEDA "withdrawal of consent" / erasure): a
// signed-in parent permanently deletes their account. This is destructive and
// irreversible, so it is deliberately NOT a one-click action — the caller must
// prove intent by echoing an exact confirmation phrase (the UI makes them type
// DELETE). Missing/wrong confirmation is a clean 400, never a partial delete.
//
// End-to-end, on a confirmed request:
//   1. Hard-delete the user's application data (saved_search rows, then the
//      user_profile row) in ONE RLS-scoped transaction — owner-only RLS means
//      only the caller's rows can ever be touched (lib/db/account-data.ts).
//   2. Best-effort remove the Supabase Auth identity (auth.users) via the
//      service-role admin API IF configured; otherwise record it as a known,
//      honestly-reported gap (lib/db/auth-admin.ts).
//   3. Revoke the current Google OAuth session so the cookie can't linger against
//      a now-deleted account (lib/db/session-revoke.ts).
//
// Status codes (deliberate write, real codes — not the never-500 probe posture):
//   • 401 not signed in, • 400 bad/absent confirmation, • 200 deleted,
//   • 409 blocked because the account still holds administrative access
//        (admin_user FK — an operator must revoke that first),
//   • 500 genuine unexpected failure (generic message, no internal leak).
import { NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/db/session-user';
import { deleteUserData } from '@/lib/db/account-data';
import { deleteAuthIdentity } from '@/lib/db/auth-admin';
import { revokeCurrentSession } from '@/lib/db/session-revoke';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Supabase SSR + pg pool need Node, not edge.

/** The exact phrase the user must echo to confirm deletion. */
export const DELETE_CONFIRM_PHRASE = 'DELETE';

/** Postgres error code for a foreign-key violation (e.g. an admin_user row still
 *  references this profile, blocking the user_profile delete). */
const PG_FOREIGN_KEY_VIOLATION = '23503';

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Must be signed in.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  // 2. Parse + require the exact confirmation phrase (guards against an
  //    accidental / CSRF-ish blind POST — deletion needs a deliberate echo).
  let json: unknown;
  try {
    const raw = await request.text();
    json = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  const confirmText =
    json && typeof json === 'object' && 'confirmText' in json
      ? (json as { confirmText: unknown }).confirmText
      : undefined;
  if (confirmText !== DELETE_CONFIRM_PHRASE) {
    return NextResponse.json(
      { ok: false, error: `to confirm, send { "confirmText": "${DELETE_CONFIRM_PHRASE}" }` },
      { status: 400 }
    );
  }

  // 3. Delete the application data (RLS-scoped, atomic).
  let deleted;
  try {
    deleted = await deleteUserData(user.userId);
  } catch (err) {
    if ((err as { code?: string })?.code === PG_FOREIGN_KEY_VIOLATION) {
      // Account still holds an administrative link that must be removed by an
      // operator first — don't leave the parent with a bare 500.
      return NextResponse.json(
        {
          ok: false,
          error:
            'This account has administrative access and can’t be self-deleted. Please contact support to have it removed.',
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: false, error: 'could not delete your account' }, { status: 500 });
  }

  // 4. Best-effort: remove the Supabase Auth identity (service-role, if configured).
  //    Never throws; an unconfigured environment reports attempted=false.
  const authIdentity = await deleteAuthIdentity(user.userId);

  // 5. Best-effort: revoke the current OAuth session (clears the auth cookies).
  await revokeCurrentSession();

  return NextResponse.json({
    ok: true,
    deleted,
    // Honest accounting of the auth-identity step so the client / logs never
    // over-claim a full erasure the environment didn't actually perform.
    authIdentityRemoved: authIdentity.ok,
    authIdentityAttempted: authIdentity.attempted,
  });
}
