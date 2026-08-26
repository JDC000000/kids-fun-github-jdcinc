// app/s/[shortId]/route.ts — the weekly short link a parent taps (PRD §2.3).
//
// DRAFT (SMS pivot). GET /s/{token} → verify → resolve → count → redirect to the activity.
//
// This completes the loop that lib/sms/config.ts's `shortLinkUrl()` has been minting URLs into
// since round 4: the link-minting half of §2.3 existed, the redirect-and-log half did not.
// Everything except the three database reads is real; those are stubbed in
// lib/sms/click-through.ts, which also holds the whole decision table so it is testable without a
// request.
//
// ── PUBLIC AND UNAUTHENTICATED BY DESIGN, AND UNFLAGGED ─────────────────────────────────
// The token IS the authorization — that is the entire point of §2.3. Unlike the signup form and
// the inbound webhook, this needs no feature flag: a token that has never been minted cannot be
// guessed (13 base62 characters with a 20-bit HMAC check), and before any real message is sent
// there is nothing to reach. What it DOES need is to be unable to do anything worse than redirect
// someone to /search, which is what `resolveClickThrough` guarantees by never throwing.
//
// NOTHING ABOUT THE SUBSCRIBER LEAVES THIS ROUTE. The redirect target is an occurrence id and
// nothing else — no phone number, no subscriber id, no token echoed into a query string, and no
// error body at all. That matters more here than on a normal route: the Location header of a
// redirect is written into browser history, sent as a Referer to the destination, and logged by
// every proxy in between.

import { NextResponse } from 'next/server';
import {
  LINK_ORIGIN_PARAM,
  parseLinkOrigin,
  resolveClickThrough,
} from '@/lib/sms/click-through';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // node:crypto (HMAC verification) + the pg pool.

/**
 * 307, not 301/308, and the reason is CTR rather than HTTP pedantry.
 *
 * A PERMANENT redirect is cached by the browser and by every intermediary, so the SECOND tap on a
 * link would never reach this route — it would go straight to the cached target. Every repeat tap
 * would silently vanish from `sms_click_event`, and repeat taps are exactly the engagement signal
 * this table exists to measure. A permanent redirect would also be a lie: the mapping is
 * per-subscriber and the target can be archived tomorrow.
 *
 * 307 over 302 because 307 is unambiguous about preserving the method and about being temporary;
 * this route is GET-only so that is moot in practice, but the unambiguous one costs nothing.
 */
const REDIRECT_STATUS = 307;

export async function GET(
  request: Request,
  { params }: { params: { shortId: string } }
): Promise<NextResponse> {
  // WHICH SURFACE THIS TAP CAME FROM (`sms_click_event.link_origin`, migration 0036). The token
  // deliberately does not carry it — see `LINK_ORIGIN_PARAM` for why widening it would be worse,
  // and for the full blast radius of somebody appending `?via=hub` to a link they were texted
  // (one column of one analytics row; the token's own integrity check is untouched, because the
  // query string is not part of the signed payload).
  //
  // ANYTHING UNRECOGNISED IS 'direct', not an error: a junk parameter must not cost a parent
  // their redirect, and the value is MAPPED onto the union rather than passed through to the
  // insert, where 0036's CHECK would reject it and the click would vanish silently.
  const linkOrigin = parseLinkOrigin(new URL(request.url).searchParams.get(LINK_ORIGIN_PARAM));

  const resolution = await resolveClickThrough(params.shortId, { linkOrigin });

  // Resolve against the REQUEST's own origin rather than NEXT_PUBLIC_SITE_URL: this route is
  // reached from a text message and may be hit on a preview deployment or a staging host, and a
  // redirect that bounced a parent to the production domain mid-tap would be both surprising and
  // a way to lose the click.
  //
  // `resolution.destination` carries no query string, so `?via=hub` does NOT survive into the
  // Location header — the origin tag is consumed here and goes no further. That matters for the
  // same reason the referrer policy below does: a redirect target is written into browser history
  // and handed to every proxy in between, and it has no business carrying our analytics tagging.
  const target = new URL(resolution.destination, request.url);

  const response = NextResponse.redirect(target, REDIRECT_STATUS);

  // EVERY TAP MUST REACH THIS ROUTE. Even a 307 can be cached when a downstream cache decides to,
  // and one cached redirect means every subsequent tap on that link goes uncounted. This is the
  // one header that protects the click data, so it is set explicitly rather than assumed.
  response.headers.set('cache-control', 'no-store, max-age=0');

  // Do not leak the destination to the referrer chain. A parent tapping through to a rec centre's
  // own booking page should not hand that site a Referer identifying which KIDS FUN link they
  // came from.
  response.headers.set('referrer-policy', 'no-referrer');

  return response;
}
