// tests/auth/google_signin_gate.test.ts — the Google sign-in capability is OFF, at the route layer.
//
// WHY THIS FILE IS NOT OPTIONAL. An earlier change removed the sign-in BUTTON from the nav and the
// /search save bar. That made the capability undiscoverable and left it completely functional:
// checked against the live production domain on 2026-09-12, `GET /auth/signin` still 307'd into
// Supabase's `/authorize?provider=google` and `/account` still redirected anonymous visitors into
// it. Jon's answer was "nobody can sign in with google", which is a statement about the
// CAPABILITY, not the button — so it needs a test that exercises the routes, because a UI test
// asserting "no sign-in link is rendered" would have passed the entire time the flow was live.
import { describe, expect, it } from 'vitest';
import { GET as signinGET } from '@/app/auth/signin/route';
import { GET as callbackGET } from '@/app/auth/callback/route';
import { GOOGLE_SIGN_IN_ENABLED } from '@/lib/auth/google-signin-gate';

describe('the gate itself', () => {
  it('is CLOSED — flipping this constant is the whole reversal, and should be deliberate', () => {
    expect(GOOGLE_SIGN_IN_ENABLED).toBe(false);
  });
});

describe('GET /auth/signin', () => {
  it('404s instead of starting an OAuth flow', async () => {
    const res = await signinGET(new Request('https://kidsfun.example/auth/signin'));
    expect(res.status).toBe(404);
  });

  it('does not leak a redirect to any provider, for any `next`', async () => {
    // The pre-gate behaviour was a 307 whose Location was the Supabase authorize URL. Asserting
    // the absence of a Location header is what distinguishes "gated" from "still redirecting,
    // just to somewhere else".
    for (const next of ['/', '/account', '/search?q=swim']) {
      const res = await signinGET(
        new Request(`https://kidsfun.example/auth/signin?next=${encodeURIComponent(next)}`)
      );
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('sets no cookie — a gated build must not mint a PKCE code_verifier', async () => {
    // The guard runs before createSupabaseServerClient, so no verifier is generated or stored.
    const res = await signinGET(new Request('https://kidsfun.example/auth/signin'));
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /auth/callback — gated SEPARATELY, because it is independently reachable', () => {
  // This is the one that would have been missed. /auth/callback is a bare GET taking a `code`
  // param; it never checks that the visitor passed through /auth/signin. Gating only the
  // initiation route would have left a live path to exchange a code for a session.
  it('404s even when handed a code, which is the only way in that matters', async () => {
    const res = await callbackGET(
      new Request('https://kidsfun.example/auth/callback?code=whatever-a-provider-would-send')
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('404s with no code too — not merely falling through to the missing-code redirect', async () => {
    // Pre-gate, a codeless callback redirected to `/?auth_error=missing_code`. A 404 here proves
    // the guard fired rather than the old error path.
    const res = await callbackGET(new Request('https://kidsfun.example/auth/callback'));
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('404s for a `next` that would have been an open redirect after sign-in', async () => {
    const res = await callbackGET(
      new Request('https://kidsfun.example/auth/callback?code=abc&next=%2Faccount')
    );
    expect(res.status).toBe(404);
  });
});
