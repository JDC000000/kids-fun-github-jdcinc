// app/api/corrections/route.ts — POST endpoint for the "Report wrong info" affordance
// on the activity detail page (Screen 3). Records a parent-submitted correction against
// a real occurrence into `correction_report` (the corrections inbox that Screen 7 / the
// data-health slice will triage).
//
// Mirrors app/api/analytics/event/route.ts: hand validation (repo convention — zod is
// not a dependency), an early + hard payload cap, and a server-derived anon `reporter`
// (from the kf_anon_id cookie) so a caller cannot attribute a report to another visitor.
// The DB write is best-effort — a hiccup still returns 202 so the browser's optimistic
// "thanks" is never contradicted by an error — but a malformed body is a clean 400/413,
// never a crash.
import { NextResponse } from 'next/server';
import { ANON_SESSION_COOKIE, getOrCreateAnonId } from '@/lib/db/session';
import { writeCorrectionReport } from '@/lib/corrections/report';
import { parseCorrectionReportBody } from '@/lib/corrections/validate';
import { MAX_CORRECTION_PAYLOAD_BYTES } from '@/lib/corrections/types';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.

const ANON_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 400; // ~13 months, matches analytics/anon cookie.

export const POST = withObservedRoute(correctionsPost, { tags: { route: 'api/corrections' } });

async function correctionsPost(request: Request): Promise<NextResponse> {
  // 1. Cheap early reject on declared size before reading the body.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_CORRECTION_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 2. Read + hard-cap the actual body (content-length can be absent or lie).
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_CORRECTION_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 3. Parse JSON.
  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // 4. Validate the typed payload (occurrenceId required + UUID; note capped).
  const parsed = parseCorrectionReportBody(json);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // 5. Trust the server-derived anon id as the reporter, not any client-supplied value.
  const incomingCookie = readCookie(request, ANON_SESSION_COOKIE);
  const anonId = getOrCreateAnonId(incomingCookie);

  // 6. Best-effort write — a DB hiccup must not contradict the optimistic UX.
  const result = await writeCorrectionReport({ ...parsed.value, reporter: anonId });
  if (!result.ok) {
    await captureAndFlush(new Error('correction_report_write_failed'), undefined, {
      route: 'api/corrections',
      operation: 'write_correction_report',
    });
  }

  const response = NextResponse.json({ ok: true, recorded: result.ok }, { status: 202 });

  // 7. Issue a stable anon cookie when the caller didn't already have one, so a repeat
  //    reporter correlates to the same session.
  if (incomingCookie !== anonId) {
    response.cookies.set(ANON_SESSION_COOKIE, anonId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ANON_COOKIE_MAX_AGE_S,
    });
  }

  return response;
}

/** Read a single cookie value from the request header (testable without a request scope). */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
