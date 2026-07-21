// app/api/kf-obs-verify/route.ts
//
// TEMPORARY (R29) verification route — DO NOT MERGE TO main.
//
// Proves, on the real Vercel **Node** serverless runtime, that withObservedRoute() catches, captures
// AND flushes an ORDINARY thrown error before the lambda freezes — i.e. the structural mechanism does
// the work, with NO hand-written Sentry.captureException in the handler (that is the whole point: it
// behaves exactly like an accidental production bug, a plain `throw`).
//
// NOTE: the path deliberately avoids a leading-underscore folder — Next.js treats `_name` folders as
// PRIVATE (non-routable), which silently 404s the route (the exact trap Round 29's commit 3e9e24d hit).
//
// Double-gated so it is inert on production and to real/scanner traffic:
//   1. never active when NEXT_PUBLIC_APP_ENV === 'production'; and
//   2. requires ?token= to match ADMIN_DASHBOARD_TOKEN (already set in the staging Vercel env),
//      constant-time compared; unauthorized/misconfigured -> 404 (route existence stays unadvertised).
//
// Lives only on the ops/r29-sentry-serverless-flush-wrapper branch. Remove before any merge; the
// permanent deliverables are lib/observability/route-handler.ts and the api/health migration.
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export const GET = withObservedRoute(
  async function obsVerifyGet(request: Request): Promise<Response> {
    // Gate 1 — never live in production.
    if ((process.env.NEXT_PUBLIC_APP_ENV ?? 'development') === 'production') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // Gate 2 — shared-secret token.
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const expected = process.env.ADMIN_DASHBOARD_TOKEN;
    if (!expected || !token || !timingSafeEqualStr(token, expected)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // Authorized — throw a PLAIN, ordinary error. withObservedRoute() (NOT this handler) must
    // capture + flush it. The marker lets the verifier find this exact event in Sentry.
    const marker = url.searchParams.get('marker') ?? 'unmarked';
    throw new Error(`R29_OBS_VERIFY plain serverless throw marker=${marker}`);
  },
  { tags: { route: 'api/kf-obs-verify' } },
);
