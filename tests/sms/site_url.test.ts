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
  PRODUCTION_ORIGIN,
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

describe('siteUrl() when SMS sending is ENABLED', () => {
  it('accepts the production origin', () => {
    process.env.SMS_SENDING_ENABLED = 'true';
    process.env.NEXT_PUBLIC_SITE_URL = PRODUCTION_ORIGIN;
    expect(siteUrl()).toBe(PRODUCTION_ORIGIN);
  });

  it('accepts it with a trailing slash, which is the same origin', () => {
    process.env.SMS_SENDING_ENABLED = 'true';
    process.env.NEXT_PUBLIC_SITE_URL = `${PRODUCTION_ORIGIN}/`;
    expect(siteUrl()).toBe(PRODUCTION_ORIGIN);
  });

  it('🔴 REJECTS the vercel.app mirror — the exact value that shipped', () => {
    process.env.SMS_SENDING_ENABLED = 'true';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://kids-fun-psi.vercel.app';
    expect(() => siteUrl()).toThrow(/kids-fun-psi\.vercel\.app/);
  });

  it('🔴 REJECTS a staging host and localhost', () => {
    process.env.SMS_SENDING_ENABLED = 'true';
    for (const bad of [
      'https://kids-fun-staging-jdci-nc.vercel.app',
      'http://localhost:3000',
      'http://127.0.0.1:3007',
      'https://kidsfunapp.ca.evil.example',
    ]) {
      process.env.NEXT_PUBLIC_SITE_URL = bad;
      expect(() => siteUrl(), bad).toThrow();
    }
  });

  it('the message names the offending value, so the fix is obvious from the log', () => {
    process.env.SMS_SENDING_ENABLED = 'true';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://wrong.example';
    expect(() => siteUrl()).toThrow(/https:\/\/wrong\.example/);
    expect(() => siteUrl()).toThrow(new RegExp(PRODUCTION_ORIGIN.replace(/[.]/g, '\\.')));
  });

  it('🔴 still rejects unset — the original guard is not weakened', () => {
    process.env.SMS_SENDING_ENABLED = 'true';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(() => siteUrl()).toThrow(/unset or blank/);
  });
});

describe('siteUrl() when SMS sending is DISABLED', () => {
  it('🔴 allows any origin — local development and the test lanes must keep working', () => {
    // The guard is gated on "are these links about to reach a real person", not on NODE_ENV.
    // With sending off, a localhost origin is correct and wanted.
    process.env.SMS_SENDING_ENABLED = 'false';
    process.env.NEXT_PUBLIC_SITE_URL = 'http://127.0.0.1:3007';
    expect(siteUrl()).toBe('http://127.0.0.1:3007');
  });

  it('falls back to the dev default when unset', () => {
    process.env.SMS_SENDING_ENABLED = 'false';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(siteUrl()).toMatch(/localhost/);
  });
});
