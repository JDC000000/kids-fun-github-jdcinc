// app/api/account/export/route.ts — GET /api/account/export (Task C, M4/G5).
//
// Self-service data export (PIPEDA "access"): a signed-in parent downloads a
// structured JSON file with everything KIDS FUN holds about them under their
// account identity — their profile and their saved searches. The read runs
// through withUserContext (RLS `authenticated` role) inside exportUserData, so
// the file can ONLY ever contain the caller's own rows; another user's data is
// invisible to the query, never merely filtered out.
//
// Unlike the GET /api/me probe this is a deliberate, authenticated action, so it
// uses real status codes:
//   • 401 when not signed in (anonymous / unresolvable session),
//   • 200 with the export as a downloadable attachment on success,
//   • 500 only on a genuine unexpected read failure (generic message, no leak).
import { NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/db/session-user';
import { exportUserData } from '@/lib/db/account-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Supabase SSR + pg pool need Node, not edge.

export async function GET(): Promise<NextResponse> {
  // 1. Must be signed in — the export is strictly the caller's own data.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  // 2. Gather the owner-only export (RLS-scoped). A genuine failure is a real 500
  //    (this is a deliberate read, not the never-500 probe) with a generic message.
  try {
    const exportDoc = await exportUserData(user.userId);
    const body = JSON.stringify(exportDoc, null, 2);

    // A short, date-stamped filename. Date only (no clock) keeps it deterministic
    // enough and avoids leaking precise timing; the exact instant is inside the file.
    const stamp = exportDoc.exported_at.slice(0, 10); // YYYY-MM-DD
    const filename = `kids-fun-account-export-${stamp}.json`;

    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        // Never let an intermediary/browser cache a personal-data download.
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'could not build your data export' }, { status: 500 });
  }
}
