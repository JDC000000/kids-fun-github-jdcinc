import { test, expect } from '@playwright/test';

// Unauthenticated /preview — the fixture/demo shell. Anonymous, no DB dependency.

test.describe('public /preview', () => {
  test('renders the hero for an anonymous visitor', async ({ page }) => {
    await page.goto('/preview');
    await expect(
      page.getByRole('heading', { name: /see what's on for your kids today/i }),
    ).toBeVisible();
  });
});
