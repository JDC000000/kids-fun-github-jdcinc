import { NextResponse } from 'next/server';

// Lightweight liveness endpoint for the Vercel-hosted app (distinct from the
// ingestion worker's /healthz). Used by deploy smoke tests (G-T1-1 verify).
// `commit` echoes VERCEL_GIT_COMMIT_SHA (injected by Vercel at build time) so a
// smoke test can confirm exactly which commit is live — closing the
// git-ahead-of-deploy verification gap. Null in local dev / non-Vercel builds.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'kids-fun-web',
    env: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
