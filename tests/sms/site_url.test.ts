// tests/sms/site_url.test.ts — the fail-loud guard on NEXT_PUBLIC_SITE_URL.
//
// ═══ THE FAILURE THIS PREVENTS IS SILENT, WHICH IS WHY IT NEEDS A TEST ═══
// `siteUrl()` used to fall back to http://localhost:3000 unconditionally. Every user-facing URL
// this product puts in a text is built from it, so an unset or blank variable did not break the
// send — it hollowed it out. Twilio reports success, nothing throws, no error appears anywhere,
// and every link in every message points at a machine the recipient does not own. Including the
// preferences link, which is the CASL unsubscribe path.
//
// Nothing about that is visible from a log or a green test run, so the guard is asserted here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SITE_URL_DEV_FALLBACK,
  siteUrl,
  shortLinkUrl,
  signupUrl,
  preferencesUrl,
} from '@/lib/sms/config';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Sending on == "these links are about to go to a real person". */
function sending(on: boolean) {
  vi.stubEnv('SMS_SENDING_ENABLED', on ? 'true' : 'false');
}

describe('siteUrl', () => {
  it('returns the configured value, without a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca///');
    sending(true);
    expect(siteUrl()).toBe('https://kidsfunapp.ca');
  });

  it('falls back to localhost when sending is OFF — dev and the test lanes are unaffected', () => {
    // The guard must not make local development or the suites harder. With sending off, nothing
    // reaches a phone, so a localhost link is correct rather than dangerous.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    sending(false);
    expect(siteUrl()).toBe(SITE_URL_DEV_FALLBACK);
  });

  it('🔴 THROWS when the variable is missing and sending is ON', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    sending(true);
    expect(() => siteUrl()).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it('🔴 treats a BLANK value as missing — the likelier dashboard mistake', () => {
    // A variable emptied in a hosting UI is easier to do than one deleted, and it is the case a
    // `?? fallback` written against `undefined` alone would sail straight past.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '   ');
    sending(true);
    expect(() => siteUrl()).toThrow(/unset or blank/);
  });

  it('says what broke, and what it would have cost, in the error itself', () => {
    // Whoever hits this is mid-incident and reading one line in a serverless log. It needs to name
    // the variable to set AND why it stopped, or the fastest fix looks like deleting the guard.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    sending(true);
    let message = '';
    try {
      siteUrl();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('NEXT_PUBLIC_SITE_URL');
    expect(message).toContain('SMS_SENDING_ENABLED');
    expect(message).toMatch(/unsubscribe/i);
  });
});

describe('every link builder inherits the guard', () => {
  // The point of the guard is not `siteUrl` itself — nothing sends `siteUrl()`. It is these three,
  // which are what actually appear in a message. A guard that covered only the helper would leave
  // the real payload unprotected, and each of these would still cheerfully build a localhost URL.
  const builders: Array<[string, () => string]> = [
    ['shortLinkUrl — every link in every weekly text', () => shortLinkUrl('tok')],
    ['signupUrl — the unknown-keyword reply', () => signupUrl()],
    ['preferencesUrl — THE CASL UNSUBSCRIBE PATH', () => preferencesUrl('ptok')],
  ];

  for (const [name, build] of builders) {
    it(`refuses rather than returning a localhost link: ${name}`, () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
      sending(true);
      expect(build).toThrow(/NEXT_PUBLIC_SITE_URL/);
    });

    it(`builds normally once it is configured: ${name}`, () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
      sending(true);
      expect(build()).toMatch(/^https:\/\/kidsfunapp\.ca\//);
    });
  }
});
