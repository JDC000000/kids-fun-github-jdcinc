// tests/email/site_url.test.ts — the fail-loud guard on NEXT_PUBLIC_SITE_URL, email lane.
//
// The twin of tests/sms/site_url.test.ts. Both lanes read the SAME variable, which is the detail
// that makes this worth having twice: one missing value would otherwise hollow out the SMS texts
// AND the email digests simultaneously, with no error from either.
//
// What "hollowed out" means here: Resend accepts the message, the digest arrives looking correct,
// and every link inside it points at a machine the recipient does not own — including the one-click
// unsubscribe URL that CASL requires and that Gmail and Yahoo read from the List-Unsubscribe header.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_URL, siteUrl, appUrl } from '@/lib/email/config';
import { unsubscribeUrl } from '@/lib/email/unsubscribe';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Sending on == "these links are about to reach a real inbox". */
function sending(on: boolean) {
  vi.stubEnv('WEEKLY_EMAIL_ENABLED', on ? 'true' : 'false');
}

describe('siteUrl (email lane)', () => {
  it('returns the configured value, without a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca///');
    sending(true);
    expect(siteUrl()).toBe('https://kidsfunapp.ca');
  });

  it('falls back to localhost when sending is OFF — dev and the test lanes are unaffected', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    sending(false);
    expect(siteUrl()).toBe(DEFAULT_SITE_URL);
  });

  it('🔴 THROWS when the variable is missing and sending is ON', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    sending(true);
    expect(() => siteUrl()).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it('🔴 treats a BLANK value as missing — the likelier dashboard mistake', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '   ');
    sending(true);
    expect(() => siteUrl()).toThrow(/unset or blank/);
  });

  it('names the variable, the flag, and the unsubscribe consequence in the error', () => {
    // Whoever hits this is mid-incident reading one line in a log. Without the consequence spelled
    // out, the fastest-looking fix is to delete the guard.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    sending(true);
    let message = '';
    try {
      siteUrl();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('NEXT_PUBLIC_SITE_URL');
    expect(message).toContain('WEEKLY_EMAIL_ENABLED');
    expect(message).toMatch(/unsubscribe/i);
  });
});

describe('every digest URL inherits the guard', () => {
  // As in the SMS lane: nothing SENDS siteUrl() itself. These are the values that actually appear
  // in a digest, so a guard covering only the helper would look complete and protect nothing.
  const builders: Array<[string, () => string]> = [
    ['appUrl — every listing, search and account link', () => appUrl('/search')],
    ['unsubscribeUrl — THE CASL ONE-CLICK PATH (body + List-Unsubscribe)', () => unsubscribeUrl('u1')],
  ];

  for (const [name, build] of builders) {
    it(`refuses rather than returning a localhost link: ${name}`, () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
      vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', 'test-unsub-secret');
      sending(true);
      expect(build).toThrow(/NEXT_PUBLIC_SITE_URL/);
    });

    it(`builds normally once it is configured: ${name}`, () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
      vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', 'test-unsub-secret');
      sending(true);
      expect(build()).toMatch(/^https:\/\/kidsfunapp\.ca\//);
    });
  }
});
