// lib/sms/client-ip.ts — the one way this branch derives a throttle subject from request headers.
//
// ═══ WHY THIS IS SHARED RATHER THAN WRITTEN TWICE ═══
// It was private to app/api/sms/signup/route.ts, which was correct while there was one caller.
// The Instant Picks SEND path is the second, and it counts against the same table, under the same
// salt, for the same threat — one caller spraying many strangers' handsets. Two copies of this
// would be two chances to get the subject subtly different, and the failure mode is silent: a
// second implementation that forgot the length cap, or hashed the whole forwarded-for chain
// instead of its leftmost entry, would still compile, still populate the table, and simply count
// nothing — because every hop would change the subject.
//
// So the RULE lives here, once. What does NOT live here is any limit or fail direction: those are
// per-caller policy (see SIGNUP_THROTTLE_LIMITS and INSTANT_PICKS_SEND_THROTTLE_LIMITS), exactly
// as lib/sms/throttle.ts already splits the shared statement from the callers' numbers.

/**
 * The caller's IP, or null when the request did not arrive with a usable one.
 *
 * ═══ x-real-ip FIRST, x-forwarded-for SECOND, AND NEITHER IS TRUSTED ═══
 * On Vercel both headers are set by the platform edge, and `x-real-ip` is the single value it
 * resolved rather than a list a proxy chain appended to — so it is the one with the least room
 * for a caller to prepend their own entry. `x-forwarded-for`'s LEFTMOST entry is the conventional
 * client position and is what we fall back to, split off rather than hashing the whole chain,
 * which would otherwise make every hop change the subject and defeat the counter.
 *
 * ⚠ THIS IS WHY AN IP LIMIT IS DEFENCE IN DEPTH AND NEVER THE ONLY GUARD. Both headers are
 * strings on an unauthenticated request; behind a misconfigured proxy either can be attacker-set,
 * and an attacker with a header can have as many identities as they like. The half that cannot be
 * evaded is always the one keyed on the DESTINATION — the phone number on the signup path, the
 * subscriber id on the Instant Picks send path — because that is what the text actually goes to.
 * Anything the IP half adds is a bonus, and both callers are written so losing it degrades rather
 * than fails.
 *
 * LENGTH-CAPPED. This value is hashed and stored, so an unbounded header must not become an
 * unbounded subject. Anything implausible for an address is treated as absent rather than
 * truncated — a truncated address is a DIFFERENT address, and would silently merge callers.
 */
export function clientIpFrom(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip')?.trim();
  const forwardedFirst = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const candidate = realIp || forwardedFirst || '';
  if (candidate.length === 0 || candidate.length > 45) return null; // 45 = longest IPv6 text form.
  return candidate;
}
