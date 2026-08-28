// lib/sms/twilio-signature.ts — verify that an inbound webhook really came from Twilio.
//
// DRAFT (SMS pivot). Pure module (node:crypto only), so the algorithm is unit-testable against
// Twilio's published test vector without a network, a live account, or the SDK.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. The inbound webhook is a PUBLIC, UNAUTHENTICATED URL
// that mutates consent state. Without signature verification, anyone who learns the URL can
// POST `From=+1604...&Body=JOIN` and manufacture a CASL express-consent record for a phone
// number they do not own — or POST `Body=STOP` and unsubscribe someone else. The signature is
// the only thing standing between those two facts.
//
// THE ALGORITHM (Twilio's documented scheme, implemented here rather than imported):
//   1. Start with the full URL of the request exactly as Twilio was configured to call it,
//      including scheme, host, path and query string.
//   2. If the request is form-encoded, sort the POST parameters by key (byte order) and append
//      each key immediately followed by its value, with no separators at all.
//   3. HMAC-SHA1 that string with the account's auth token, and base64 the digest.
//   4. Compare, in constant time, with the X-Twilio-Signature header.
//
// WHY NOT THE `twilio` SDK's validateRequest(). The SDK IS installed and does implement this
// correctly — but it also wants to hand you `req`-shaped objects and reconstruct the URL from
// request properties, which is the one part of this that must not be inferred (see below), and
// it pulls a large dependency into a code path that is 30 lines of node:crypto. Keeping it here
// keeps the module pure, keeps it testable in the `unit` lane with no SDK import, and keeps the
// URL question visible instead of hidden inside a helper. If this is later swapped for the SDK
// call, the CONFIGURED-not-inferred URL rule below still has to hold.
//
// THE URL IS CONFIGURED, NOT INFERRED — the subtle failure this design avoids. The signature
// covers the URL, so verification needs the exact string Twilio used. Behind TLS termination or
// a platform edge, the URL a Next handler observes can differ from it: `http` instead of
// `https`, an internal host, an added or dropped trailing slash. Rebuilding it from request
// headers means letting a caller influence the very string an authentication check runs over.
// So the expected URL comes from SMS_WEBHOOK_PUBLIC_URL (lib/sms/config.ts) and must match the
// Twilio console value character for character. A mismatch fails CLOSED — every request
// rejected — which is a loud, obvious misconfiguration rather than a silent bypass.
//
// !! TODO (Operator): TWILIO_AUTH_TOKEN and SMS_WEBHOOK_PUBLIC_URL are unset in this draft. The
// !! auth token is a vault credential and only the Operator can provision it. Until it is set,
// !! verifyTwilioSignature() returns false for everything and the route rejects every request —
// !! which is the intended unconfigured behaviour, not a bug to work around.

import { createHmac } from 'node:crypto';
import { safeEqual } from './safe-compare';

/**
 * Build the exact string Twilio signs: the full URL, then every form parameter appended as
 * key-immediately-followed-by-value, in ascending key order, with no separators.
 *
 * Repeated keys: Twilio's scheme concatenates every value for a repeated key in the order it
 * appeared, after sorting on the key. Inbound SMS webhooks do not send repeated keys today, but
 * getting this wrong would produce an intermittent, unexplainable verification failure rather
 * than an obvious one, so it is handled.
 */
export function buildSignatureBase(url: string, params: URLSearchParams): string {
  const keys = Array.from(new Set(Array.from(params.keys()))).sort();
  let base = url;
  for (const key of keys) {
    for (const value of params.getAll(key)) base += key + value;
  }
  return base;
}

/** The signature Twilio would have sent for this (url, params, token). Base64 HMAC-SHA1. */
export function expectedTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams
): string {
  return createHmac('sha1', authToken).update(buildSignatureBase(url, params), 'utf8').digest('base64');
}

/**
 * Constant-time verification of the X-Twilio-Signature header.
 *
 * Returns false — never throws — for a missing token, a missing header, or a mismatch. Same
 * discipline as verifyUnsubscribeToken: an unverifiable request is simply not honoured, and an
 * unconfigured environment verifies NOTHING rather than accepting everything.
 */
export function verifyTwilioSignature(args: {
  authToken: string | null;
  url: string | null;
  params: URLSearchParams;
  signature: string | null;
}): boolean {
  const { authToken, url, params, signature } = args;
  if (!authToken || !url || !signature) return false;

  let expected: string;
  try {
    expected = expectedTwilioSignature(authToken, url, params);
  } catch {
    return false;
  }

  // Constant-time in the VALUE and in the LENGTH — see lib/sms/safe-compare.ts. A Twilio
  // signature is a fixed-length base64 digest, so the length leak this closes is theoretical
  // here; it is closed anyway because the weaker pattern is the one that gets copied onward.
  return safeEqual(signature, expected);
}
