// tests/sms/preferences_token.test.ts — the no-login credential in every message.
//
// The one piece of genuinely new logic in Stage A. Everything else in that stage is transcribing a
// query that was written when its module was; this had to be designed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintPreferencesToken, looksLikePreferencesToken } from '@/lib/sms/preferences-token';

const ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'test-preferences-secret';

function withSecret(value = SECRET) {
  vi.stubEnv('SMS_PREFERENCES_SECRET', value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mintPreferencesToken', () => {
  it('is a FULL-WIDTH HMAC — never truncated like the short link', () => {
    // The short-link token is deliberately cut to 13 base62 chars with a 20-bit check, because it
    // protects public catalogue data and every character costs money in every message. THIS one
    // protects a child's age and a household postal code, with no login behind it. 256 bits,
    // base64url, 43 characters.
    withSecret();
    const token = mintPreferencesToken(ID)!;
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe by construction, nothing to escape
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is the HMAC it claims to be, computed independently', () => {
    // Not a snapshot of our own output — recomputed here from the primitive, so a change to the
    // construction fails rather than quietly redefining what the token is.
    withSecret();
    const expected = createHmac('sha256', SECRET)
      .update(`sms-preferences:${ID}`)
      .digest('base64url');
    expect(mintPreferencesToken(ID)).toBe(expected);
  });

  it('is DOMAIN-SEPARATED, so it cannot collide with another use of the same secret', () => {
    // The prefix is why a bare HMAC of the id under this secret is not this token.
    withSecret();
    const bare = createHmac('sha256', SECRET).update(ID).digest('base64url');
    expect(mintPreferencesToken(ID)).not.toBe(bare);
  });

  it('is deterministic per subscriber, and different across subscribers', () => {
    // Deterministic is what makes it RECOVERABLE — a lost token can be recomputed from the row
    // rather than only read back from it.
    withSecret();
    expect(mintPreferencesToken(ID)).toBe(mintPreferencesToken(ID));
    expect(mintPreferencesToken(ID)).not.toBe(
      mintPreferencesToken('99999999-8888-7777-6666-555555555555')
    );
  });

  it('changes completely when the secret changes', () => {
    // The rotation path, such as it is: rotating the secret invalidates every link at once. PRD §7
    // already carries "no UI for rotating a leaked preferences link" as an open risk; this design
    // does not close it and does not pretend to.
    withSecret('secret-a');
    const a = mintPreferencesToken(ID);
    vi.unstubAllEnvs();
    withSecret('secret-b');
    expect(mintPreferencesToken(ID)).not.toBe(a);
  });

  it('FAILS CLOSED with no secret — null, never a weak token', () => {
    // A row written without a token is a degraded product: the signup works, the hub link is
    // absent. A row written with a guessable token is a credential anybody can derive. The first
    // is recoverable by recomputing; the second is a breach.
    expect(mintPreferencesToken(ID)).toBeNull();
    vi.stubEnv('SMS_PREFERENCES_SECRET', '   ');
    expect(mintPreferencesToken(ID)).toBeNull();
  });
});

describe('looksLikePreferencesToken', () => {
  it('accepts what we mint', () => {
    withSecret();
    expect(looksLikePreferencesToken(mintPreferencesToken(ID))).toBe(true);
  });

  it('rejects the shapes that are not one', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43) + '=', null, undefined]) {
      expect(looksLikePreferencesToken(bad as string), String(bad)).toBe(false);
    }
    // A short-link token is 13 chars — it must not be mistaken for one of these.
    expect(looksLikePreferencesToken('7hK2pQmzN4wT9')).toBe(false);
  });

  it('is a PRE-FILTER, not a verification — it cannot check the HMAC', () => {
    // Verifying would need the subscriber id, which is what the database lookup is for. This only
    // avoids a pointless query for input that cannot possibly be a token.
    expect(looksLikePreferencesToken('A'.repeat(43))).toBe(true);
  });
});
