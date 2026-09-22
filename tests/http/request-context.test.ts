// tests/http/request-context.test.ts — lib/http/request-context.ts, in particular
// `forwardedIdentityHeaders`, the direct fix for the 2026-09-22 BLOCKER: app/search/page.tsx's
// internal `fetch()` to its own /api/search carried none of the real visitor's identity (no
// cookie jar on Node's fetch, no awareness of the inbound request), so
// lib/security/search-rate-limit.ts's session/IP identity read as "the server talking to
// itself" on the one path that actually matters. This file proves the fix in isolation — a pure
// function over `Headers` in, `HeadersInit` out — without needing to render app/search/page.tsx
// (see tests/search/page-rate-limit-identity.test.ts for that integration level, and
// tests/search/route-rate-limit-db.test.ts for the enforcement side this feeds).
import { describe, expect, it } from 'vitest';
import { forwardedIdentityHeaders, readCookie } from '@/lib/http/request-context';

const SESSION_COOKIE = 'kf_anon_id';

describe('forwardedIdentityHeaders', () => {
  it('forwards ONLY the named session cookie, re-encoded, never the whole jar', () => {
    // 🟠 F2 (2026-09-22 independent recheck): the whole raw `cookie` header used to be forwarded
    // verbatim — including any OTHER cookie present (an admin/auth session, say). This asserts
    // the fix directly: `other` must never appear anywhere in the output.
    const incoming = new Headers({ cookie: `${SESSION_COOKIE}=abc-123; other=super-secret-admin-session` });
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE) as Record<string, string>;
    expect(out.cookie).toBe(`${SESSION_COOKIE}=abc-123`);
    expect(out.cookie).not.toContain('other');
    expect(out.cookie).not.toContain('super-secret-admin-session');
  });

  it('re-encodes a value that needs it, rather than forwarding raw bytes that could break the header', () => {
    const incoming = new Headers({ cookie: `${SESSION_COOKIE}=a b` }); // space, decodes cleanly, re-encodes on the way out
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE) as Record<string, string>;
    expect(out.cookie).toBe(`${SESSION_COOKIE}=a%20b`);
  });

  it('forwards x-forwarded-for verbatim (including the full chain — the callee re-parses it)', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE) as Record<string, string>;
    expect(out['x-forwarded-for']).toBe('203.0.113.7, 10.0.0.1');
  });

  it('forwards x-real-ip verbatim', () => {
    const incoming = new Headers({ 'x-real-ip': '203.0.113.7' });
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE) as Record<string, string>;
    expect(out['x-real-ip']).toBe('203.0.113.7');
  });

  it('🔴 forwards the session cookie AND both IP headers together — the exact shape of a real browser request to /search', () => {
    // This is what the blocker looked like end to end: a real visitor's request to /search
    // carries all three; the pre-fix internal fetch to /api/search carried NONE of them.
    const incoming = new Headers({
      cookie: `${SESSION_COOKIE}=real-visitor-session`,
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
    });
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE, { accept: 'application/json' }) as Record<string, string>;
    expect(out.cookie).toBe(`${SESSION_COOKIE}=real-visitor-session`);
    expect(out['x-forwarded-for']).toBe('203.0.113.9');
    expect(out['x-real-ip']).toBe('203.0.113.9');
    expect(out.accept).toBe('application/json');
  });

  it('omits a header entirely when the incoming request did not have it, rather than forwarding an empty string', () => {
    const incoming = new Headers({ accept: 'text/html' }); // no cookie, no IP headers at all
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE, { accept: 'application/json' }) as Record<string, string>;
    expect('cookie' in out).toBe(false);
    expect('x-forwarded-for' in out).toBe(false);
    expect('x-real-ip' in out).toBe(false);
    // `extra` still wins/applies independent of what was or wasn't forwarded.
    expect(out.accept).toBe('application/json');
  });

  it('omits cookie when the header is present but does not carry the named cookie', () => {
    const incoming = new Headers({ cookie: 'other=xyz' });
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE) as Record<string, string>;
    expect('cookie' in out).toBe(false);
  });

  it('🔴 does not throw on a malformed cookie value — degrades to "no cookie", never a 500 (F1)', () => {
    const incoming = new Headers({ cookie: `${SESSION_COOKIE}=%` }); // invalid percent-encoding
    expect(() => forwardedIdentityHeaders(incoming, SESSION_COOKIE)).not.toThrow();
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE) as Record<string, string>;
    expect('cookie' in out).toBe(false);
  });

  it('extra headers do not require any identity to be present', () => {
    const incoming = new Headers();
    const out = forwardedIdentityHeaders(incoming, SESSION_COOKIE, { accept: 'application/json' }) as Record<string, string>;
    expect(out).toEqual({ accept: 'application/json' });
  });
});

describe('readCookie', () => {
  it('reads the named cookie out of a multi-cookie header', () => {
    const req = new Request('http://localhost/', { headers: { cookie: 'a=1; kf_anon_id=xyz; b=2' } });
    expect(readCookie(req.headers, 'kf_anon_id')).toBe('xyz');
  });

  it('returns undefined when the cookie header is absent', () => {
    const req = new Request('http://localhost/');
    expect(readCookie(req.headers, 'kf_anon_id')).toBeUndefined();
  });

  it('returns undefined when the named cookie is absent from a present header', () => {
    const req = new Request('http://localhost/', { headers: { cookie: 'a=1; b=2' } });
    expect(readCookie(req.headers, 'kf_anon_id')).toBeUndefined();
  });

  it('decodes a percent-encoded value', () => {
    const req = new Request('http://localhost/', { headers: { cookie: 'kf_anon_id=a%20b' } });
    expect(readCookie(req.headers, 'kf_anon_id')).toBe('a b');
  });

  it('works from next/headers-shaped Headers too, not just Request.headers', () => {
    // The whole point of the Request -> Headers signature change: the same function must serve
    // both app/api/search/route.ts's `request.headers` AND app/search/page.tsx's `headers()`.
    const h = new Headers({ cookie: 'kf_anon_id=from-next-headers' });
    expect(readCookie(h, 'kf_anon_id')).toBe('from-next-headers');
  });

  // 🔴 F1 (2026-09-22 independent recheck): decodeURIComponent was UNGUARDED here. A bare `%`,
  // a truncated percent-sequence, or any other malformed encoding threw uncaught, 500ing the
  // whole request — a direct violation of the rate limiter's own "never throws" invariant one
  // call up the stack, since it never even got the chance to run.
  it.each([
    ['a lone percent sign', 'kf_anon_id=%'],
    ['an unencoded percent sign in an otherwise plain value (not even an attack)', 'kf_anon_id=100%off'],
    ['a truncated percent-sequence', 'kf_anon_id=%2'],
    ['an invalid hex digit after %', 'kf_anon_id=%zz'],
  ])('🔴 does not throw on a malformed cookie value: %s', (_label, cookieHeader) => {
    const req = new Request('http://localhost/', { headers: { cookie: cookieHeader } });
    expect(() => readCookie(req.headers, 'kf_anon_id')).not.toThrow();
    // Malformed => treated as absent, exactly like no cookie at all.
    expect(readCookie(req.headers, 'kf_anon_id')).toBeUndefined();
  });
});
