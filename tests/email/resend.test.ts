// tests/email/resend.test.ts — Resend payload construction + dry-run + mocked fetch.
// No real network and no real key are ever used.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '@/lib/email/resend';

const BASE = {
  to: 'parent@example.com',
  subject: 'Test subject',
  html: '<p>hi</p>',
  text: 'hi',
  headers: { 'List-Unsubscribe': '<https://app.example/unsub>' },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendEmail', () => {
  it('dry-run builds the payload and NEVER calls fetch', async () => {
    vi.stubEnv('EMAIL_FROM', 'KIDS FUN <hello@mail.example>');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await sendEmail({ ...BASE, dryRun: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe('dry_run');
    if (res.status !== 'dry_run') throw new Error('unreachable');
    expect(res.payload.from).toBe('KIDS FUN <hello@mail.example>');
    expect(res.payload.to).toEqual(['parent@example.com']);
    expect(res.payload.subject).toBe('Test subject');
    expect(res.payload.headers).toEqual(BASE.headers);
    // The API key must never appear in the payload.
    expect(JSON.stringify(res.payload)).not.toMatch(/authorization|bearer|api_key/i);
  });

  it('real send posts to Resend with a Bearer header and returns the message id', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await sendEmail({ ...BASE });
    expect(res.status).toBe('sent');
    if (res.status !== 'sent') throw new Error('unreachable');
    expect(res.id).toBe('msg_123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['parent@example.com']);
  });

  it('reports an error on a non-2xx Resend response (without throwing)', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 422 })));
    const res = await sendEmail({ ...BASE });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('422');
  });

  it('skips (does not send) when no API key is configured and it is not a dry run', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await sendEmail({ ...BASE });
    expect(res.status).toBe('skipped_no_key');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
