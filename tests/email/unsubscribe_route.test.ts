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

  it('⚠ never says the link "expired" — this token has no expiry (QA wording review)', async () => {
    // lib/email/unsubscribe.ts signs an HMAC over the user id ALONE — no timestamp, no nonce —
    // and its docstring says "Stable per (userId, secret) so a link keeps working across sends".
    // "Expired" was therefore false, and false in the costly direction: it is the word that makes
    // someone conclude they are too late and stop, at the exact moment their opt-out has failed,
    // while implying the fault is theirs. The real causes are a truncating mail client or a
    // rotated secret — ours, not theirs.
    const body = await (await GET(req('?u=not-a-uuid&t=nope'))).text();
    expect(body).not.toMatch(/expired/i);
    // …and it should name a cause the reader can act on rather than just asserting failure.
    expect(body).toMatch(/incomplete/i);
  });

  it('tells people which address to write from, so the request can actually be honoured', () => {
    // A mailto with no addressing instruction leaves us unable to action anyone who writes from a
    // different account — on an opt-out route that means the request arrives and cannot be met.
    return GET(req('?u=not-a-uuid&t=nope'))
      .then((r) => r.text())
      .then((body) => expect(body).toMatch(/from the address you want removed/i));
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

  it('⚠ QA asked that this wording be LEFT ALONE — asserted so a future edit has to be deliberate', async () => {
    // The success copy was reviewed and deliberately kept: the "if any still arrive" line already
    // covers the already-queued-send edge case gracefully, so it needs no hedging about timing.
    // Pinned literally because the shared MAILTO constant makes it easy to rewrite this page by
    // accident while editing the invalid-link one — which is exactly what this test exists to stop.
    vi.stubEnv('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET', 'test-secret-value');
    const body = await (await GET(req(`?u=${USER}&t=${signUnsubscribeToken(USER)}`))).text();
    expect(body).toContain(
      'You won’t get any more weekly update emails from KIDS FUN. If any still arrive, email us at'
    );
    // The invalid-link page's clauses must NOT have leaked here via the shared constant.
    expect(body).not.toMatch(/from the address you want removed/i);
    expect(body).not.toMatch(/cut long links short/i);
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
