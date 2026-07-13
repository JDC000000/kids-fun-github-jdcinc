// tests/search/route.test.ts — Search API route stub (G-T16-7).

import { describe, it, expect } from 'vitest';
import { GET } from '../../app/api/search/route';

async function call(qs: string) {
  const res = await GET(new Request(`http://localhost/api/search?${qs}`));
  return { res, body: await res.json() };
}

describe('GET /api/search (fixture stub)', () => {
  it('returns fixture-backed results for "open gym near me" with the data-source header', async () => {
    const { res, body } = await call('q=open+gym&lat=49.26&lng=-123.07&minResults=1');
    expect(res.headers.get('x-data-source')).toBe('fixture');
    expect(body.meta.fixtureBacked).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].listing.primaryCategoryKey).toBe('open_gym');
  });

  it('honours the sort control and region chips via query params', async () => {
    const { body } = await call('q=open+gym&lat=49.26&lng=-123.07&sort=distance&region=van&minResults=1');
    expect(body.meta.sort).toBe('distance');
    // region=van restricts to Vancouver-tagged listings
    expect(body.results.every((r: { listing: { municipalityId: string } }) => r.listing.municipalityId === 'van')).toBe(true);
  });

  it('does not invent a 0,0 near-me origin when lat/lng are omitted', async () => {
    const { body } = await call('q=open+gym&minResults=1');
    expect(body.origin).toBeNull();
    expect(body.originError).toBeNull();
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('returns an empty-state explanation when nothing matches in range', async () => {
    const { body } = await call('q=public+skate&lat=49.26&lng=-123.07&minResults=1');
    expect(body.broadening.emptyState).not.toBeNull();
    expect(body.broadening.applied.length).toBeGreaterThan(0);
  });

  it('falls back safely when database search is enabled but unavailable', async () => {
    const oldBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
    const oldDb = process.env.DATABASE_URL;
    process.env.KIDS_FUN_SEARCH_BACKEND = 'database';
    delete process.env.DATABASE_URL;
    try {
      const { res, body } = await call('q=open+gym&lat=49.26&lng=-123.07&minResults=1');
      expect(res.headers.get('x-data-source')).toBe('database-fallback-fixture');
      expect(body.meta.backend).toBe('fixture');
      expect(body.meta.fallbackReason).toBe('database search unavailable');
      expect(body.results.length).toBeGreaterThan(0);
    } finally {
      if (oldBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
      else process.env.KIDS_FUN_SEARCH_BACKEND = oldBackend;
      if (oldDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldDb;
    }
  });

});
