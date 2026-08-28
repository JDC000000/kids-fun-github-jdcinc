// tests/sms/phone_hash.test.ts — the durable identity in the CASL audit trail.
//
// `sms_send_log.phone_hash` is the ONLY identifier that survives migration 0034's 30-day purge, so
// it is what answers "somebody complains about a text to +1604…; what did you send them, when, and
// under which consent wording?" — a month after the rest of the row is gone, which is exactly when
// a complaint arrives.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { phoneHash, PHONE_HASH_VERSION, MissingPhoneHashSaltError } from '@/lib/sms/phone-hash';

const E164 = '+16045550123';
const SALT = 'test-phone-hash-salt';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('phoneHash', () => {
  it('is the HMAC it claims to be, recomputed independently', () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
    expect(phoneHash(E164)).toBe(
      createHmac('sha256', SALT).update(`sms-phone:${E164}`).digest('hex')
    );
  });

  it('is SALTED — not a bare digest of the number', () => {
    // The space of Canadian mobile numbers is ~10^10; an unsalted SHA-256 of all of them is
    // minutes of work. An unsalted column would be a phone-number list with extra steps, and it is
    // retained INDEFINITELY after the purge. This is the assertion that says why the salt exists.
    vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    expect(phoneHash(E164)).not.toBe(createHash('sha256').update(E164).digest('hex'));
  });

  it('is domain-separated, so reusing the salt elsewhere could not collide', () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
    expect(phoneHash(E164)).not.toBe(createHmac('sha256', SALT).update(E164).digest('hex'));
  });

  it('is stable for one number and distinct across numbers', () => {
    // Stable is the whole point: a complaint arrives with a number, and the lookup has to find the
    // rows written months earlier.
    vi.stubEnv('SMS_PHONE_HASH_SALT', SALT);
    expect(phoneHash(E164)).toBe(phoneHash(E164));
    expect(phoneHash(E164)).not.toBe(phoneHash('+16045550124'));
  });

  it('changes completely when the salt rotates — which is what the version column is FOR', () => {
    // Round 2's finding: without phone_hash_version, rotating the salt makes every historical hash
    // unmatchable with no error anywhere. The audit trail would look EMPTY rather than broken.
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'salt-a');
    const a = phoneHash(E164);
    vi.unstubAllEnvs();
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'salt-b');
    expect(phoneHash(E164)).not.toBe(a);
    expect(PHONE_HASH_VERSION).toBe(1); // one generation so far
  });

  it('🔴 FAILS CLOSED with no salt — null, never a fallback', () => {
    // There must never be a default salt. A hard-coded one produces a column that LOOKS like a
    // protected identifier and is actually reversible — and it would look correct in every test,
    // because the shape is identical. The failure has to be visible.
    expect(phoneHash(E164)).toBeNull();
    vi.stubEnv('SMS_PHONE_HASH_SALT', '   ');
    expect(phoneHash(E164)).toBeNull();
  });

  it('the error it raises names no phone number', () => {
    // It propagates into caller error strings and log lines.
    const err = new MissingPhoneHashSaltError();
    expect(err.message).not.toContain('604');
    expect(err.message).toContain('SMS_PHONE_HASH_SALT');
  });
});
