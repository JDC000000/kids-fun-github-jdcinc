// app/api/email/unsubscribe/route.ts — CASL one-click unsubscribe.
//
// GET  /api/email/unsubscribe?u=<userId>&t=<token>  — the link in the email body.
//   Verifies the HMAC token and flips user_profile.email_opt_in to false, then
//   shows a friendly confirmation page.
// POST /api/email/unsubscribe?u=..&t=..             — RFC 8058 List-Unsubscribe
//   One-Click: mailbox providers POST here directly; returns 200 with no body.
//
// The recipient is NOT signed in, so the SIGNED TOKEN is the authorization — only
// our server (holding WEEKLY_EMAIL_UNSUBSCRIBE_SECRET) could have produced it. The
// opt-out therefore writes via the service pool (bypasses RLS by design); it only
// ever sets the EXISTING email_opt_in flag to false (the "single email opt-in" from
// Task C), never a parallel opt-out store, and is idempotent.
import { NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="margin:0;background:#f7f2e8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:48px auto;background:#fff;border-radius:12px;padding:28px;">
<h1 style="color:#102316;font-size:20px;margin:0 0 10px 0;">${title}</h1>
<p style="color:#5f7360;font-size:15px;line-height:1.6;margin:0;">${body}</p>
</div></body></html>`;
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Perform the opt-out. Returns true on a verified, applied unsubscribe. */
async function applyUnsubscribe(url: URL): Promise<boolean> {
  const userId = url.searchParams.get('u');
  const token = url.searchParams.get('t');
  if (!userId || !UUID_RE.test(userId) || !verifyUnsubscribeToken(userId, token)) return false;
  // Idempotent: sets the flag false whether or not the row exists / was already off.
  await query(`UPDATE user_profile SET email_opt_in = false WHERE id = $1`, [userId]);
  return true;
}

export async function GET(request: Request): Promise<NextResponse> {
  const ok = await applyUnsubscribe(new URL(request.url));
  if (!ok) {
    return html(
      page('This unsubscribe link isn’t valid', 'The link may be incomplete or expired. You can manage email preferences from your KIDS FUN account.'),
      400
    );
  }
  return html(
    page('You’re unsubscribed', 'You won’t get any more weekly update emails from KIDS FUN. You can turn them back on any time from your account settings.'),
    200
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const ok = await applyUnsubscribe(new URL(request.url));
  // One-click (RFC 8058): return a bare status, no body.
  return new NextResponse(null, { status: ok ? 200 : 400 });
}
