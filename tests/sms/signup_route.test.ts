// tests/sms/signup_route.test.ts — POST /api/sms/signup contract. No database, no Twilio.
//
// The persistence and the confirmation send are stubs on this branch (lib/sms/signup-store.ts),
// so what is testable — and what actually matters for a public endpoint that collects a phone
// number and a child's age — is the gate, the caps, the validation wiring and what comes back
// out of it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/sms/signup/route';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://kidsfun.example/api/sms/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = {
  phone: '604 555 0123',
  postal: 'V5L 1A1',
  childAges: [4, 7],
  interests: ['public_swim'],
  consent: true,
};

function enableSignup() {
  vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
}

describe('POST /api/sms/signup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('404s when the feature flag is off — the default in every environment', () => {
    // PRD §2.1: the form stays behind a flag until the privacy/CASL sign-off gate is recorded.
    // 404 rather than 403 on purpose: while the gate is unrecorded this endpoint does not exist
    // as far as the outside world is concerned, and a 403 would advertise a disabled
    // consent-collection endpoint on a public host.
    return POST(post(validBody)).then(async (res) => {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'not found' });
    });
  });

  it('is gated BEFORE the body is read', async () => {
    // A flagged-off endpoint must not buffer an unauthenticated caller's payload at all. Sending
    // a body that would otherwise 413 must still come back 404.
    const huge = 'x'.repeat(64 * 1024);
    const res = await POST(post(JSON.stringify({ blob: huge })));
    expect(res.status).toBe(404);
  });

  it('accepts a complete signup and reports that nothing was dispatched', async () => {
    enableSignup(); // SMS_SENDING_ENABLED deliberately left unset → dry run.
    const res = await POST(post(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    // `dispatched: false` is the honest answer in a staging screenshot session: the form worked,
    // the validation ran, and not one text left the building.
    expect(body).toEqual({ ok: true, dispatched: false });
  });

  it('NEVER returns anything about the subscriber', async () => {
    // This is an unauthenticated endpoint and the caller has not proved they hold the number they
    // submitted. Returning a row id, a short_ref or a preferences token would make the form a way
    // to obtain a bearer credential for somebody else's phone number.
    enableSignup();
    const raw = await (await POST(post(validBody))).text();
    for (const leak of ['id', 'short_ref', 'preferences', 'token', '6045550123', '+1604']) {
      expect(raw.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('rejects a submission with no consent, and returns EVERY failure', () => {
    // PRD §8 item 2 (Jon: "Show all errors at once"). The single-error contract still holds —
    // `error`/`field` are the head of the list — so a caller reading only those is unaffected.
    enableSignup();
    return POST(post({ ...validBody, consent: false, phone: 'garbage' })).then(async (res) => {
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors.map((e: { field?: string }) => e.field)).toEqual(['phone', 'consent']);
      expect(body.error).toBe(body.errors[0].message);
      expect(body.field).toBe('phone');
    });
  });

  it('reports coverage BEFORE consent — the outcome Jon ruled on (item 1)', async () => {
    enableSignup();
    const res = await POST(post({ ...validBody, postal: 'V3S 1A1', consent: false }));
    const body = await res.json();
    const fields = body.errors.map((e: { field?: string }) => e.field);
    expect(fields.indexOf('postal')).toBeLessThan(fields.indexOf('consent'));
    // And the friendly sentence, not a terse code — the same words the browser form shows.
    expect(body.error).toContain('North Vancouver');
  });

  it('a non-validation failure still carries the single-error shape', async () => {
    // 413/503/404 responses have no `errors` list; the form falls back to `error`.
    enableSignup();
    const huge = await POST(post({ blob: 'x'.repeat(8 * 1024) }));
    expect(huge.status).toBe(413);
    const body = await huge.json();
    expect(body.error).toBe('payload too large');
    expect(body.errors).toBeUndefined();
  });

  it('answers an out-of-area postal with the full sentence, not the terse code', async () => {
    // The one rejection that is about US rather than about what they typed, so it names the areas
    // we do cover instead of implying they made a mistake.
    enableSignup();
    const res = await POST(post({ ...validBody, postal: 'V3S 1A1' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('postal');
    expect(body.error).toContain('Richmond');
    expect(body.error).not.toBe('out of coverage area');
  });

  it('rejects malformed JSON and an oversized payload', async () => {
    enableSignup();
    expect((await POST(post('{not json'))).status).toBe(400);

    const oversized = await POST(
      post({ ...validBody, junk: 'x'.repeat(8 * 1024) })
    );
    expect(oversized.status).toBe(413);
  });

  it('honours a lying content-length header by re-checking the real body', async () => {
    // content-length can be absent or wrong, so the cheap early reject is a courtesy and the
    // hard cap is the actual control.
    enableSignup();
    const res = await POST(post(validBody, { 'content-length': '999999' }));
    expect(res.status).toBe(413);
  });
});
