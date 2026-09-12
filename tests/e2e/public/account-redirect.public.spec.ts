import { test, expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// /account IS GATED — in a real browser, against a real running app.
//
// WHAT THIS FILE USED TO ASSERT, and why the inversion matters. It checked that an anonymous
// visitor to /account was BOUNCED INTO THE SIGN-IN FLOW: "assert we left for that flow", matching
// on `auth/signin|auth/v1/authorize`. That was correct behaviour then and is exactly the
// behaviour that had to stop. Jon, 2026-09-12: "nobody can sign in with google." The page now
// 404s (app/account/page.tsx, via lib/auth/google-signin-gate.ts).
//
// So the old assertion is not merely stale — passing it now would mean the gate had failed open.
// Rewritten rather than deleted for that reason: this is the cheapest end-to-end proof that a
// real browser hitting a real server cannot be handed off to Google, and the unit tests
// (tests/auth/google_signin_gate.test.ts) call the route handlers directly and so cannot see a
// redirect that Next itself might perform.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('public /account (unauthenticated) — gated, not redirected', () => {
  test('404s instead of starting a sign-in flow', async ({ page }) => {
    const response = await page.goto('/account');

    expect(response?.status(), '/account must be a hard 404').toBe(404);

    // The signed-in content must be absent — the same assertion as before the gate, kept because
    // "404 status but the page still rendered" is a real Next.js failure mode.
    await expect(page.getByRole('heading', { name: /profile & preferences/i })).toHaveCount(0);
  });

  test('⚠ never hands off to an auth provider — the assertion this file exists for', async ({ page }) => {
    // Inverted from the original. The URL must NOT have moved to the sign-in initiation, the
    // Supabase authorize endpoint, or a local Supabase auth port. If any of these ever match
    // again, the capability came back.
    await page.goto('/account');
    expect(page.url()).not.toMatch(/auth\/signin|auth\/v1\/authorize|accounts\.google\.com|127\.0\.0\.1:54321/);
    // We should still be on /account itself — 404 rendered in place, not a redirect anywhere.
    await expect(page).toHaveURL(/\/account(\?|$)/);
  });

  test('the sign-in routes themselves 404 in a browser too', async ({ page }) => {
    // /auth/callback is checked WITH a code because it is independently reachable: it never
    // verifies the visitor passed through /auth/signin, so gating only the initiation route would
    // have left a live way to mint a session. See lib/auth/google-signin-gate.ts.
    for (const path of ['/auth/signin', '/auth/signin?next=/account', '/auth/callback?code=x']) {
      const res = await page.goto(path);
      expect(res?.status(), `${path} must 404`).toBe(404);
      expect(page.url(), `${path} must not redirect to a provider`).not.toMatch(
        /auth\/v1\/authorize|accounts\.google\.com/
      );
    }
  });
});
