// app/api/analytics/event/route.ts — POST endpoint for browser/client analytics.
//
// Accepts a typed event payload, validates it by hand (repo convention — see
// app/api/search/route.ts), then writes best-effort into `analytics_event`.
// `user_or_session` is derived server-side from the kf_anon_id cookie so callers
// cannot spoof another visitor's session. Payload size is capped as a basic abuse
// guard. Analytics is never load-bearing: a DB failure still returns 202 so the
// browser flow is undisturbed.
import { NextResponse } from 'next/server';
import { ANON_SESSION_COOKIE, getOrCreateAnonId } from '@/lib/db/session';
import { writeAnalyticsEvent } from '@/lib/analytics/events';
import { parseAnalyticsEventBody } from '@/lib/analytics/validate';
import { MAX_ANALYTICS_PAYLOAD_BYTES } from '@/lib/analytics/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.

const ANON_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 400; // ~13 months, matches retention window.

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Cheap early reject on declared size before reading the body.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_ANALYTICS_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 2. Read + hard-cap the actual body (content-length can be absent or lie).
  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_ANALYTICS_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 3. Parse JSON.
  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  // 4. Validate the typed payload.
  const parsed = parseAnalyticsEventBody(json);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // 5. Trust the server-derived anon id, not any client-supplied session.
  const incomingCookie = readCookie(request, ANON_SESSION_COOKIE);
  const anonId = getOrCreateAnonId(incomingCookie);

  // 6. Best-effort write — a DB hiccup must not fail the request.
  const result = await writeAnalyticsEvent({ ...parsed.value, userOrSession: anonId });

  const response = NextResponse.json({ ok: true, recorded: result.ok }, { status: 202 });

  // 7. Issue a stable anon cookie when the caller didn't already have one, so
  //    future events correlate to the same session.
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
