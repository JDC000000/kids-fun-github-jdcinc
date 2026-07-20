// tests/health/policy.test.ts — G-T15-5 runtime terms/robots/crawl policy enforcement ‹L3›.
//  • terms/robots gate: a source with missing/disallowed terms does NOT run in production.
//  • crawl politeness is REALLY wired: politeFetch sends an identified UA + conditional
//    headers, rate-limits per source, and a 403/429 backoff blocks the NEXT fetch entirely.
//  • integration: runTermsGatedIngest in production refuses a disallowed source with no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateSourcePolicy,
  assertLiveFetchAllowed,
  politeFetch,
  guardedLiveFetch,
  clearPolicyState,
  PolicyViolationError,
  USER_AGENT,
} from '../../worker/health/policy';
import { runTermsGatedIngest } from '../../worker/core/source-runner';
import { query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

afterEach(() => {
  clearPolicyState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('terms/robots runtime gate (fail-closed)', () => {
  const allowed = { id: 's1', termsStatus: 'allowed', robotsStatus: 'allowed' };
  it('production requires an explicit allowed/summarise_only + robots allowed', () => {
    expect(evaluateSourcePolicy(allowed, 'production').allowed).toBe(true);
    expect(evaluateSourcePolicy({ ...allowed, termsStatus: 'summarise_only' }, 'production').allowed).toBe(true);
  });
  it('blocks pending / disallowed / blocked / robots-disallowed in production', () => {
    for (const termsStatus of ['pending', 'disallowed', 'blocked', 'unknown']) {
      expect(evaluateSourcePolicy({ ...allowed, termsStatus }, 'production').allowed, termsStatus).toBe(false);
    }
    expect(evaluateSourcePolicy({ ...allowed, robotsStatus: 'disallowed' }, 'production').allowed).toBe(false);
    expect(evaluateSourcePolicy({ ...allowed, robotsStatus: 'pending' }, 'production').allowed).toBe(false);
  });
  it('assertLiveFetchAllowed throws PolicyViolationError only when blocked', () => {
    expect(() => assertLiveFetchAllowed(allowed, 'production')).not.toThrow();
    expect(() => assertLiveFetchAllowed({ ...allowed, termsStatus: 'pending' }, 'production')).toThrow(PolicyViolationError);
  });
});

describe('politeFetch crawl-politeness (wired primitives)', () => {
  it('sends an identified UA + conditional headers under caller headers', async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sentHeaders = init?.headers ?? {};
      return new Response('[]', { status: 200 });
    });
    await politeFetch(
      'k1',
      'https://example.org/feed',
      { headers: { accept: 'application/json' } },
      { fetchImpl: fetchImpl as unknown as typeof fetch, prevCache: { etag: 'W/"x"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' } }
    );
    expect(sentHeaders['User-Agent']).toBe(USER_AGENT);
    expect(sentHeaders['User-Agent']).toMatch(/KidsFunBot/i);
    expect(sentHeaders.accept).toBe('application/json');
    expect(sentHeaders['If-None-Match']).toBe('W/"x"');
    expect(sentHeaders['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('rate-limits repeated same-source requests (per-source minimum interval)', async () => {
    let clock = 0;
    const now = (): number => clock;
    const slept: number[] = [];
    const sleepImpl = async (ms: number): Promise<void> => {
      slept.push(ms);
      clock += ms;
    };
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const opts = { requestsPerMinute: 60, now, sleepImpl, fetchImpl }; // 1000ms floor
    await politeFetch('rl', 'https://example.org', {}, opts);
    await politeFetch('rl', 'https://example.org', {}, opts);
    expect(slept).toEqual([1000]);
  });

  it('a 429 backoff blocks the very next fetch — no network call', async () => {
    const first = vi.fn(async () => new Response('', { status: 429 }));
    await politeFetch('bo', 'https://example.org', {}, { fetchImpl: first });
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn(async () => new Response('', { status: 200 }));
    await expect(politeFetch('bo', 'https://example.org', {}, { fetchImpl: second })).rejects.toBeInstanceOf(
      PolicyViolationError
    );
    expect(second).not.toHaveBeenCalled();
  });

  it('guardedLiveFetch refuses a blocked source WITHOUT touching the network', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      guardedLiveFetch({ id: 's', termsStatus: 'disallowed', robotsStatus: 'allowed' }, 'production', 'k', 'https://x', {}, { fetchImpl })
    ).rejects.toBeInstanceOf(PolicyViolationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a disallowed source does not run (integration, no DB)', () => {
  it('runTermsGatedIngest in production refuses a disallowed source and never fetches', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'src-x',
            family: 'library_bibliocommons',
            name: 'Richmond Public Library BiblioEvents',
            terms_status: 'disallowed',
            robots_status: 'allowed',
          },
        ],
      })),
    };
    const result = await runTermsGatedIngest(pool as never, { id: 'src-x' }, 'production');
    expect(result.ok).toBe(false);
    expect(result.gate.allowed).toBe(false);
    expect(result.error).toMatch(/production blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasDb)('a pending seeded source does not run in production (integration, DB)', () => {
  afterEach(async () => {
    // nothing to clean; we only read seeded rows.
  });
  it('refuses a real seeded (terms pending) source in production without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const [src] = await query<{ id: string }>(
      `SELECT id FROM source WHERE family = 'library_bibliocommons' AND name = 'Richmond Public Library BiblioEvents' LIMIT 1`
    );
    // getPool() shares the module pool; use it via runTermsGatedIngest which reads its own pool.
    const { getPool } = await import('../../lib/db/client');
    const result = await runTermsGatedIngest(getPool(), { id: src.id }, 'production');
    expect(result.ok).toBe(false);
    expect(result.gate.allowed).toBe(false);
    expect(result.error).toMatch(/production blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
    await closePool();
  });
});
