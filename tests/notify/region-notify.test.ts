// tests/notify/region-notify.test.ts — the "email me when this area is live" capture contract.
//
// Two things are proved here, and the second is the one that matters most:
//   1. VALIDATION — an area outside the rail's own chip vocabulary and a non-address are
//      rejected at the edge, so nothing arbitrary reaches the table (migration 0032).
//   2. A LOST WRITE IS A REPORTED FAILURE — POST /api/notify/region returns 503, not a cheerful
//      202, when the row cannot be written. This is the deliberate divergence from
//      /api/corrections (tests/corrections/route.test.ts asserts the opposite for that route,
//      correctly): a correction promises nothing, this form promises an email, and answering
//      "we'll let you know" over a row that does not exist is the quiet substitution that the
//      honest empty state this form sits inside was built to end.
//
// No database: DATABASE_URL is unset for the route calls, which is exactly what makes the write
// fail and lets the failure path be asserted without one. The DB-backed half (the row really
// lands, and a repeat submission dedupes) is tests/notify/region-notify-db.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '../../app/api/notify/region/route';
import { MAX_EMAIL_LENGTH, MAX_NOTIFY_PAYLOAD_BYTES, parseRegionNotifyBody } from '../../lib/notify/region-signup';
import { REGION_CHIPS } from '../../app/search/_lib/params';

const ALLOWED = REGION_CHIPS.map((c) => c.id);

describe('parseRegionNotifyBody', () => {
  it('accepts an area from the rail vocabulary plus a plausible address', () => {
    const parsed = parseRegionNotifyBody({ region: 'wvan', email: '  jane@example.com  ' }, ALLOWED);
    expect(parsed).toEqual({ ok: true, value: { regionChipId: 'wvan', email: 'jane@example.com' } });
  });

  it('accepts every area the rail can actually offer — the two vocabularies cannot drift', () => {
    // If a chip is added to REGION_CHIPS and this endpoint stops accepting it, the notice's own
    // capture form starts 400-ing on the area it is displayed for.
    for (const id of ALLOWED) {
      expect(parseRegionNotifyBody({ region: id, email: 'a@b.co' }, ALLOWED).ok).toBe(true);
    }
  });

  it('rejects an area outside that vocabulary', () => {
    for (const region of ['surrey', '', 'VAN', '../../etc', null]) {
      expect(parseRegionNotifyBody({ region, email: 'a@b.co' }, ALLOWED).ok).toBe(false);
    }
  });

  it('rejects a missing or unusable address', () => {
    for (const email of [undefined, '', '   ', 'jane', 'jane@', '@example.com', 'jane at example.com', 'a b@c.co']) {
      expect(parseRegionNotifyBody({ region: 'bby', email }, ALLOWED).ok).toBe(false);
    }
  });

  it('rejects an over-long address rather than truncating one', () => {
    const tooLong = `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`;
    expect(parseRegionNotifyBody({ region: 'bby', email: tooLong }, ALLOWED).ok).toBe(false);
  });

  it('admits the unusual-but-real addresses an over-strict pattern would lose', () => {
    // A rejected good address costs the signup now; a bad one costs one undeliverable email
    // later. The trade is deliberate — see the regex's own note.
    for (const email of ["o'brien+kids@sub.domain.example.ca", 'jane.doe_99@a-b.co.uk', '"odd"@example.com']) {
      expect(parseRegionNotifyBody({ region: 'bby', email }, ALLOWED).ok).toBe(true);
    }
  });

  it('rejects a body that is not a JSON object', () => {
    for (const raw of [null, 'string', 42, ['bby']]) {
      expect(parseRegionNotifyBody(raw, ALLOWED).ok).toBe(false);
    }
  });

  it('never echoes the submitted address back in an error', () => {
    const parsed = parseRegionNotifyBody({ region: 'bby', email: 'not-an-address <script>' }, ALLOWED);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).not.toContain('script');
  });
});

describe('POST /api/notify/region', () => {
  let savedDbUrl: string | undefined;
  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL; // force the write to fail, so the failure path is real
  });
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  function post(body: string, headers: Record<string, string> = {}) {
    return POST(
      new Request('http://localhost/api/notify/region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      })
    );
  }

  it('REPORTS a write it could not perform (503) instead of thanking the parent for it', async () => {
    const res = await post(JSON.stringify({ region: 'wvan', email: 'jane@example.com' }));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it('rejects an unknown area with 400', async () => {
    expect((await post(JSON.stringify({ region: 'surrey', email: 'jane@example.com' }))).status).toBe(400);
  });

  it('rejects a bad address with 400', async () => {
    expect((await post(JSON.stringify({ region: 'bby', email: 'jane' }))).status).toBe(400);
  });

  it('rejects malformed JSON with 400 rather than crashing', async () => {
    expect((await post('{ not json')).status).toBe(400);
    expect((await post('')).status).toBe(400);
  });

  it('caps the payload both by declared and by actual size (413)', async () => {
    const declared = await post(JSON.stringify({ region: 'bby', email: 'a@b.co' }), {
      'content-length': String(MAX_NOTIFY_PAYLOAD_BYTES + 1),
    });
    expect(declared.status).toBe(413);

    const actual = await post(JSON.stringify({ region: 'bby', email: 'a@b.co', pad: 'x'.repeat(MAX_NOTIFY_PAYLOAD_BYTES) }));
    expect(actual.status).toBe(413);
  });
});
