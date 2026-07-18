// tests/analytics/retention-route.test.ts — POST /api/analytics/retention/run.
//
// Auth + safety contract (no deletion happens here — the DB-backed paths use
// dry-run). Proves: fails closed when unconfigured (503), rejects a bad secret
// (401), rejects malformed JSON (400), and honours the dry-run kill-switch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '../../app/api/analytics/retention/run/route';

const SECRET = 'test-retention-secret';
const hasDb = Boolean(process.env.DATABASE_URL);

function post(body = '{}', headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/analytics/retention/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  );
}

describe('POST /api/analytics/retention/run', () => {
  let savedSecret: string | undefined;
  let savedDryRun: string | undefined;
  beforeEach(() => {
    savedSecret = process.env.ANALYTICS_RETENTION_CRON_SECRET;
    savedDryRun = process.env.ANALYTICS_RETENTION_DRY_RUN;
    delete process.env.ANALYTICS_RETENTION_CRON_SECRET;
    delete process.env.ANALYTICS_RETENTION_DRY_RUN;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.ANALYTICS_RETENTION_CRON_SECRET;
    else process.env.ANALYTICS_RETENTION_CRON_SECRET = savedSecret;
    if (savedDryRun === undefined) delete process.env.ANALYTICS_RETENTION_DRY_RUN;
    else process.env.ANALYTICS_RETENTION_DRY_RUN = savedDryRun;
  });

  it('fails closed with 503 when the secret is not configured', async () => {
    const res = await post('{}', { 'x-cron-secret': 'anything' });
    expect(res.status).toBe(503);
  });

  it('rejects a missing/wrong secret with 401', async () => {
    process.env.ANALYTICS_RETENTION_CRON_SECRET = SECRET;
    expect((await post('{}')).status).toBe(401);
    expect((await post('{}', { 'x-cron-secret': 'wrong' })).status).toBe(401);
    expect((await post('{}', { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('rejects malformed JSON with 400 (authorized)', async () => {
    process.env.ANALYTICS_RETENTION_CRON_SECRET = SECRET;
    const res = await post('{ not json', { 'x-cron-secret': SECRET });
    expect(res.status).toBe(400);
  });

  it.skipIf(!hasDb)('runs a dry-run with a valid bearer secret (200, deletes nothing)', async () => {
    process.env.ANALYTICS_RETENTION_CRON_SECRET = SECRET;
    const res = await post(JSON.stringify({ dryRun: true }), { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.deleted).toBe(0);
    expect(typeof body.retentionDays).toBe('number');
  });

  it.skipIf(!hasDb)('the ANALYTICS_RETENTION_DRY_RUN kill-switch forces dry-run', async () => {
    process.env.ANALYTICS_RETENTION_CRON_SECRET = SECRET;
    process.env.ANALYTICS_RETENTION_DRY_RUN = 'true';
    // Caller does NOT ask for dry-run, but the env kill-switch forces it.
    const res = await post('{}', { 'x-cron-secret': SECRET });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.deleted).toBe(0);
  });
});
