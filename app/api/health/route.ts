import { NextResponse } from 'next/server';

// Lightweight liveness endpoint for the Vercel-hosted app (distinct from the
// ingestion worker's /healthz). Used by deploy smoke tests (G-T1-1 verify).
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'kids-fun-web',
    env: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
  });
}
