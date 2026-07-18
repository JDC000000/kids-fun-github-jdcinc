// tests/email/unsubscribe.test.ts — pure HMAC unsubscribe token (CASL opt-out).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from '@/lib/email/unsubscribe';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

function withSecret(secret: string) {
  vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', secret);
}

describe('unsubscribe token', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is stable for a given (user, secret) and verifies', () => {
    withSecret('s3cret-value');
    const t1 = signUnsubscribeToken(USER_A);
    const t2 = signUnsubscribeToken(USER_A);
    expect(t1).toBe(t2);
    expect(verifyUnsubscribeToken(USER_A, t1)).toBe(true);
  });

  it('does not verify for a different user or a tampered token', () => {
    withSecret('s3cret-value');
    const tokenA = signUnsubscribeToken(USER_A);
    expect(verifyUnsubscribeToken(USER_B, tokenA)).toBe(false);
    expect(verifyUnsubscribeToken(USER_A, tokenA + 'x')).toBe(false);
    expect(verifyUnsubscribeToken(USER_A, 'not-a-real-token')).toBe(false);
    expect(verifyUnsubscribeToken(USER_A, null)).toBe(false);
  });

  it('changes when the secret changes (cannot forge without the secret)', () => {
    withSecret('secret-one');
    const t1 = signUnsubscribeToken(USER_A);
    vi.unstubAllEnvs();
    withSecret('secret-two');
    const t2 = signUnsubscribeToken(USER_A);
    expect(t1).not.toBe(t2);
    // A token minted under secret-one no longer verifies under secret-two.
    expect(verifyUnsubscribeToken(USER_A, t1)).toBe(false);
  });

  it('throws when minting without a secret, and verify returns false', () => {
    vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', '');
    expect(() => signUnsubscribeToken(USER_A)).toThrow(/UNSUBSCRIBE_SECRET/);
    expect(verifyUnsubscribeToken(USER_A, 'anything')).toBe(false);
  });

  it('builds an absolute unsubscribe URL carrying u + t', () => {
    withSecret('s3cret-value');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
    const url = unsubscribeUrl(USER_A);
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://kidsfun.example');
    expect(parsed.pathname).toBe('/api/email/unsubscribe');
    expect(parsed.searchParams.get('u')).toBe(USER_A);
    expect(verifyUnsubscribeToken(USER_A, parsed.searchParams.get('t'))).toBe(true);
  });
});
