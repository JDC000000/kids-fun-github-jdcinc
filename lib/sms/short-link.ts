// lib/sms/short-link.ts — the per-subscriber short link carried in the weekly text.
//
// DRAFT (SMS pivot). Pure module: node:crypto + lib/sms/config only, no DB import, so it is
// unit-testable exactly like lib/email/unsubscribe.ts and reusable by both the send path (mint
// a link) and the redirect route (verify one).
//
// ═════════════════════════════════════════════════════════════════════════════════════════
// THE BIT BUDGET, AND WHY THIS IS NOT THE "~8 CHARACTERS" THE PRD ASKED FOR
// ═════════════════════════════════════════════════════════════════════════════════════════
//
// !! DEVIATION FROM THE APPROVED PRD — NEEDS OPERATOR / JON SIGN-OFF BEFORE IT IS FINAL. !!
// PRD §2.3 specifies an "~8 character" token encoding "occurrence id + a truncated HMAC check
// value", computed on request with no new lookup table. The widths below were chosen by the
// implementer, not by the PRD, because the literal 8-character version cannot be built. Do not
// read the constants here as if the PRD had specified them.
//
// WHY 8 CHARACTERS DOES NOT CLOSE.
//
//     8 base62 chars = 8 x log2(62) = 47.63 bits of TOTAL capacity.
//
//   * activity_occurrence.id is a uuid = 128 bits. That is 2.7x the entire budget on its own,
//     before any check value.
//   * The token must ALSO be per-subscriber. The PRD wants clicks attributed to a subscriber
//     (sms_click_event.subscriber_id), and a token that is identical for every recipient of a
//     given activity cannot carry that — the redirect would have no idea who tapped.
//   * A check value that is not laughably narrow needs its own bits. Truncate it to what is
//     left over from 47.63 bits after even a compressed reference and it stops being an
//     integrity check: a few thousand guesses forges one.
//
//   Three things need to fit and none of them is optional. Something has to give, and it is
//   the character count — widening to hold a raw UUID instead would take ~29 base62 characters,
//   longer than the UUID the link was supposed to shorten.
//
// WHAT GIVES INSTEAD: the token stops carrying UUIDs. Migrations 0034 and 0037 add a compact,
// sequence-backed `short_ref bigint` to sms_consent and activity_occurrence. The token carries
// those, and the redirect resolves each with one indexed lookup — the same single indexed read
// the UUID would have cost. The PRD's real constraint ("no new lookup TABLE" — nothing to
// join, no mapping table, no write when a link is minted) is honoured; the literal character
// count is not.
//
//   occurrence short_ref  32 bits   4.29e9 values. ~5,600 live occurrences today, and identity
//                                   values are consumed per INSERT (not per live row), so the
//                                   binding number is lifetime inserts — millennia of headroom.
//   subscriber short_ref  24 bits   16.7M subscribers. Metro Vancouver's entire population is
//                                   ~2.6M, so this is ~6x the total addressable market.
//   integrity check       20 bits   1-in-1,048,576 per forgery attempt.
//   ------------------------------  ---------------------------------------------------------
//   TOTAL                 76 bits   -> ceil(76 / log2(62)) = 13 base62 characters.
//
// 13 characters, in a link like https://kidsfun.example/k/7bQ2mX9pLa4Rd — about 5 characters
// more than the PRD imagined, on a URL that is ~35 characters regardless. Every width is a
// NAMED CONSTANT below; changing one changes TOKEN_LENGTH automatically, so re-budgeting later
// is a one-line edit and not a rewrite.
//
// WHY 20 BITS OF CHECK IS ENOUGH HERE, STATED HONESTLY. A forged token buys an attacker very
// little: the target is public catalogue data, so a successful guess reveals nothing private —
// it lands on an activity page and writes one bogus sms_click_event. The check exists to keep
// enumeration from silently polluting click analytics and to make "tampered link" a detectable
// state, not to protect a secret. At 20 bits, ~1 in a million random tokens validates; the
// redirect route is expected to rate-limit, which turns that into an unattractive amount of
// work for a corrupted analytics row. If the token ever carries something that actually needs
// protecting, CHECK_BITS is the constant to raise — and the reason to raise it should be
// written down next to it.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { shortLinkSecret } from './config';

// ── Bit budget (adjustable; TOKEN_LENGTH follows) ────────────────────────────

/** Width of the activity_occurrence.short_ref field inside a token. */
export const OCCURRENCE_REF_BITS = 32;
/** Width of the sms_consent.short_ref field inside a token. */
export const SUBSCRIBER_REF_BITS = 24;
/** Width of the truncated HMAC integrity check. */
export const CHECK_BITS = 20;

/** The two references, packed, before the check value is appended. */
const PAYLOAD_BITS = OCCURRENCE_REF_BITS + SUBSCRIBER_REF_BITS;
/** Everything the token encodes. */
const TOTAL_BITS = PAYLOAD_BITS + CHECK_BITS;

/** base62, digits-then-upper-then-lower. Index 0 is the pad character. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = BigInt(ALPHABET.length);

/**
 * Fixed token width, DERIVED from the bit budget rather than hard-coded — the whole point of
 * the named constants above is that re-budgeting does not require also remembering to change a
 * length somewhere else. Fixed-width (rather than variable, with small values encoding short)
 * because a variable length leaks the magnitude of the ids in the URL and makes the malformed
 * check fuzzier for no benefit.
 */
export const TOKEN_LENGTH = Math.ceil(TOTAL_BITS / Math.log2(ALPHABET.length));

const OCCURRENCE_MAX = (1n << BigInt(OCCURRENCE_REF_BITS)) - 1n;
const SUBSCRIBER_MAX = (1n << BigInt(SUBSCRIBER_REF_BITS)) - 1n;
const SUBSCRIBER_MASK = SUBSCRIBER_MAX;
const CHECK_MASK = (1n << BigInt(CHECK_BITS)) - 1n;
const TOTAL_LIMIT = 1n << BigInt(TOTAL_BITS);

/** Byte width of the HMAC input, so the signed message is unambiguous and fixed-length. */
const PAYLOAD_BYTES = Math.ceil(PAYLOAD_BITS / 8);
/** Byte width used for the constant-time comparison of two check values. */
const CHECK_BYTES = Math.ceil(CHECK_BITS / 8);

export interface ShortLinkRefs {
  occurrenceShortRef: number;
  subscriberShortRef: number;
}

/** Big-endian fixed-width serialisation, so the HMAC signs one canonical byte string. */
function toFixedBytes(value: bigint, width: number): Buffer {
  const out = Buffer.alloc(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Truncated HMAC-SHA256 over the packed (occurrence, subscriber) payload, keyed by the server
 * secret. Signing the PACKED payload rather than the two numbers separately is deliberate: it
 * binds them together, so a valid (occurrence A, subscriber A) check cannot be lifted onto
 * (occurrence A, subscriber B). Throws if the secret is unconfigured — a caller must fail
 * loudly rather than mint an unverifiable link, exactly as signUnsubscribeToken does.
 */
function checkValue(payload: bigint): bigint {
  const secret = shortLinkSecret();
  if (!secret) {
    throw new Error('SMS_SHORT_LINK_SECRET is not set — cannot mint or verify a short link');
  }
  const digest = createHmac('sha256', secret).update(toFixedBytes(payload, PAYLOAD_BYTES)).digest();
  // Any fixed selection of HMAC output bits is a sound truncation; take the low bits of the
  // leading 8 bytes and mask to CHECK_BITS.
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & CHECK_MASK;
}

function toBigInt(value: bigint | number, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return BigInt(value);
}

/** Fixed-width base62, left-padded with the alphabet's zero digit. */
function encodeBase62(value: bigint, width: number): string {
  let v = value;
  let out = '';
  while (v > 0n) {
    out = ALPHABET[Number(v % BASE)] + out;
    v /= BASE;
  }
  return out.padStart(width, ALPHABET[0]);
}

/** Fixed-width base62 decode. Returns null on any character outside the alphabet. */
function decodeBase62(token: string): bigint | null {
  let v = 0n;
  for (const ch of token) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    v = v * BASE + BigInt(digit);
  }
  return v;
}

/**
 * Mint the token for one (occurrence, subscriber) pair. Deterministic: the same pair and the
 * same secret always produce the same token, so a link stays valid across sends and a click
 * arriving days later still resolves.
 *
 * Throws on an out-of-range reference (a silently truncated id would point at the WRONG
 * activity, which is worse than a failed send) and on a missing secret.
 */
export function encodeShortLink(
  occurrenceShortRef: bigint | number,
  subscriberShortRef: bigint | number
): string {
  const occ = toBigInt(occurrenceShortRef, 'occurrenceShortRef');
  const sub = toBigInt(subscriberShortRef, 'subscriberShortRef');
  if (occ < 0n || occ > OCCURRENCE_MAX) {
    throw new Error(`occurrenceShortRef ${occ} does not fit in ${OCCURRENCE_REF_BITS} bits`);
  }
  if (sub < 0n || sub > SUBSCRIBER_MAX) {
    throw new Error(`subscriberShortRef ${sub} does not fit in ${SUBSCRIBER_REF_BITS} bits`);
  }
  const payload = (occ << BigInt(SUBSCRIBER_REF_BITS)) | sub;
  const full = (payload << BigInt(CHECK_BITS)) | checkValue(payload);
  return encodeBase62(full, TOKEN_LENGTH);
}

/**
 * Verify and unpack a token. Returns null — never throws — for a missing secret, a wrong
 * length, a character outside the alphabet, a non-canonical value that overflows the bit
 * budget, or a failed integrity check. An unverifiable link is simply not honoured, the same
 * discipline verifyUnsubscribeToken applies.
 *
 * The comparison is constant-time over fixed-width buffers. Timing here leaks little of value
 * (the check is 20 bits over public catalogue ids), but a hand-rolled `===` on a security check
 * is the kind of thing that gets copied into a place where it does matter, so it is not
 * hand-rolled here either.
 */
export function decodeShortLink(token: string | null | undefined): ShortLinkRefs | null {
  if (!token || token.length !== TOKEN_LENGTH) return null;

  const full = decodeBase62(token);
  if (full === null || full >= TOTAL_LIMIT) return null;

  const payload = full >> BigInt(CHECK_BITS);
  const presented = full & CHECK_MASK;

  let expected: bigint;
  try {
    expected = checkValue(payload);
  } catch {
    return null; // unconfigured secret — verify nothing rather than accept anything
  }

  if (
    !timingSafeEqual(
      toFixedBytes(presented, CHECK_BYTES),
      toFixedBytes(expected, CHECK_BYTES)
    )
  ) {
    return null;
  }

  return {
    // Both fields are <= 32 bits, so Number() is exact and well inside Number.MAX_SAFE_INTEGER.
    occurrenceShortRef: Number(payload >> BigInt(SUBSCRIBER_REF_BITS)),
    subscriberShortRef: Number(payload & SUBSCRIBER_MASK),
  };
}
