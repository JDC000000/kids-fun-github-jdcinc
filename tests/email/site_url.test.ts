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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// A WRONG ORIGIN IS NOT A MISSING ONE — the same hardening as the SMS lane (2026-09-03).
//
// This guard used to ask only "is NEXT_PUBLIC_SITE_URL set". The QA audit flagged that hole in
// lib/sms/config.ts; lib/email/config.ts had it identically, reads the SAME variable, and builds
// the email unsubscribe link. Fixing only the SMS lane would have closed the finding and left the
// bug one file over.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('siteUrl (email lane) rejects a wrong-but-set origin', () => {
  it('🔴 REJECTS the vercel.app mirror — the value that actually shipped', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kids-fun-psi.vercel.app');
    vi.stubEnv('WEEKLY_EMAIL_ENABLED', 'true');
    expect(() => siteUrl()).toThrow(/kids-fun-psi\.vercel\.app/);
  });

  it('🔴 REJECTS staging and localhost while sending is on', () => {
    vi.stubEnv('WEEKLY_EMAIL_ENABLED', 'true');
    for (const bad of ['https://kids-fun-staging-jdci-nc.vercel.app', 'http://localhost:3000']) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', bad);
      expect(() => siteUrl(), bad).toThrow();
    }
  });

  it('accepts the production origin, trailing slash and all', () => {
    vi.stubEnv('WEEKLY_EMAIL_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca/');
    expect(siteUrl()).toBe('https://kidsfunapp.ca');
  });

  it('🔴 leaves local development alone when sending is OFF', () => {
    vi.stubEnv('WEEKLY_EMAIL_ENABLED', 'false');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1:3007');
    expect(siteUrl()).toBe('http://127.0.0.1:3007');
  });
});
