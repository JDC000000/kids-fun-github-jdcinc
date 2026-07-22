// app/api/saved-searches/route.ts — list + create a signed-in user's saved searches.
//
// Task 38 (M4 / G5). Companion to app/api/me/route.ts's PATCH handler: these are
// deliberate, authenticated-only operations, so they use real status codes
// (401 when not signed in, 400 on a bad body, 500 only on a genuine DB failure)
// rather than the never-500 posture of the GET /api/me session probe.
//
//   GET  /api/saved-searches  — the current user's saved searches (owner-scoped).
//   POST /api/saved-searches  — create one from a validated { name?, params } body.
//
// Both go through lib/db/saved-search.ts → withUserContext (RLS `authenticated`
// role), never the service pool, so a user can only ever touch their own rows.
import { NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/db/session-user';
import { listSavedSearches, createSavedSearch } from '@/lib/db/saved-search';
import { parseSavedSearchCreate } from '@/lib/user/saved-search-validate';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Supabase SSR + pg pool need Node, not edge.

export const GET = withObservedRoute(savedSearchesGet, {
  tags: { route: 'api/saved-searches', method: 'GET' },
});
export const POST = withObservedRoute(savedSearchesPost, {
  tags: { route: 'api/saved-searches', method: 'POST' },
});

async function savedSearchesGet(): Promise<NextResponse> {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }
  try {
    const savedSearches = await listSavedSearches(user.userId);
    return NextResponse.json({ ok: true, savedSearches });
  } catch (err) {
    await captureAndFlush(err, undefined, { route: 'api/saved-searches', operation: 'list' });
    return NextResponse.json({ ok: false, error: 'could not load saved searches' }, { status: 500 });
  }
}

async function savedSearchesPost(request: Request): Promise<NextResponse> {
  // 1. Must be signed in.
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

  // 3. Validate into a normalized create payload.
  const parsed = parseSavedSearchCreate(json);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // 4. RLS-scoped write. A genuine DB failure is a real 500 with a generic message.
  try {
    const savedSearch = await createSavedSearch(user.userId, parsed.value);
    return NextResponse.json({ ok: true, savedSearch }, { status: 201 });
  } catch (err) {
    await captureAndFlush(err, undefined, { route: 'api/saved-searches', operation: 'create' });
    return NextResponse.json({ ok: false, error: 'could not save search' }, { status: 500 });
  }
}
