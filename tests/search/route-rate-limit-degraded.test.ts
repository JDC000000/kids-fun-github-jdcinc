// tests/search/route-rate-limit-degraded.test.ts — GET /api/search while the rate limiter's own
// counter table is DOWN (2026-09-24, C+D — lib/security/search-rate-limit-degraded.ts).
//
// The db seam is mocked (unit lane, no real SQL): `query` — the only thing the limiter uses —
// throws like an unreachable host, while the search itself runs on the fixture backend
// (KIDS_FUN_SEARCH_BACKEND unset). That is exactly the "limiter down, search still answers" case
// fail-open used to leave unprotected and a naive fail-closed would have broken for real parents.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  calls: [] as Array<{
    message: string;
    tags?: Record<string, string>;
    scope?: { fingerprint?: string[]; extra?: Record<string, unknown> };
  }>,
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => ({}),
  query: async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND db.example.supabase.co'), { code: 'ENOTFOUND' });
  },
}));

vi.mock('@/lib/observability/route-handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/observability/route-handler')>();
  return {
    ...actual,
    captureAndFlush: async (
      err: unknown,
      _flushTimeoutMs?: number,
      tags?: Record<string, string>,
      scope?: { fingerprint?: string[]; extra?: Record<string, unknown> }
    ) => {
      captured.calls.push({ message: err instanceof Error ? err.message : String(err), tags, scope });
    },
  };
});

import { GET } from '../../app/api/search/route';
import { ANON_SESSION_COOKIE } from '../../lib/db/session';
import { SEARCH_RATE_LIMITS } from '../../lib/security/search-rate-limit';
import { resetDefaultSearchRateLimitDegradedState } from '../../lib/security/search-rate-limit-degraded';

function request(ip: string, sessionId: string | null): Request {
  const headers: Record<string, string> = { accept: 'application/json', 'x-forwarded-for': ip };
  if (sessionId !== null) headers.cookie = `${ANON_SESSION_COOKIE}=${sessionId}`;
  return new Request('http://localhost/api/search?q=soft+play&minResults=0', { headers });
}

beforeEach(() => {
  captured.calls.length = 0;
  resetDefaultSearchRateLimitDegradedState();
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'route-degraded-test-salt');
  vi.stubEnv('KIDS_FUN_SEARCH_BACKEND', '');
  // 'performance' too: the report throttle runs on the monotonic clock (QA F5).
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 12, 0, 30)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /api/search while the limiter table is down', () => {
  it('🔴 serves real results under the limit, and refuses with 429 + Retry-After over it (memory fallback)', async () => {
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      const res = await GET(request('198.51.100.20', 'sess-degraded-1'));
      expect(res.status, `request ${i + 1}`).toBe(200);
      const body = (await res.json()) as { results?: unknown[]; rateLimit?: unknown };
      expect(Array.isArray(body.results)).toBe(true);
      // An in-memory count is not a measurement: nothing reaches analytics.
      expect(body.rateLimit).toBeUndefined();
    }
    const refused = await GET(request('198.51.100.20', 'sess-degraded-1'));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('60');
    expect(refused.headers.get('x-data-source')).toBe('rate-limited');
  });

  it('a different visitor is unaffected by someone else exhausting their fallback budget', async () => {
    for (let i = 0; i <= SEARCH_RATE_LIMITS.session.perMinute; i++) {
      await GET(request('198.51.100.21', 'sess-degraded-2'));
    }
    const other = await GET(request('198.51.100.22', 'sess-degraded-3'));
    expect(other.status).toBe(200);
  });

  it('reports db_error ONCE per minute per instance (not per request), with its own fingerprint and the cause', async () => {
    for (let i = 0; i < 8; i++) await GET(request('198.51.100.23', `sess-degraded-4-${i}`));
    expect(captured.calls).toHaveLength(1);
    const [call] = captured.calls;
    expect(call.message).toBe('search_rate_limit_degraded:db_error');
    expect(call.tags).toMatchObject({
      route: 'api/search',
      operation: 'check_search_rate_limit',
      degraded_reason: 'db_error',
      rate_limit_fallback: 'memory',
    });
    expect(call.scope?.fingerprint).toEqual(['search_rate_limit_degraded', 'db_error']);
    expect(String(call.scope?.extra?.cause)).toContain('ENOTFOUND');

    vi.advanceTimersByTime(61_000);
    await GET(request('198.51.100.23', 'sess-degraded-4-late'));
    expect(captured.calls).toHaveLength(2);
  });

  it('no_salt still fails open and is reported under its OWN fingerprint, never inside the db_error issue', async () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute + 3; i++) {
      const res = await GET(request('198.51.100.24', 'sess-degraded-5'));
      expect(res.status).toBe(200);
    }
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].message).toBe('search_rate_limit_degraded:no_salt');
    expect(captured.calls[0].scope?.fingerprint).toEqual(['search_rate_limit_degraded', 'no_salt']);
    expect(captured.calls[0].tags?.rate_limit_fallback).toBe('none');
  });
});
