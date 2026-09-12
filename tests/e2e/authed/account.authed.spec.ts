import { test, expect } from '@playwright/test';
import { readAuthUserAuditMarker, readTestUser } from '../helpers/db';

// ─────────────────────────────────────────────────────────────────────────────
// /account IS GATED EVEN FOR A GENUINELY SIGNED-IN USER.
//
// WHAT CHANGED. This file used to prove the opposite: that a real injected Supabase session
// rendered the account page, its "Signed in as <email>" line, and a seeded saved search. Jon,
// 2026-09-12: "nobody can sign in with google." The gate in app/account/page.tsx runs BEFORE
// getRequestUser(), so it does not care whether a session exists — and that is the single most
// valuable thing this file can now assert.
//
// WHY THIS IS THE STRONGEST TEST OF THE GATE IN THE REPO. The `authed` project carries a REAL
// Supabase session minted by the service-role harness (storageState), which the app validates on
// every request. Every other test of the gate is an anonymous request, and an anonymous 404 is
// also what a merely-broken page returns. Here the session is real and valid, so a 404 can only
// mean the gate fired. A gate that closed the front door while leaving a valid cookie working
// would pass every other test in the suite and fail this one.
//
// The saved-search rendering tests are gone rather than rewritten: they asserted the CONTENT of a
// page that no longer renders for anyone, and seeding a fixture for an unreachable page proves
// nothing. The saved-search backend is deliberately still present but unreferenced — whether that
// whole area is retired is an open product question, and this file does not pre-judge it.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('authenticated /account — gated regardless of session', () => {
  test('⚠ 404s even WITH a real, valid injected session', async ({ page }) => {
    const response = await page.goto('/account');

    expect(response?.status(), 'a valid session must not open the gate').toBe(404);

    // None of the signed-in content may render. Previously all three were asserted VISIBLE.
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: /profile & preferences/i })).toHaveCount(0);
    await expect(main.getByText(/signed in as/i)).toHaveCount(0);
  });

  test('does not leak the session holder’s email onto the 404', async ({ page }) => {
    // The gated page must not accidentally render personal data into its error state — the old
    // page put the account email in a <p> near the top, so this is a real thing to check rather
    // than a hypothetical one.
    const { email } = readTestUser();
    await page.goto('/account');
    await expect(page.getByText(email, { exact: false })).toHaveCount(0);
  });

  test('never redirects the signed-in user into a provider flow either', async ({ page }) => {
    await page.goto('/account');
    expect(page.url()).not.toMatch(/auth\/signin|auth\/v1\/authorize|accounts\.google\.com/);
  });

  // UNCHANGED AND STILL RELEVANT: this one never touched /account. It verifies the E2E harness's
  // own auth user is auditable in the live auth.users table — the query an auditor would run.
  // The harness still mints that user (the `setup` project is unaffected by the gate, which is
  // enforced at the route layer, not in Supabase), so this remains a true and useful assertion.
  test('the auth user is auditable (persisted E2E marker + reserved domain)', async () => {
    const { id: userId } = readTestUser();
    const marker = await readAuthUserAuditMarker(userId);
    expect(marker, 'auth user row exists').not.toBeNull();
    expect(marker?.is_e2e_test_user, 'is_e2e_test_user marker persisted').toBe(true);
    expect(marker?.created_by).toBe('kids-fun-e2e-harness');
    expect(marker?.email, 'reserved .test domain').toMatch(/@e2e\.kids-fun\.test$/);
  });
});
