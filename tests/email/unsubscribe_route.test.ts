// tests/email/unsubscribe_route.test.ts — the CASL opt-out route's CONFIRMATION PAGES.
//
// WHY THIS FILE EXISTS. tests/email/unsubscribe.test.ts covers the HMAC token thoroughly, but
// nothing covered what the route actually SHOWS a person. That gap is how both pages went on
// telling recipients to "manage email preferences from your KIDS FUN account" and to "turn them
// back on any time from your account settings" after /account became a 404 — found by QA (F3),
// not by CI, because there was no test to find it.
//
// The invalid-link page is the one that matters. It is the fallback for somebody whose opt-out
// just FAILED, and CASL's question is not "was a mechanism offered" but "could they use it" — so
// a dead link there is a compliance defect wearing a copy-nit's clothes. These assertions are
// written to fail on the SHAPE of that mistake (an opt-out page pointing at something unreachable),
// not merely on the specific wording that happened to be wrong this time.
import { describe, expect, it, vi, afterEach } from 'vitest';

const applied: string[] = [];
vi.mock('@/lib/db/client', () => ({
  query: async (_sql: string, params: unknown[]) => {
    applied.push(String(params?.[0]));
    return { rows: [] };
  },
}));

const { GET } = await import('@/app/api/email/unsubscribe/route');
const { signUnsubscribeToken } = await import('@/lib/email/unsubscribe');

const USER = '11111111-1111-1111-1111-111111111111';

function req(qs: string): Request {
  return new Request(`https://kidsfun.example/api/email/unsubscribe${qs}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  applied.length = 0;
});

describe('the invalid-link page — the failed-opt-out fallback', () => {
  it('400s and offers a route that is not the dead account page', async () => {
    const res = await GET(req('?u=not-a-uuid&t=nope'));
    expect(res.status).toBe(400);
    const body = await res.text();

    // The defect QA found, asserted as an absence so it cannot come back quietly.
    expect(body).not.toMatch(/KIDS FUN account/i);
    expect(body).not.toMatch(/account settings/i);
    expect(body).not.toContain('/account');

    // …and something a person can actually act on. A page that only says "this didn't work" is
    // not an opt-out mechanism.
    expect(body).toMatch(/mailto:/);
  });

  it('does not touch the database when the token fails to verify', async () => {
    await GET(req('?u=not-a-uuid&t=nope'));
    expect(applied, 'a bad token must never reach the UPDATE').toHaveLength(0);
  });
});

describe('the success page', () => {
  it('confirms the opt-out without promising a re-subscribe route that no longer exists', async () => {
    vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', 'test-secret-value');
    const res = await GET(req(`?u=${USER}&t=${signUnsubscribeToken(USER)}`));
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toMatch(/unsubscribed/i);
    // "You can turn them back on any time from your account settings" — there is no such place.
    expect(body).not.toMatch(/turn them back on/i);
    expect(body).not.toMatch(/account settings/i);
    expect(body).not.toContain('/account');
  });

  it('actually applied the opt-out for that user', async () => {
    vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', 'test-secret-value');
    await GET(req(`?u=${USER}&t=${signUnsubscribeToken(USER)}`));
    expect(applied, 'the confirmation must not be shown without the write').toEqual([USER]);
  });

  it('⚠ does not pitch the SMS product on a CASL opt-out confirmation', () => {
    // Deliberate product decision recorded as a test: somebody who has just opted out of one
    // channel should not be sold another on the page confirming it. Easy to "improve" later
    // without noticing why it was left out.
    return GET(req('?u=not-a-uuid&t=nope'))
      .then((r) => r.text())
      .then((body) => {
        expect(body).not.toMatch(/text|sms|subscribe to/i);
      });
  });
});
