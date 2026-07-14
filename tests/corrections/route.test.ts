// tests/corrections/route.test.ts — POST /api/corrections contract.
//
// Exercises validation + best-effort semantics WITHOUT a database: DATABASE_URL is
// unset for these calls, so the write helper swallows the failure and the route still
// returns 202 (a correction must never crash the detail page). The malformed-input
// paths (400/413) prove a bad payload can never crash the endpoint.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '../../app/api/corrections/route';
import { MAX_CORRECTION_PAYLOAD_BYTES } from '../../lib/corrections/types';

const OCC = '11111111-1111-1111-1111-111111111111';

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/corrections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  );
}

describe('POST /api/corrections', () => {
  let savedDbUrl: string | undefined;
  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL; // force the best-effort no-DB path
  });
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it('accepts a valid report (202) even when the DB write cannot happen', async () => {
    const res = await post(JSON.stringify({ occurrenceId: OCC, note: 'time is wrong' }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recorded).toBe(false); // no DB → best-effort write reported as not recorded
  });

  it('issues a stable anon cookie when the caller had none', async () => {
    const res = await post(JSON.stringify({ occurrenceId: OCC }));
    expect(res.headers.get('set-cookie')).toMatch(/kf_anon_id=/);
  });

  it('does not reissue a cookie when a valid anon id is already present', async () => {
    const res = await post(JSON.stringify({ occurrenceId: OCC }), { cookie: `kf_anon_id=${OCC}` });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects malformed JSON with 400 (does not crash)', async () => {
    const res = await post('{ this is not json');
    expect(res.status).toBe(400);
  });

  it('rejects a missing occurrenceId with 400', async () => {
    const res = await post(JSON.stringify({ note: 'no occurrence' }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-UUID occurrenceId with 400', async () => {
    const res = await post(JSON.stringify({ occurrenceId: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown issueType with 400', async () => {
    const res = await post(JSON.stringify({ occurrenceId: OCC, issueType: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized payload with 413', async () => {
    const huge = JSON.stringify({ occurrenceId: OCC, note: 'x'.repeat(MAX_CORRECTION_PAYLOAD_BYTES) });
    const res = await post(huge);
    expect(res.status).toBe(413);
  });

  it('rejects an oversized declared content-length with 413 before reading', async () => {
    const res = await post(JSON.stringify({ occurrenceId: OCC }), {
      'content-length': String(MAX_CORRECTION_PAYLOAD_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });
});
