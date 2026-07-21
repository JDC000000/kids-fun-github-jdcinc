// TEMPORARY, SELF-DELETING route — Round 29 Sentry production verification.
// Deliberately throws a marked, controlled server-side error so it can be
// confirmed to reach Sentry tagged environment=production. Gated behind a
// secret query param (not discoverable/spammable), and this whole route is
// removed again in a follow-up commit within minutes of the verification.
// DO NOT rely on this route existing -- it will be gone shortly.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const secret = url.searchParams.get('s');
  if (secret !== 'r29-kf-sentry-verify-2026-07-21') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const marker = url.searchParams.get('marker') ?? 'unmarked';
  throw new Error(`KF-SENTRY-VERIFY-SERVER-${marker}`);
}
