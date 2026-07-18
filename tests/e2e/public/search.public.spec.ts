import { test, expect } from '@playwright/test';

// Unauthenticated /search — the parent-facing results page must work with no auth
// (NR-03/04: search/browse never gates on a session). Renders server-side with a
// fixture fallback, so it's stable regardless of DB contents.

test.describe('public /search', () => {
  test('renders the search form for an anonymous visitor', async ({ page }) => {
    await page.goto('/search');

    // The search landmark + labelled query input are always present.
    const searchForm = page.getByRole('search');
    await expect(searchForm).toBeVisible();

    const queryInput = page.getByRole('searchbox', { name: /search kids' activities/i });
    await expect(queryInput).toBeVisible();

    // A query round-trips through the URL and re-renders (no auth wall).
    await queryInput.fill('swim');
    await queryInput.press('Enter');
    await expect(page).toHaveURL(/\/search\?.*q=swim/);
    await expect(page.getByRole('search')).toBeVisible();
  });
});
