// tests/analytics/route.test.ts — POST /api/analytics/event contract.
//
// Exercises validation + best-effort semantics WITHOUT a database: DATABASE_URL
// is unset for these calls, so the write helper swallows the failure and the
// route still returns 202 (analytics is never load-bearing). The malformed-input
// paths (400/413) prove a bad payload can never crash the endpoint.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '../../app/api/analytics/event/route';
import { MAX_ANALYTICS_PAYLOAD_BYTES } from '../../lib/analytics/types';

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  );
}

describe('POST /api/analytics/event', () => {
  let savedDbUrl: string | undefined;
  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL; // force the best-effort no-DB path
  });
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it('accepts a valid event (202) even when the DB write cannot happen', async () => {
    const res = await post(JSON.stringify({ eventType: 'listing_viewed' }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recorded).toBe(false); // no DB → best-effort write reported as not recorded
  });

  it('issues a stable anon cookie when the caller had none', async () => {
    const res = await post(JSON.stringify({ eventType: 'listing_viewed' }));
    expect(res.headers.get('set-cookie')).toMatch(/kf_anon_id=/);
  });

  it('rejects malformed JSON with 400 (does not crash)', async () => {
    const res = await post('{ this is not json');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown eventType with 400', async () => {
    const res = await post(JSON.stringify({ eventType: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized payload with 413', async () => {
    const huge = JSON.stringify({ eventType: 'listing_viewed', resultSummary: { b: 'x'.repeat(MAX_ANALYTICS_PAYLOAD_BYTES) } });
    const res = await post(huge);
    expect(res.status).toBe(413);
  });

  it('rejects an oversized declared content-length with 413 before reading', async () => {
    const res = await post(JSON.stringify({ eventType: 'listing_viewed' }), {
      'content-length': String(MAX_ANALYTICS_PAYLOAD_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });
});
