// lib/sms/preferences-token.ts — the no-login credential in every outbound message.
//
// DRAFT (SMS pivot), Stage A. The one piece of genuinely NEW logic in the persistence work; every
// other Stage-A seam is transcribing a query that was written when its module was.
//
// ═══ WHAT THIS TOKEN IS, AND WHY IT IS NOT THE SHORT-LINK TOKEN ═══
// `/u/{preferencesToken}` is the CASL unsubscribe path and the PIPEDA access/correction mechanism
// at the same time. Holding it means being able to read a subscriber's postal code and their
// children's ages, change them, unsubscribe, and delete everything — with no login and no second
// factor, because the product deliberately has no account.
//
// So it is NOT the short link. lib/sms/short-link.ts is deliberately TRUNCATED to 13 base62
// characters with a 20-bit check, because it protects public catalogue data and every character
// costs money in every message. This one protects a child's age. It is a full-width HMAC-SHA256,
// base64url, 43 characters, and it is never shortened for any reason.
//
// ═══ DERIVED, NOT STORED-RANDOM — AND THE TRADE THAT COMES WITH THAT ═══
// The token is HMAC(row id) rather than a random string, which means it can be RECOMPUTED from the
// row rather than only read back from it. That is what makes `preferences_token` recoverable if it
// is ever lost, and it is what lets a test assert the value rather than just its shape.
//
// THE COST, stated because it is real: it cannot be rotated by changing the token alone. Rotating
// means changing the SECRET, which invalidates every subscriber's link at once, or minting a
// random replacement and storing it — which the column already supports (it is plain text with a
// unique index, not a computed column). PRD §7 already lists "no UI for rotating a leaked
// preferences link" as an open risk; this design does not close it, and does not pretend to.
//
// ═══ FAILS CLOSED ═══
// No secret means no token, and no token means the row is written WITHOUT one rather than with a
// guessable one. A subscriber with a null token gets a signup that works and a hub link that is
// simply absent, which is a degraded product; a subscriber with a weak token gets a credential
// anybody can derive. See `mintPreferencesToken`'s return type.

import { createHmac } from 'node:crypto';
import { preferencesSecret } from './config';

/**
 * Mint the preferences token for a subscriber row, or null when unconfigured.
 *
 * NULL RATHER THAN A THROW, and rather than a fallback. `encodeShortLink` throws on a missing
 * secret because a weekly message without a working link is not worth sending; this one is called
 * during signup, where the row and the consent record are the valuable part and the hub link can
 * be backfilled later by recomputing it. Failing the signup would be the worse trade.
 *
 * BASE64URL, NOT HEX: same 256 bits in 43 characters rather than 64, and URL-safe by construction
 * so nothing downstream has to escape it into a path segment.
 *
 * DOMAIN-SEPARATED. The HMAC input is prefixed, so that even if this secret were ever reused for
 * another purpose the two token families could not collide.
 */
export function mintPreferencesToken(subscriberId: string): string | null {
  const secret = preferencesSecret();
  if (!secret) return null;
  return createHmac('sha256', secret)
    .update(`sms-preferences:${subscriberId}`)
    .digest('base64url');
}

/**
 * Is this string shaped like a token we would have minted?
 *
 * A CHEAP PRE-FILTER, NOT A VERIFICATION. `resolvePreferences` looks the token up in the database;
 * this only avoids a pointless query for input that cannot possibly be one. It deliberately does
 * NOT recompute the HMAC — that would need the subscriber id, which is what the lookup is for.
 */
export function looksLikePreferencesToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Thrown by the weekly send's pre-flight when the secret is missing. Greppable on purpose, and
 * parallel to `MissingPhoneHashSaltError`.
 *
 * ═══ WHY THIS EXISTS WHEN `mintPreferencesToken` DELIBERATELY RETURNS NULL ═══
 * The two are not in tension — they answer different questions at different moments.
 *
 * AT SIGNUP, null is right, for the reason documented above: the consent row is the valuable
 * thing, the token can be backfilled by recomputing it, and failing the signup would be the worse
 * trade. Nothing is sent, so nothing is broken.
 *
 * AT SEND TIME it is the opposite. A subscriber with no token gets `preferencesUrl('')` — a bare
 * `/u/`, which resolves to a 404, not to the unknown-token notice. The message goes out looking
 * compliant and carrying an unsubscribe link that does not work, which is the one thing
 * lib/sms/config.ts's own comment says must never happen. So the send refuses to start.
 *
 * Same secret, opposite correct answers, because the cost of continuing is different.
 */
export class MissingPreferencesSecretError extends Error {
  constructor() {
    super(
      'SMS_PREFERENCES_SECRET is not configured — refusing to send a message whose unsubscribe ' +
        'link would not work'
    );
    this.name = 'MissingPreferencesSecretError';
  }
}
