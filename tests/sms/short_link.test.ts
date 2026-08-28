// tests/sms/short_link.test.ts — the weekly SMS short-link token (pure HMAC, no DB).
//
// Mirrors tests/email/unsubscribe.test.ts: stub the secret via env, exercise mint/verify,
// tamper, and swap the secret. The extra cases here are the ones the BIT BUDGET creates —
// boundary refs, over-range refs, and non-canonical tokens — because those are the failure
// modes a hand-packed binary token has and an opaque HMAC string does not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_BITS,
  OCCURRENCE_REF_BITS,
  SUBSCRIBER_REF_BITS,
  TOKEN_LENGTH,
  decodeShortLink,
  encodeShortLink,
} from '@/lib/sms/short-link';

function withSecret(secret: string) {
  vi.stubEnv('SMS_SHORT_LINK_SECRET', secret);
}

const OCC_MAX = 2 ** OCCURRENCE_REF_BITS - 1;
const SUB_MAX = 2 ** SUBSCRIBER_REF_BITS - 1;

describe('sms short link', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is 13 characters — the derived width of the documented bit budget', () => {
    // 32 + 24 + 20 = 76 bits; ceil(76 / log2(62)) = 13. This is the PRD deviation made
    // mechanical: if someone re-budgets the fields, this assertion is where they find out.
    expect(OCCURRENCE_REF_BITS + SUBSCRIBER_REF_BITS + CHECK_BITS).toBe(76);
    expect(TOKEN_LENGTH).toBe(13);
    withSecret('short-link-secret');
    expect(encodeShortLink(1, 1)).toHaveLength(13);
  });

  it('round-trips and is deterministic for a given (refs, secret)', () => {
    withSecret('short-link-secret');
    const t1 = encodeShortLink(5601, 42);
    const t2 = encodeShortLink(5601, 42);
    expect(t1).toBe(t2);
    expect(decodeShortLink(t1)).toEqual({ occurrenceShortRef: 5601, subscriberShortRef: 42 });
  });

  it('round-trips the field boundaries (0 and the max each field can hold)', () => {
    withSecret('short-link-secret');
    for (const [occ, sub] of [
      [0, 0],
      [0, SUB_MAX],
      [OCC_MAX, 0],
      [OCC_MAX, SUB_MAX],
    ] as const) {
      const token = encodeShortLink(occ, sub);
      expect(token).toHaveLength(TOKEN_LENGTH);
      expect(decodeShortLink(token)).toEqual({ occurrenceShortRef: occ, subscriberShortRef: sub });
    }
  });

  it('is per-subscriber — the same activity yields a different token per subscriber', () => {
    // Without this, a click could not be attributed to anyone, which is the whole reason the
    // subscriber field costs 24 of the 76 bits.
    withSecret('short-link-secret');
    expect(encodeShortLink(5601, 42)).not.toBe(encodeShortLink(5601, 43));
  });

  it('refuses to silently truncate an out-of-range reference', () => {
    // A truncated id would point at a DIFFERENT, real activity — a wrong link is worse than a
    // failed send, so this throws rather than wrapping.
    withSecret('short-link-secret');
    expect(() => encodeShortLink(OCC_MAX + 1, 1)).toThrow(/does not fit/);
    expect(() => encodeShortLink(1, SUB_MAX + 1)).toThrow(/does not fit/);
    expect(() => encodeShortLink(-1, 1)).toThrow(/does not fit/);
  });

  it('rejects a tampered token, a wrong length, and a bad character', () => {
    withSecret('short-link-secret');
    const token = encodeShortLink(5601, 42);
    const flip = token[0] === 'a' ? 'b' : 'a';
    expect(decodeShortLink(flip + token.slice(1))).toBeNull();
    expect(decodeShortLink(token.slice(1))).toBeNull();
    expect(decodeShortLink(`${token}x`)).toBeNull();
    expect(decodeShortLink(`${token.slice(0, -1)}-`)).toBeNull(); // '-' is outside base62
    expect(decodeShortLink('')).toBeNull();
    expect(decodeShortLink(null)).toBeNull();
  });

  it('rejects a non-canonical token that overflows the bit budget', () => {
    // 13 base62 chars can express ~2^77.4, more than the 2^76 the budget defines. Anything in
    // that gap is malformed by construction and must not be parsed as a wrapped-around value.
    withSecret('short-link-secret');
    expect(decodeShortLink('z'.repeat(TOKEN_LENGTH))).toBeNull();
  });

  it('cannot be forged or verified without the secret', () => {
    withSecret('secret-one');
    const t1 = encodeShortLink(5601, 42);
    vi.unstubAllEnvs();
    withSecret('secret-two');
    expect(encodeShortLink(5601, 42)).not.toBe(t1);
    expect(decodeShortLink(t1)).toBeNull(); // minted under a different secret

    vi.unstubAllEnvs();
    expect(() => encodeShortLink(5601, 42)).toThrow(/SMS_SHORT_LINK_SECRET/);
    expect(decodeShortLink(t1)).toBeNull(); // unconfigured verifies nothing, throws nothing
  });
});
