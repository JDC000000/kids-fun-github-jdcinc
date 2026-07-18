import { test, expect } from '@playwright/test';

// Auth boundary from the OTHER side: an anonymous visitor hitting the auth-gated
// /account must be bounced into the sign-in flow, never shown the account page.
// (app/account/page.tsx: getRequestUser() null -> redirect('/auth/signin?next=/account').)

test.describe('public /account (unauthenticated)', () => {
  test('redirects an anonymous visitor away from the account page', async ({ page }) => {
    await page.goto('/account');

    // We must NOT have landed on the rendered account page...
    await expect(page).not.toHaveURL(/\/account(\?|$)/);
    // ...and its signed-in content must be absent.
    await expect(page.getByRole('heading', { name: /profile & preferences/i })).toHaveCount(0);

    // The redirect targets the sign-in initiation (which then hands off to the
    // Supabase OAuth authorize endpoint) — assert we left for that flow.
    expect(page.url()).toMatch(/auth\/signin|auth\/v1\/authorize|127\.0\.0\.1:54321/);
  });
});
