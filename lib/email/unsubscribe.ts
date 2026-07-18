// lib/email/unsubscribe.ts — one-click unsubscribe token (CASL opt-out).
//
// CASL requires every commercial electronic message to carry a working, no-cost
// unsubscribe mechanism. The recipient clicking that link is NOT signed in, so we
// cannot rely on the RLS session; instead the link itself is the authorization —
// a per-user HMAC token that only our server (holding the secret) could have
// produced. The unsubscribe route verifies the token, then flips the EXISTING
// user_profile.email_opt_in flag to false via the service role (extends the single
// email opt-in Task C documented — NOT a parallel opt-out system).
//
// Pure module (node:crypto only) so it is trivially unit-testable and reusable by
// both the send path (mint links) and the unsubscribe route (verify).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { unsubscribeSecret, appUrl } from './config';

/** Base64url encode (no padding) — URL-safe for query strings. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Deterministic unsubscribe token for a user id. HMAC-SHA256 over the user id with
 * the configured secret; the token is not reversible and cannot be forged without
 * the secret. Stable per (userId, secret) so a link keeps working across sends.
 * Throws if the secret is unconfigured — callers must fail loudly rather than mint
 * an unverifiable link.
 */
export function signUnsubscribeToken(userId: string): string {
  const secret = unsubscribeSecret();
  if (!secret) {
    throw new Error('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET is not set — cannot mint an unsubscribe token');
  }
  return b64url(createHmac('sha256', secret).update(userId).digest());
}

/**
 * Constant-time verification of a token against a user id. Returns false (never
 * throws) for a missing secret, a malformed token, or a mismatch — an
 * unverifiable request simply is not honoured.
 */
export function verifyUnsubscribeToken(userId: string, token: string | null | undefined): boolean {
  const secret = unsubscribeSecret();
  if (!secret || !token) return false;
  let expected: string;
  try {
    expected = signUnsubscribeToken(userId);
  } catch {
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal-length buffers; a length mismatch is an
  // immediate (still constant-time-enough) reject.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The absolute unsubscribe URL for a user (used in the email body + List-Unsubscribe header). */
export function unsubscribeUrl(userId: string): string {
  const token = signUnsubscribeToken(userId);
  const qs = new URLSearchParams({ u: userId, t: token }).toString();
  return appUrl(`/api/email/unsubscribe?${qs}`);
}
