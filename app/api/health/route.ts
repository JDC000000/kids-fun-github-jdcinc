import { NextResponse } from 'next/server';

import { withObservedRoute } from '@/lib/observability/route-handler';

// Lightweight liveness endpoint for the Vercel-hosted app (distinct from the
// ingestion worker's /healthz). Used by deploy smoke tests (G-T1-1 verify).
// `commit` echoes VERCEL_GIT_COMMIT_SHA (injected by Vercel at build time) so a
// smoke test can confirm exactly which commit is live — closing the
// git-ahead-of-deploy verification gap. Null in local dev / non-Vercel builds.
//
// R29: migrated onto withObservedRoute() — the shared choke point that guarantees any
// uncaught error is captured AND flushed to Sentry before the Vercel Node lambda freezes
// (see lib/observability/route-handler.ts). Transparent on this success path (no capture,
// no flush); it only engages if the handler ever throws. First adopter of the pattern.
export const dynamic = 'force-dynamic';

export const GET = withObservedRoute(
  function healthGet() {
    return NextResponse.json({
      status: 'ok',
      service: 'kids-fun-web',
      env: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    });
  },
  { tags: { route: 'api/health' } },
);
