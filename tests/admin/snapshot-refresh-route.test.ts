// tests/admin/snapshot-refresh-route.test.ts — POST /api/admin/snapshot/refresh/run.
//
// The auth + input contract. This endpoint is cheap to call and expensive to serve (up to ~3
// minutes of database work against the instance that also serves the product), so an
// unauthenticated or un-validated path here is a free load-amplification lever. Same shape as
// tests/analytics/retention-route.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshAllSnapshots = vi.fn();
vi.mock('@/lib/admin/snapshot-refresh', () => ({
  refreshAllSnapshots: (...args: unknown[]) => refreshAllSnapshots(...args),
}));

const routeModule = await import('../../app/api/admin/snapshot/refresh/run/route');
const { POST } = routeModule;
const { ADMIN_SNAPSHOT_KEYS, ALL_ADMIN_SNAPSHOT_KEYS } = await import('../../lib/admin/snapshot');

const SECRET = 'test-snapshot-secret';

function post(body = '{}', headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/admin/snapshot/refresh/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  );
}

const ok = (over: Record<string, unknown> = {}) => ({
  refreshed: 4,
  failed: 0,
  totalMs: 1234,
  sourceRows: 2_965_374,
  results: [],
  ...over,
});

describe('POST /api/admin/snapshot/refresh/run', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ADMIN_SNAPSHOT_CRON_SECRET;
    delete process.env.ADMIN_SNAPSHOT_CRON_SECRET;
    refreshAllSnapshots.mockReset();
    refreshAllSnapshots.mockResolvedValue(ok());
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_SNAPSHOT_CRON_SECRET;
    else process.env.ADMIN_SNAPSHOT_CRON_SECRET = saved;
  });

  it('fails closed with 503 when the secret is not configured', async () => {
    const res = await post('{}', { 'x-cron-secret': 'anything' });
    expect(res.status).toBe(503);
    expect(refreshAllSnapshots).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong secret with 401, without doing the work', async () => {
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    expect((await post('{}')).status).toBe(401);
    expect((await post('{}', { 'x-cron-secret': 'wrong' })).status).toBe(401);
    expect((await post('{}', { authorization: 'Bearer nope' })).status).toBe(401);
    // A secret that merely SHARES A PREFIX must not pass. timingSafeEqual throws on a length
    // mismatch, so the length pre-check is load-bearing, not an optimisation.
    expect((await post('{}', { 'x-cron-secret': SECRET.slice(0, 5) })).status).toBe(401);
    expect((await post('{}', { 'x-cron-secret': `${SECRET}x` })).status).toBe(401);
    expect(refreshAllSnapshots).not.toHaveBeenCalled();
  });

  it('accepts the secret as a bearer token or as x-cron-secret', async () => {
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    expect((await post('{}', { 'x-cron-secret': SECRET })).status).toBe(200);
    expect((await post('{}', { authorization: `Bearer ${SECRET}` })).status).toBe(200);
  });

  it('rejects malformed JSON with 400 (authorized)', async () => {
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    const res = await post('{not json', { 'x-cron-secret': SECRET });
    expect(res.status).toBe(400);
    expect(refreshAllSnapshots).not.toHaveBeenCalled();
  });

  it('treats an empty body as "refresh everything"', async () => {
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    const res = await POST(
      new Request('http://localhost/api/admin/snapshot/refresh/run', {
        method: 'POST',
        headers: { 'x-cron-secret': SECRET },
      })
    );
    expect(res.status).toBe(200);
    expect(refreshAllSnapshots).toHaveBeenCalledWith(ALL_ADMIN_SNAPSHOT_KEYS);
  });

  it('passes an explicit key subset through', async () => {
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    refreshAllSnapshots.mockResolvedValue(ok({ refreshed: 1 }));
    const res = await post(JSON.stringify({ keys: [ADMIN_SNAPSHOT_KEYS.dashboard] }), {
      'x-cron-secret': SECRET,
    });
    expect(res.status).toBe(200);
    expect(refreshAllSnapshots).toHaveBeenCalledWith([ADMIN_SNAPSHOT_KEYS.dashboard]);
  });

  it('REJECTS an unknown key rather than silently skipping it', async () => {
    // A scheduler typo that returns 200 looks like a dashboard that refreshed. It did not.
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    for (const keys of [['operating:day:7'], ['dashboard', 'nope'], [], 'dashboard', 42]) {
      const res = await post(JSON.stringify({ keys }), { 'x-cron-secret': SECRET });
      expect(res.status, JSON.stringify(keys)).toBe(400);
    }
    expect(refreshAllSnapshots).not.toHaveBeenCalled();
  });

  it('reports a PARTIAL refresh as a failure status, not as success', async () => {
    // refreshAllSnapshots never throws (it isolates keys), so the status code is the only
    // signal a scheduler sees. 200 for "built 1 of 4" would make a broken dashboard invisible.
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    refreshAllSnapshots.mockResolvedValue(
      ok({ refreshed: 3, failed: 1, results: [{ key: 'dashboard', ok: false, computeMs: 9, error: 'x' }] })
    );
    const res = await post('{}', { 'x-cron-secret': SECRET });
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it('exports POST ONLY — no GET handler, deliberately', () => {
    // ═══ DO NOT "FIX" A 405 BY ADDING A GET HANDLER ═══
    // QA found the trap this pins (2026-09-18): Vercel Cron issues GET, so wiring this endpoint
    // to it yields 405 and the refresh silently never runs — the pages go on serving an ageing
    // snapshot behind an honest-but-stale "as of" line, which is a failure mode nobody watching
    // the dashboards would notice. The obvious repair is to add a GET handler here. That is the
    // wrong repair: this route does ~3 minutes of database work and writes a table, which has no
    // business being reachable by a method the whole web treats as safe, cacheable and
    // prefetchable. The right repair is a POST-issuing scheduler (or a shim in front).
    expect(typeof routeModule.POST).toBe('function');
    expect('GET' in routeModule).toBe(false);
    // Nor any other method: the surface is POST plus Next's route config exports, nothing more.
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(routeModule, `${method} must not be exported`).not.toHaveProperty(method);
    }
  });

  it('returns counts and timings only — never payload contents', async () => {
    process.env.ADMIN_SNAPSHOT_CRON_SECRET = SECRET;
    const res = await post('{}', { 'x-cron-secret': SECRET });
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['failed', 'ok', 'refreshed', 'results', 'sourceRows', 'totalMs'].sort()
    );
    expect(JSON.stringify(body)).not.toMatch(/payload/);
  });
});
