// tests/http/request-context.test.ts — lib/http/request-context.ts, in particular
// `forwardedIdentityHeaders`, the direct fix for the 2026-09-22 BLOCKER: app/search/page.tsx's
// internal `fetch()` to its own /api/search carried none of the real visitor's identity (no
// cookie jar on Node's fetch, no awareness of the inbound request), so
// lib/security/search-rate-limit.ts's session/IP identity read as "the server talking to
// itself" on the one path that actually matters. This file proves the fix in isolation — a pure
// function over `Headers` in, `HeadersInit` out — without needing to render app/search/page.tsx
// (which has no direct unit test; see lib/security/search-rate-limit.ts's and
// tests/search/route-rate-limit-db.test.ts's own tests for the enforcement side this feeds).
import { describe, expect, it } from 'vitest';
import { forwardedIdentityHeaders, readCookie } from '@/lib/http/request-context';

describe('forwardedIdentityHeaders', () => {
  it('forwards the cookie header verbatim when present', () => {
    const incoming = new Headers({ cookie: 'kf_anon_id=abc-123; other=xyz' });
    const out = forwardedIdentityHeaders(incoming) as Record<string, string>;
    expect(out.cookie).toBe('kf_anon_id=abc-123; other=xyz');
  });

  it('forwards x-forwarded-for verbatim (including the full chain — the callee re-parses it)', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    const out = forwardedIdentityHeaders(incoming) as Record<string, string>;
    expect(out['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.1');
  });

  it('forwards x-real-ip verbatim', () => {
    const incoming = new Headers({ 'x-real-ip': '203.0.113.7' });
    const out = forwardedIdentityHeaders(incoming) as Record<string, string>;
    expect(out['x-real-ip']).toBe('203.0.113.7');
  });

  it('🔴 forwards ALL THREE together — the exact shape of a real browser request to /search', async () => {
    // This is what the blocker looked like end to end: a real visitor's request to /search
    // carries all three; the pre-fix internal fetch to /api/search carried NONE of them.
    const incoming = new Headers({
      cookie: 'kf_anon_id=real-visitor-session',
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
    });
    const out = forwardedIdentityHeaders(incoming, { accept: 'application/json' }) as Record<string, string>;
    expect(out.cookie).toBe('kf_anon_id=real-visitor-session');
    expect(out['x-forwarded-for']).toBe('203.0.113.9');
    expect(out['x-real-ip']).toBe('203.0.113.9');
    expect(out.accept).toBe('application/json');
  });

  it('omits a header entirely when the incoming request did not have it, rather than forwarding an empty string', () => {
    const incoming = new Headers({ accept: 'text/html' }); // no cookie, no IP headers at all
    const out = forwardedIdentityHeaders(incoming, { accept: 'application/json' }) as Record<string, string>;
    expect('cookie' in out).toBe(false);
    expect('x-forwarded-for' in out).toBe(false);
    expect('x-real-ip' in out).toBe(false);
    // `extra` still wins/applies independent of what was or wasn't forwarded.
    expect(out.accept).toBe('application/json');
  });

  it('extra headers do not require any identity to be present', () => {
    const incoming = new Headers();
    const out = forwardedIdentityHeaders(incoming, { accept: 'application/json' }) as Record<string, string>;
    expect(out).toEqual({ accept: 'application/json' });
  });
});

describe('readCookie', () => {
  it('reads the named cookie out of a multi-cookie header', () => {
    const req = new Request('http://localhost/', { headers: { cookie: 'a=1; kf_anon_id=xyz; b=2' } });
    expect(readCookie(req, 'kf_anon_id')).toBe('xyz');
  });

  it('returns undefined when the cookie header is absent', () => {
    const req = new Request('http://localhost/');
    expect(readCookie(req, 'kf_anon_id')).toBeUndefined();
  });

  it('returns undefined when the named cookie is absent from a present header', () => {
    const req = new Request('http://localhost/', { headers: { cookie: 'a=1; b=2' } });
    expect(readCookie(req, 'kf_anon_id')).toBeUndefined();
  });

  it('decodes a percent-encoded value', () => {
    const req = new Request('http://localhost/', { headers: { cookie: 'kf_anon_id=a%20b' } });
    expect(readCookie(req, 'kf_anon_id')).toBe('a b');
  });
});
