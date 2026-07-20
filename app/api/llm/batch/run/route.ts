// app/api/llm/batch/run/route.ts — POST /api/llm/batch/run
//
// The scheduled entrypoint for the nightly LLM-assisted batch job (T14-2 dedup adjudication
// + T13-5 age-parse fallback). Called by the platform's `schedule` skill off-peak — the
// project's established recurring-job pattern, identical to app/api/analytics/retention/run
// and app/api/email/weekly/run; NO new cron infra. NOT per-request / live-user-facing.
//
// AUTH: a bearer / `x-cron-secret` shared secret (LLM_BATCH_CRON_SECRET), compared in
// constant time. Unconfigured → 503 (fail closed, never open).
//
// SAFETY: real Message-Batches submission additionally requires LLM_BATCH_ENABLED=true AND a
// provisioned Anthropic client. Until then (and today) this runs DETECTION-ONLY: it counts
// candidates, writes nothing, and makes no API call. The response carries counts only — no
// record contents, no PII.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { batchCronSecret } from '@/lib/llm/config';
import { runLlmBatchJob, type UseCaseName } from '@/lib/llm/run';

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

function parseUseCases(raw: unknown): UseCaseName[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is UseCaseName => v === 'dedup' || v === 'age');
  return out.length > 0 ? out : undefined;
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = batchCronSecret();
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'llm batch trigger not configured' }, { status: 503 });
  }
  if (!secretOk(presentedSecret(request), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: { dryRun?: unknown; useCases?: unknown } = {};
  try {
    const raw = await request.text();
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  try {
    const report = await runLlmBatchJob({
      dryRun: body.dryRun === true ? true : undefined,
      useCases: parseUseCases(body.useCases),
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    const message = (err as Error)?.message ?? 'llm batch job failed';
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
