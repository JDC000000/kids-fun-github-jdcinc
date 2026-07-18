// app/api/email/weekly/run/route.ts — POST /api/email/weekly/run
//
// The scheduled entrypoint for the weekly digest. Called by the platform's
// scheduler (a CRHQ scheduled agent job / cron-style trigger — the project's
// established recurring-job pattern; NO new infra stood up), which presents a
// shared secret. Also usable ad-hoc for a single user (body { userId }).
//
// AUTH: a bearer/`x-cron-secret` shared secret (WEEKLY_EMAIL_CRON_SECRET), compared
// in constant time. Unconfigured → 503 (fail closed, never open).
//
// SAFETY: the route can NEVER send a real email unless WEEKLY_EMAIL_ENABLED==='true'.
// dryRun is forced true whenever sending is disabled, or whenever the caller passes
// { dryRun: true }. The response is sanitised — no email addresses, no rendered HTML
// (only per-user status + counts), so PII never leaks into logs.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { cronSecret, sendingEnabled } from '@/lib/email/config';
import { sendWeeklyDigestBulk, sendWeeklyDigestForUser, type UserSendResult } from '@/lib/email/weekly';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function presentedSecret(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return request.headers.get('x-cron-secret');
}

function secretOk(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Strip PII (email in payload.to) + bulky HTML from a per-user result for the response. */
function sanitize(r: UserSendResult) {
  return {
    userId: r.userId,
    status: r.status,
    activityCount: r.activityCount,
    ...(r.resendId ? { resendId: r.resendId } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = cronSecret();
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'weekly email trigger not configured' }, { status: 503 });
  }
  if (!secretOk(presentedSecret(request), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: { userId?: unknown; dryRun?: unknown; limit?: unknown } = {};
  try {
    const raw = await request.text();
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // Real sends require BOTH the env flag AND that the caller did not force a dry run.
  const dryRun = !sendingEnabled() || body.dryRun === true;

  if (typeof body.userId === 'string' && body.userId.trim()) {
    const result = await sendWeeklyDigestForUser(body.userId.trim(), { dryRun });
    return NextResponse.json({ ok: true, mode: 'single', dryRun, result: sanitize(result) });
  }

  const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
  const summary = await sendWeeklyDigestBulk({ dryRun, limit });
  return NextResponse.json({
    ok: true,
    mode: 'bulk',
    dryRun: summary.dryRun,
    candidates: summary.candidates,
    counts: summary.counts,
    results: summary.results.map(sanitize),
  });
}
