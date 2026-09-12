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

/**
 * The fallback opt-out route, for BOTH pages below (QA F3, 2026-09-12).
 *
 * ── WHY THIS REPLACED "your KIDS FUN account" ───────────────────────────────────────────
 * These two pages used to send people to their account — the invalid-link page said "you can
 * manage email preferences from your KIDS FUN account", the success page said "you can turn them
 * back on any time from your account settings". /account is now a 404 (nobody can sign in, so
 * nobody has an account), which made the INVALID-LINK page the serious one: it is the fallback
 * for somebody whose opt-out just FAILED, and it was pointing them at a dead page. CASL's test is
 * not "was a mechanism offered" but "could they use it", so a broken link there is the one thing
 * on this route that actually matters. The digest footer got this fix in 8d7e117; these pages sat
 * one hop further down the same path and were out of that change's scope.
 *
 * A mailto, not a page: it is the only opt-out channel that is certain to work regardless of what
 * happens to the account area, and it matches the contact address /privacy and /terms already
 * publish. Those two hardcode the same string; a shared constant would be tidier, but both files
 * are mid legal-review and a third copy is the smaller sin than reopening them for a refactor.
 *
 * The success page no longer offers to turn the emails back on. There is no way to do that now,
 * and an opt-out confirmation promising a re-subscribe route that does not exist is worse than
 * saying nothing. It deliberately does NOT pitch the SMS product either: somebody who has just
 * opted out of one channel should not be sold another on the confirmation page.
 */
const SUPPORT_EMAIL = 'joncartwright00@gmail.com';
const MAILTO = `<a href="mailto:${SUPPORT_EMAIL}" style="color:#2f6b45;">${SUPPORT_EMAIL}</a>`;

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
      page(
        'This unsubscribe link isn’t valid',
        'The link may be incomplete or expired. Email us at ' +
          MAILTO +
          ' and we’ll unsubscribe you.'
      ),
      400
    );
  }
  return html(
    page(
      'You’re unsubscribed',
      'You won’t get any more weekly update emails from KIDS FUN. If any still arrive, email us at ' +
        MAILTO +
        '.'
    ),
    200
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const ok = await applyUnsubscribe(new URL(request.url));
  // One-click (RFC 8058): return a bare status, no body.
  return new NextResponse(null, { status: ok ? 200 : 400 });
}
