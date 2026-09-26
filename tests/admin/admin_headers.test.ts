// tests/admin/admin_headers.test.ts — the response headers every admin route must carry.
//
// The admin console renders personal data (/admin/sms-subscribers: phone numbers, postal codes,
// children's ages) and its sign-in round-trip carries an OAuth `code` in the URL. Until 2026-09-24
// it also carried a shared secret as `?token=`. None of /admin/* had a Referrer-Policy, so any
// outbound link (the corrections queue links to each listing's source site) sent the full admin
// URL — query string included — to a third party, and nothing told a browser or proxy not to keep
// a copy of the rendered page.
//
// Same approach as tests/sms/preferences_headers.test.ts: the REAL next.config.mjs, matched with
// Next's OWN path matcher, so a hand-copied literal can never stand in for the rule it protects.
import { describe, expect, it } from 'vitest';

interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}
interface NextConfigLike {
  headers?: () => Promise<HeaderRule[]>;
}

async function loadConfig(): Promise<NextConfigLike> {
  const mod = (await import('../../next.config.mjs')) as unknown as {
    default?: NextConfigLike;
  } & NextConfigLike;
  return mod.default ?? mod;
}

async function headersFor(path: string): Promise<Map<string, string>> {
  const { pathToRegexp } = (await import('next/dist/compiled/path-to-regexp')) as {
    pathToRegexp: (source: string) => RegExp;
  };
  const config = await loadConfig();
  expect(typeof config.headers).toBe('function');
  const matched = new Map<string, string>();
  for (const rule of await config.headers!()) {
    if (pathToRegexp(rule.source).test(path)) {
      for (const h of rule.headers) matched.set(h.key.toLowerCase(), h.value);
    }
  }
  return matched;
}

const ADMIN_PATHS = [
  '/admin',
  '/admin/dashboard',
  '/admin/sms-subscribers',
  '/admin/sms-subscribers/00000000-0000-4000-8000-000000000000',
  '/admin/auth/signin',
  '/admin/auth/callback',
  '/api/admin/catalogue-cache/bust',
  '/api/admin/snapshot/refresh/run',
];

describe('admin routes carry privacy headers', () => {
  for (const path of ADMIN_PATHS) {
    it(`🔴 ${path}: no-referrer, no-store, noindex`, async () => {
      const h = await headersFor(path);
      expect(h.get('referrer-policy')).toBe('no-referrer');
      expect(h.get('cache-control')).toMatch(/\bno-store\b/);
      expect(h.get('x-robots-tag')).toMatch(/\bnoindex\b/);
    });
  }

  it('does not leak onto public routes (the rule is admin-scoped, not global)', async () => {
    for (const path of ['/', '/search', '/administrator', '/api/health', '/adminx']) {
      const h = await headersFor(path);
      expect(h.get('x-robots-tag'), path).toBeUndefined();
    }
  });
});
