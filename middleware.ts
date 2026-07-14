// middleware.ts — guarantees every visitor carries a stable anonymous session id
// (kf_anon_id) BEFORE any server-rendered analytics event fires.
//
// The gap (Task 13): app/preview/[id]/page.tsx is a server component that records
// a `listing_viewed` event via lib/analytics/record.ts, which reads the kf_anon_id
// cookie with next/headers `cookies()`. Nothing set that cookie server-side, so a
// visitor arriving directly on a server-rendered page (no prior client-side
// /api/analytics/event call) minted a FRESH id on every render — making repeat
// visits look like different anonymous users and breaking analytics correlation.
//
// The fix sets kf_anon_id on BOTH:
//   1. the FORWARDED REQUEST — RequestCookies.set() rewrites request.headers'
//      `cookie`, and NextResponse.next({ request: { headers } }) forwards those
//      headers downstream, so server components / route handlers reading cookies()
//      in the SAME request see the id we just minted (the classic
//      "middleware-set cookie only visible on the NEXT request" gotcha, avoided).
//   2. the RESPONSE — so the browser persists it for all future visits.
//
// Edge-runtime safe: getOrCreateAnonId (lib/db/session) uses the Web Crypto global,
// no Node built-ins. The anon id is a bare RFC-4122 v4 UUID — no PII — and is
// never an authorization boundary (see lib/db/session.ts).
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ANON_SESSION_COOKIE, getOrCreateAnonId } from '@/lib/db/session';

// ~13 months — matches the analytics retention window and the exact cookie shape
// issued by app/api/analytics/event/route.ts, so both code paths stay consistent.
const ANON_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 400;

export function middleware(request: NextRequest): NextResponse {
  const existing = request.cookies.get(ANON_SESSION_COOKIE)?.value;
  const anonId = getOrCreateAnonId(existing);
  // getOrCreateAnonId returns `existing` verbatim only when it was already a valid
  // UUID; absent or malformed values yield a freshly minted id (!== existing).
  const minted = existing !== anonId;

  // Make the id visible to THIS request's server components & route handlers.
  request.cookies.set(ANON_SESSION_COOKIE, anonId);
  const response = NextResponse.next({
    request: { headers: request.headers },
  });

  // Only issue Set-Cookie when we actually minted/normalised it — never overwrite
  // a visitor's existing, valid cookie.
  if (minted) {
    response.cookies.set(ANON_SESSION_COOKIE, anonId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ANON_COOKIE_MAX_AGE_S,
    });
  }

  return response;
}

// Page routes only. Excluded: /api (the analytics route self-manages the cookie),
// _next static/image assets, and favicon — none of which read the anon session.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
