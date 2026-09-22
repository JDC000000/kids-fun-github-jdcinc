// tests/search/page-rate-limit-identity.test.ts — the /search PAGE's own request to
// /api/search, specifically testing the identity it carries.
//
// ═══ WHY THIS FILE EXISTS ═══
// Both 2026-09-22 reviews independently landed on the same observation about test COVERAGE, not
// just the bug: every existing test — tests/search/route.test.ts,
// tests/search/route-db-no-fixture-leak.test.ts, tests/search/route-rate-limit-db.test.ts, all of
// tests/security/search-rate-limit.test.ts — calls GET /api/search directly. None of them ever
// exercised app/search/page.tsx's OWN internal fetch, which is exactly where the identity
// (cookie + client IP) was silently lost before the `forwardedIdentityHeaders` fix: Node's
// `fetch()` has no cookie jar and no idea what request it is running inside of, so a plain
// `fetch(url, { headers: { accept: ... } })` made this call indistinguishable, on the receiving
// end, from the server talking to itself. A live-server reproduction (2026-09-22 QA) confirmed the
// exact failure mode this predicts: 30 requests with one cookie + one IP, all served 200, zero
// 429s, and `search_rate_limit` held only ip_* rows — never a session_* row — because the cookie
// genuinely never left this function.
//
// This file drives `runSearch` (exported from app/search/page.tsx FOR THIS TEST ONLY) with a
// mocked `next/headers` and a spied `fetch`, and asserts on the ACTUAL headers the outgoing
// request carries — the one thing the bug class was invisible to every other test in this repo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({
  headers: () => mockHeaders.current,
  cookies: () => ({ get: () => undefined, set: () => {} }),
}));

const { runSearch } = await import('../../app/search/page');
const { parseSearchState } = await import('../../app/search/_lib/params');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const EMPTY_SEARCH_BODY = {
  results: [],
  meta: { fixtureBacked: true, sort: 'best_match' },
  origin: null,
  originError: null,
  expected: [],
};

describe('app/search/page.tsx runSearch — forwards the REAL visitor identity to /api/search', () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<[input: string | URL | Request, init: RequestInit | undefined]>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push([input, init]);
      return Promise.resolve(jsonResponse(EMPTY_SEARCH_BODY));
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockHeaders.current = new Headers();
  });

  function outgoingRequestHeaders(): Headers {
    const call = calls[0];
    expect(call, 'runSearch must call fetch exactly once').toBeDefined();
    return new Headers(call![1]?.headers);
  }

  it('🔴 forwards a real visitor cookie and IP — the blocker this test guards', async () => {
    mockHeaders.current = new Headers({
      host: 'kidsfunapp.ca',
      'x-forwarded-proto': 'https',
      cookie: 'kf_anon_id=visitor-a-session',
      'x-forwarded-for': '203.0.113.11',
    });
    const state = parseSearchState({ q: 'soft play' });
    await runSearch(state, null);

    const sent = outgoingRequestHeaders();
    expect(sent.get('cookie')).toBe('kf_anon_id=visitor-a-session');
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.11');
  });

  it('🔴 a second visitor gets their OWN cookie and IP forwarded — not the first visitor, and not the server', async () => {
    mockHeaders.current = new Headers({
      host: 'kidsfunapp.ca',
      cookie: 'kf_anon_id=visitor-b-session',
      'x-forwarded-for': '203.0.113.22',
    });
    const state = parseSearchState({ q: 'storytime' });
    await runSearch(state, null);

    const sent = outgoingRequestHeaders();
    expect(sent.get('cookie')).toBe('kf_anon_id=visitor-b-session');
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.22');
    // Nothing from a hypothetical "visitor A" (or a previous call) leaks in — each call reads
    // ONLY the headers() this invocation was given, proving there is no shared/cached identity
    // sitting between page renders (the exact shared-bucket failure mode the live QA
    // reproduction measured: visitors 5-8 of 8 real visitors erased from a 30-day KPI window).
    expect(sent.get('cookie')).not.toBe('kf_anon_id=visitor-a-session');
  });

  it('forwards IP only, with no cookie key at all, for a visitor whose request genuinely has none', async () => {
    // The other real case (not just the bug): a brand-new visitor whose /search request arrived
    // WITHOUT a kf_anon_id cookie in the first place (middleware.ts mints one on the response,
    // not retroactively on this request). The IP must still travel; the cookie header must be
    // absent, not an empty string (an empty cookie header is not "no identity", it is a
    // different, wrong subject).
    mockHeaders.current = new Headers({ host: 'kidsfunapp.ca', 'x-forwarded-for': '203.0.113.33' });
    const state = parseSearchState({ q: 'family swim' });
    await runSearch(state, null);

    const sent = outgoingRequestHeaders();
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.33');
    expect(sent.has('cookie')).toBe(false);
  });

  it('still sends `accept: application/json` alongside the forwarded identity', async () => {
    mockHeaders.current = new Headers({ host: 'kidsfunapp.ca', cookie: 'kf_anon_id=x' });
    const state = parseSearchState({ q: 'open gym' });
    await runSearch(state, null);
    expect(outgoingRequestHeaders().get('accept')).toBe('application/json');
  });
});
