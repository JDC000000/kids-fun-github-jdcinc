// tests/sms/signup_redirect.test.ts — /sms/start is the primary landing page; /sms/signup 308s to
// it, and everything WE compose points straight at /sms/start rather than paying the hop.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signupUrl } from '@/lib/sms/config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the redirect itself', () => {
  const config = readFileSync('next.config.mjs', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('🔴 is PERMANENT (308), not temporary', () => {
    // 308 preserves the request method; 301/302 are historically downgraded to GET by browsers.
    // Nothing POSTs here today, but a permanent redirect outlives that assumption.
    expect(config).toMatch(/source:\s*'\/sms\/signup'/);
    expect(config).toMatch(/destination:\s*'\/sms\/start'/);
    expect(config).toMatch(/permanent:\s*true/);
  });

  it('🔴 does NOT capture the API route', () => {
    // /api/sms/signup is where both forms POST. A wildcard source, or a source of '/sms/signup:path*',
    // would swallow it and break every signup. The source must be that exact path and nothing more.
    //
    // Scoped to the redirects() block (2026-09-24): the file-wide form of the second assertion also
    // matched a HEADER rule — `/api/admin/:path*` gets no-referrer / no-store headers, which
    // redirects nothing. The property under test is "no REDIRECT source captures /api".
    const start = config.indexOf('async redirects()');
    const end = config.indexOf('async headers()');
    expect(start, 'next.config.mjs has a redirects() block').toBeGreaterThan(-1);
    expect(end, 'redirects() is followed by headers() — if the order changes, re-scope this slice').toBeGreaterThan(start);
    const redirects = config.slice(start, end);
    expect(redirects).toMatch(/source:\s*'\/sms\/signup'/);
    expect(redirects).not.toMatch(/source:\s*'\/sms\/signup[^']/);
    expect(redirects).not.toMatch(/source:\s*'\/api/);
  });
});

describe('self-controlled references skip the hop', () => {
  it('🔴 signupUrl() — which goes into real SMS bodies — points at /sms/start', () => {
    // site_url.test.ts calls these builders "what actually appear in a message". A link we compose
    // ourselves should not cost a redirect on a phone with one bar. It is also one character
    // shorter, which is free GSM-7 segment budget.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    expect(signupUrl()).toBe('https://kidsfunapp.ca/sms/start');
    expect(signupUrl()).not.toContain('/sms/signup');
  });

  it('the preferences unknown-token fallback links straight to /sms/start', () => {
    // The one page that tells somebody with a dead link where to go instead.
    const page = readFileSync('app/u/[preferencesToken]/page.tsx', 'utf8');
    expect(page).toContain('href="/sms/start"');
    expect(page).not.toContain('href="/sms/signup"');
  });
});
