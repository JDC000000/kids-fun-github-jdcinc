import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clearSavedSearchById,
  readAuthUserAuditMarker,
  readTestUser,
  seedSavedSearch,
} from '../helpers/db';

// Authenticated /account — the flow prior QA could never verify without a real
// headless-browser + auth harness. Runs under BOTH the `authed` (light) and
// `authed-dark` projects, so it doubles as the dark-mode rendering check.
//
// The session was injected via storageState (a REAL Supabase session minted by
// the service-role harness). The app validates it for real on every request; if
// injection were fake, getRequestUser() would return null and /account would
// redirect — so a passing assertion here IS end-to-end proof of the harness.

const ARTIFACT_DIR = resolve('tests/e2e/.artifacts');

test.describe('authenticated /account', () => {
  test('renders the account page for the signed-in test user', async ({ page }, testInfo) => {
    const { email } = readTestUser();

    await page.goto('/account');

    // Signed-in-only content — never shown to an anonymous visitor. Scope to the
    // <main> to avoid the AccountNav, which also renders a "Signed in as" label.
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: /profile & preferences/i })).toBeVisible();
    await expect(main.getByText(/signed in as/i)).toBeVisible();
    await expect(main.getByText(email, { exact: false })).toBeVisible();

    // Visual proof (esp. dark scheme) — attach to the report and save a copy.
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const shot = await page.screenshot({
      path: `${ARTIFACT_DIR}/account-${testInfo.project.name}.png`,
      fullPage: true,
    });
    await testInfo.attach(`account-${testInfo.project.name}`, { body: shot, contentType: 'image/png' });
  });

  test('saved searches for the test user render server-side', async ({ page }, testInfo) => {
    const { id: userId } = readTestUser();
    // Project-unique name so the light/dark projects don't collide when parallel.
    const name = `E2E saved ${testInfo.project.name} ${testInfo.testId}`;
    const savedId = await seedSavedSearch(userId, name);
    try {
      // Fresh navigation: the account server component reads saved searches through
      // the app's RLS-enforcing USER_DATABASE_URL path (owner-scoped) and renders them.
      await page.goto('/account');
      await expect(page.getByRole('heading', { name: /my saved searches/i })).toBeVisible();
      // Target the item-name span specifically (the item-meta span also echoes the name).
      await expect(page.locator('.kf-saved__item-name', { hasText: name })).toBeVisible();
    } finally {
      await clearSavedSearchById(savedId);
    }
  });

  test('the auth user is auditable (persisted E2E marker + reserved domain)', async () => {
    // Named safety requirement #2, verified against the LIVE auth.users row —
    // exactly the query an auditor/admin would run.
    const { id: userId } = readTestUser();
    const marker = await readAuthUserAuditMarker(userId);
    expect(marker, 'auth user row exists').not.toBeNull();
    expect(marker?.is_e2e_test_user, 'is_e2e_test_user marker persisted').toBe(true);
    expect(marker?.created_by).toBe('kids-fun-e2e-harness');
    expect(marker?.email, 'reserved .test domain').toMatch(/@e2e\.kids-fun\.test$/);
  });
});
