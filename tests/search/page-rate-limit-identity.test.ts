// tests/search/page-rate-limit-identity.test.ts — the /search PAGE's own request to
// /api/search, specifically testing the identity it carries.
//
// ═══ WHY THIS FILE EXISTS ═══
// Both 2026-09-22 reviews independently landed on the same observation about test COVERAGE, not
// just the bug: every existing test — tests/search/route.test.ts,
// tests/search/route-db-no-fixture-leak.test.ts, tests/search/route-rate-limit-db.test.ts, all of
// tests/security/search-rate-limit.test.ts — calls GET /api/search directly. None of them ever
// exercised app/search/page.tsx's OWN request construction, which is exactly where the identity
// (cookie + client IP) was silently lost: the original version made a real `fetch()` with a bare
// `{ accept: ... }` header set, indistinguishable, on the receiving end, from the server talking
// to itself. A live-server reproduction (2026-09-22 QA) confirmed the exact failure mode this
// predicts: 30 requests with one cookie + one IP, all served 200, zero 429s, and
// `search_rate_limit` held only ip_* rows — never a session_* row — because the cookie genuinely
// never left this function.
//
// ═══ F7 (2026-09-22 independent recheck) CHANGED WHAT THIS FILE MOCKS, NOT WHAT IT PROVES ═══
// runSearch no longer makes a real `fetch()` at all — it calls app/api/search/route.ts's own
// exported `GET` directly, in-process, to remove the network hop F7 flagged as an unverified risk
// (a fronting layer could overwrite the forwarded IP on the way back in). So this file mocks THAT
// import instead of `global.fetch`, and asserts on the real `Request` object `runSearch` builds —
// if anything, a more direct check than before, since a `Request`'s `.headers` is inspected
// straight from the object `searchGet` itself would receive, with no serialisation in between.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({
  headers: () => mockHeaders.current,
  cookies: () => ({ get: () => undefined, set: () => {} }),
}));

const mockSearchApiGet = vi.hoisted(() => vi.fn());
vi.mock('@/app/api/search/route', () => ({
  GET: (...args: unknown[]) => mockSearchApiGet(...args),
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

describe('app/search/page.tsx runSearch — the in-process Request it builds for /api/search', () => {
  beforeEach(() => {
    mockSearchApiGet.mockReset();
    mockSearchApiGet.mockResolvedValue(jsonResponse(EMPTY_SEARCH_BODY));
  });

  afterEach(() => {
    mockHeaders.current = new Headers();
  });

  function sentRequest(): Request {
    expect(mockSearchApiGet, 'runSearch must call the search route exactly once').toHaveBeenCalledTimes(1);
    const [req] = mockSearchApiGet.mock.calls[0] as [Request];
    return req;
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

    const sent = sentRequest();
    expect(sent.headers.get('cookie')).toBe('kf_anon_id=visitor-a-session');
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.11');
  });

  it('🔴 a second visitor gets their OWN cookie and IP forwarded — not the first visitor, and not the server', async () => {
    mockHeaders.current = new Headers({
      host: 'kidsfunapp.ca',
      cookie: 'kf_anon_id=visitor-b-session',
      'x-forwarded-for': '203.0.113.22',
    });
    const state = parseSearchState({ q: 'storytime' });
    await runSearch(state, null);

    const sent = sentRequest();
    expect(sent.headers.get('cookie')).toBe('kf_anon_id=visitor-b-session');
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.22');
    // Nothing from a hypothetical "visitor A" (or a previous call) leaks in — each call reads
    // ONLY the headers() this invocation was given, proving there is no shared/cached identity
    // sitting between page renders (the exact shared-bucket failure mode the live QA
    // reproduction measured: visitors 5-8 of 8 real visitors erased from a 30-day KPI window).
    expect(sent.headers.get('cookie')).not.toBe('kf_anon_id=visitor-a-session');
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

    const sent = sentRequest();
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.33');
    expect(sent.headers.has('cookie')).toBe(false);
  });

  it('still sends `accept: application/json` alongside the forwarded identity', async () => {
    mockHeaders.current = new Headers({ host: 'kidsfunapp.ca', cookie: 'kf_anon_id=x' });
    const state = parseSearchState({ q: 'open gym' });
    await runSearch(state, null);
    expect(sentRequest().headers.get('accept')).toBe('application/json');
  });

  // 🔴 F7 (2026-09-22 independent recheck): THE FIX ITSELF — no network call happens at all.
  it('🔴 never touches global fetch — the whole point of removing the network hop', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockHeaders.current = new Headers({ cookie: 'kf_anon_id=x', 'x-forwarded-for': '203.0.113.1' });
    const state = parseSearchState({ q: 'open gym' });
    await runSearch(state, null);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
