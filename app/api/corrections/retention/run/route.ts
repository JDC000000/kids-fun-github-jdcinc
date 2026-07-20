// app/api/corrections/retention/run/route.ts — POST /api/corrections/retention/run
//
// The scheduled entrypoint for correction_report retention enforcement (F-6). Called
// by the platform's scheduler (a CRHQ `schedule`-skill job / cron-style trigger — the
// project's established recurring-job pattern, identical to app/api/analytics/
// retention/run and app/api/email/weekly/run; NO new cron infra stood up), which
// presents a shared secret. Deletes correction_report rows past their retained_until
// window (migration 0020).
//
// AUTH: a bearer / `x-cron-secret` shared secret (CORRECTION_RETENTION_CRON_SECRET),
// compared in constant time. Unconfigured → 503 (fail closed, never open).
//
// SAFETY: deletion is the job's purpose, so it runs for real by default, BUT:
//   • only an authorized caller (correct secret) can trigger it;
//   • it only ever removes rows already PAST retention (retained_until < now);
//   • `{ dryRun: true }` (or the CORRECTION_RETENTION_DRY_RUN=true operator
//     kill-switch) makes it count only and delete nothing;
//   • the response carries counts only — no row contents, no PII.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import {
  correctionRetentionCronSecret,
  correctionRetentionDryRunForced,
} from '@/lib/corrections/retention-config';
import { purgeExpiredCorrectionReports } from '@/lib/corrections/retention';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.

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

export async function POST(request: Request): Promise<NextResponse> {
  const expected = correctionRetentionCronSecret();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'correction retention trigger not configured' },
      { status: 503 }
    );
  }
  if (!secretOk(presentedSecret(request), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: { dryRun?: unknown; batchSize?: unknown } = {};
  try {
    const raw = await request.text();
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // Real deletion unless the caller asked for a dry-run OR the operator kill-switch
  // forces observe-only.
  const dryRun = correctionRetentionDryRunForced() || body.dryRun === true;
  const batchSize = typeof body.batchSize === 'number' && body.batchSize > 0 ? body.batchSize : undefined;

  try {
    const result = await purgeExpiredCorrectionReports({ dryRun, batchSize });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // A maintenance job failure is worth surfacing (503 = retry later), but never
    // leak internals — a short message only.
    const message = (err as Error)?.message ?? 'retention job failed';
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
