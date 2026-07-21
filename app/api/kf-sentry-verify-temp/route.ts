// TEMPORARY, SELF-DELETING route — Round 29 Sentry production verification.
// Explicitly captures + flushes (rather than relying solely on auto-instrumentation
// of the thrown error) to remove ambiguity about serverless function termination
// timing cutting off the async send. Gated behind a secret query param. This whole
// route is removed again once verification is complete.
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const secret = url.searchParams.get('s');
  if (secret !== 'r29-kf-sentry-verify-2026-07-21') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const marker = url.searchParams.get('marker') ?? 'unmarked';
  const err = new Error(`KF-SENTRY-VERIFY-SERVER-${marker}`);
  const eventId = Sentry.captureException(err);
  const flushed = await Sentry.flush(8000);
  return NextResponse.json({ eventId, flushed, marker }, { status: 200 });
}
