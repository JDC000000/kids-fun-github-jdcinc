// tests/llm/route.test.ts — POST /api/llm/batch/run auth + safety contract.
// Fails closed unconfigured (503), rejects bad secret (401), rejects bad JSON (400). The
// authorized path is detection-only (dry-run) because LLM_BATCH_ENABLED is unset — it makes
// NO API call and NO write beyond run-stats, so CI runs with zero network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '../../app/api/llm/batch/run/route';

const SECRET = 'test-llm-batch-secret';
const hasDb = Boolean(process.env.DATABASE_URL);

function post(body = '{}', headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/llm/batch/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  );
}

describe('POST /api/llm/batch/run', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['LLM_BATCH_CRON_SECRET', 'LLM_BATCH_ENABLED', 'LLM_BATCH_DRY_RUN'];
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('fails closed with 503 when the secret is not configured', async () => {
    expect((await post('{}', { 'x-cron-secret': 'anything' })).status).toBe(503);
  });

  it('rejects a missing/wrong secret with 401', async () => {
    process.env.LLM_BATCH_CRON_SECRET = SECRET;
    expect((await post('{}')).status).toBe(401);
    expect((await post('{}', { 'x-cron-secret': 'wrong' })).status).toBe(401);
    expect((await post('{}', { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('rejects malformed JSON with 400 (authorized)', async () => {
    process.env.LLM_BATCH_CRON_SECRET = SECRET;
    expect((await post('{ not json', { 'x-cron-secret': SECRET })).status).toBe(400);
  });

  it.skipIf(!hasDb)('runs detection-only (dry-run) with a valid bearer secret (200, no API call)', async () => {
    process.env.LLM_BATCH_CRON_SECRET = SECRET;
    const res = await post('{}', { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.enabled).toBe(false);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(2);
  });

  it.skipIf(!hasDb)('honours a useCases filter', async () => {
    process.env.LLM_BATCH_CRON_SECRET = SECRET;
    const res = await post(JSON.stringify({ useCases: ['age'] }), { 'x-cron-secret': SECRET });
    const body = await res.json();
    expect(body.results.map((r: { useCase: string }) => r.useCase)).toEqual(['age']);
  });
});
