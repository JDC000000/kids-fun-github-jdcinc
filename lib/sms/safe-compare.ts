// lib/sms/safe-compare.ts — constant-time secret comparison for the SMS lane.
//
// DRAFT (SMS pivot). One implementation, used by both places on this branch that compare a
// presented secret against an expected one: the Twilio signature check
// (lib/sms/twilio-signature.ts) and the weekly-run cron gate (app/api/sms/weekly/run/route.ts).
//
// ── WHY IT IS NOT JUST `timingSafeEqual` ────────────────────────────────────────────────
// `node:crypto`'s `timingSafeEqual` THROWS on buffers of different lengths, so every caller has
// to handle the mismatch itself. Both SMS callers did the obvious thing:
//
//     if (a.length !== b.length) return false;
//     return timingSafeEqual(a, b);
//
// which is constant-time in the VALUE and not in the LENGTH: a wrong-length guess returns
// measurably faster than a right-length one, so an attacker can find the expected length before
// attacking the content. That narrows the search space for free.
//
// THIS CODEBASE ALREADY HAD THE BETTER ANSWER and the SMS branch simply did not use it.
// The (since-deleted, 2026-09-24) lib/admin/access.ts `safeEqual` burned one same-length `timingSafeEqual` call on a mismatch so
// the two paths cost about the same. This is that function, applied to this lane's two callers.
// (This was a deliberate copy of its approach, not a move of its code.)
//
// ── HOW MUCH DOES IT ACTUALLY MATTER? Honestly: not much, and it is still worth fixing. ──
// The Twilio signature is a 28-character base64 HMAC-SHA1 digest of fixed length, so its length
// is public knowledge and leaks nothing. The cron secret is the real case — its length is not
// public, and it is the only thing standing between an unauthenticated caller and triggering a
// live send. Neither is an emergency. The reason to fix both anyway is that the weaker pattern is
// the one that gets copied into the next security check, and this branch has already written
// three.

import { timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets in constant time, WITHOUT leaking the expected length through an early
 * return. Returns false for any null/empty input.
 *
 * UTF-8 BYTES, NOT CHARACTERS, which is what `timingSafeEqual` needs and also the honest unit:
 * two strings that differ only outside the BMP would otherwise compare by a length that is not
 * the length being compared.
 */
export function safeEqual(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Burn one same-length comparison so a length mismatch costs about what a value mismatch
    // costs. Compares `a` with itself rather than `b` with itself: `a` is the ATTACKER'S input, so
    // the work done scales with what they sent, not with the length of the secret.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
