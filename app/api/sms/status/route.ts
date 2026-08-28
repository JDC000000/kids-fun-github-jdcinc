// app/api/sms/status/route.ts — Twilio delivery-status callback.
//
// DRAFT (SMS pivot). POST /api/sms/status — Twilio POSTs here each time a message we sent changes
// state, at the URL lib/sms/twilio-client.ts passes as `StatusCallback` on every send.
//
// A SIBLING OF app/api/sms/inbound/route.ts, deliberately shaped the same way: raw body, verify
// first, TwiML back, never a non-2xx once verified. The differences are noted where they occur.
// The decision and the parse live in lib/sms/delivery-status.ts so they are testable without a
// request; this file is transport.
//
// WHAT IS REAL: the payload cap, the signature verification, the parse, the outcome mapping, the
// response shape. STUB: the one UPDATE, because `sms_send_log` is unapplied SQL and this branch
// holds no write credentials.
//
// ── WHY THE SIGNATURE CHECK IS FIRST, AND WHY IT MATTERS EVEN THOUGH THIS WRITES NO CONSENT ──
// The inbound webhook guards consent. This one guards the delivery record — which is smaller, but
// not nothing: unverified, anyone who learned this URL could POST `MessageStatus=delivered` for
// arbitrary SIDs and corrupt the only evidence of what the carrier actually did with our
// messages, or probe which SIDs exist by watching for a difference in response.
//
// ── AND WHY IT IS A SEPARATE ROUTE FROM THE INBOUND WEBHOOK ─────────────────────────────
// Twilio signs over the full URL it was configured with, so the two endpoints need two distinct
// configured URLs (`SMS_WEBHOOK_PUBLIC_URL` and `SMS_STATUS_CALLBACK_URL`) or neither signature
// would verify. Sharing one route would also mean delivery receipts arriving at the handler that
// classifies inbound keywords, where a `MessageStatus=delivered` body would classify as `unknown`
// and — since round 13 — earn an SMS reply to a parent who never texted us.

import { NextResponse } from 'next/server';
import { recordDeliveryStatus } from '@/lib/sms/delivery-status';
import { withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // node:crypto (HMAC) + the pg pool need Node, not edge.

/**
 * Hard cap on the callback body. A status callback is a few hundred bytes; 16 KiB is generous by
 * two orders of magnitude and still bounds what an unauthenticated caller can make us buffer
 * before the signature check has had a chance to reject them. Same figure as the inbound webhook.
 */
export const MAX_STATUS_PAYLOAD_BYTES = 16 * 1024;

/** Empty TwiML. Twilio parses this response as TwiML and expects this content type. */
function twiml(status = 200): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

export const POST = withObservedRoute(smsStatusPost, { tags: { route: 'api/sms/status' } });

async function smsStatusPost(request: Request): Promise<NextResponse> {
  // 1. Cheap early reject on the declared size, before reading anything.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_STATUS_PAYLOAD_BYTES) return twiml(413);

  // 2. Read the RAW body. It must be the raw text, not request.formData(): the signature is
  //    computed over the parameters as sent, and a parse/re-encode round trip could change what
  //    we verify. Same reasoning as the inbound webhook.
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_STATUS_PAYLOAD_BYTES) return twiml(413);

  // 3. Verify, parse and record. Twilio's documentation warns that the properties on this callback
  //    "vary by messaging channel and event type and are subject to change" — so the whole
  //    URLSearchParams goes to the verifier, not a list of fields we expected, and an unrecognised
  //    `MessageStatus` is recorded verbatim rather than rejected.
  const result = await recordDeliveryStatus(
    new URLSearchParams(raw),
    request.headers.get('x-twilio-signature')
  );

  // 4. 403 for an unverified caller. Everything else is 200 with empty TwiML.
  //
  //    A `malformed` or `error` outcome is deliberately NOT reported to Twilio as a failure: a
  //    non-2xx makes Twilio RETRY the callback, and retrying will not make a payload we could not
  //    parse become parseable, nor an UPDATE that matched no row match one. It would just produce
  //    the same result repeatedly. Our failures are ours to alert on — withObservedRoute plus the
  //    structured result — not Twilio's to retry. Identical reasoning to the inbound webhook's.
  if (result.outcome === 'unverified') return twiml(403);
  return twiml();
}
