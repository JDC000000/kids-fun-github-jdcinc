// app/api/email/weekly/preview/route.ts — GET /api/email/weekly/preview
//
// Renders the weekly digest the SIGNED-IN user would receive right now, as HTML,
// so an operator/parent can eyeball the template and brand conformance in a browser.
// It NEVER sends and is strictly SELF-scoped: it uses the caller's own session
// (getRequestUser) and only ever previews that user's own digest — no arbitrary
// userId param, so there is no cross-user data exposure and no admin surface.
//
// States:
//   • not signed in            -> 401
//   • no profile / no searches -> 200 friendly "nothing to preview" HTML
//   • nothing new this week    -> 200 friendly "nothing would be sent" HTML
//   • has new matches          -> 200 the exact digest HTML that would be emailed
import { NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/db/session-user';
import { previewWeeklyDigestForUser } from '@/lib/email/weekly';
import { renderWeeklyDigest } from '@/lib/email/render';
import { unsubscribeUrl } from '@/lib/email/unsubscribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function htmlResponse(html: string, status = 200): NextResponse {
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function notice(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="margin:0;background:#f7f2e8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;padding:24px;">
<h1 style="color:#102316;font-size:20px;margin:0 0 8px 0;">${title}</h1>
<p style="color:#5f7360;font-size:15px;line-height:1.6;margin:0;">${body}</p>
</div></body></html>`;
}

export async function GET(): Promise<NextResponse> {
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  const digest = await previewWeeklyDigestForUser(user.userId);
  if (!digest) {
    return htmlResponse(
      notice('Nothing to preview yet', 'Save a search on KIDS FUN and we’ll show you what your weekly update would look like.')
    );
  }
  if (!digest.shouldSend) {
    return htmlResponse(
      notice('No new activities this week', 'There’s nothing new matching your saved searches right now, so no email would be sent this week.')
    );
  }

  // Best-effort unsubscribe link — a preview must render even if the HMAC secret
  // isn't configured in this environment.
  let unsub = '#';
  try {
    unsub = unsubscribeUrl(user.userId);
  } catch {
    /* secret unset — preview only; leave the link inert */
  }

  const rendered = renderWeeklyDigest(digest, { unsubscribeUrl: unsub });
  return htmlResponse(rendered.html);
}
