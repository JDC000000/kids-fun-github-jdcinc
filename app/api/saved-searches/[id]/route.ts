// app/api/saved-searches/[id]/route.ts — delete one saved search.
//
// Task 38 (M4 / G5). DELETE /api/saved-searches/:id removes a single saved search
// owned by the signed-in user. Ownership is enforced by RLS (the owner DELETE
// policy, auth.uid() = user_id, hides other users' rows), so deleting a row that
// isn't yours simply affects nothing → a clean 404, never another user's data.
//
//   401 — not signed in
//   400 — id isn't a UUID
//   404 — no such saved search for this user (missing, or someone else's)
//   200 — deleted
//   500 — genuine unexpected DB failure
import { NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/db/session-user';
import { deleteSavedSearch } from '@/lib/db/saved-search';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = withObservedRoute(savedSearchDelete, {
  tags: { route: 'api/saved-searches/[id]', method: 'DELETE' },
});

async function savedSearchDelete(
  _request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  const { id } = params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 });
  }

  try {
    const deleted = await deleteSavedSearch(user.userId, id);
    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: id });
  } catch (err) {
    await captureAndFlush(err, undefined, { route: 'api/saved-searches/[id]', operation: 'delete' });
    return NextResponse.json({ ok: false, error: 'could not delete saved search' }, { status: 500 });
  }
}
