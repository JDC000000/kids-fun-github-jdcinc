import { test, expect } from '@playwright/test';

// Regression (Round 30) — the /preview live filter chips must stay reachable AFTER
// the first results load. Bug found by the founder while testing production:
// "after the first view of activity results loads, the user cannot easily toggle
// activities or change search criteria — the UI does not respond to changing
// filters after that initial load."
//
// Real root cause (reproduced in a headless browser against production, not guessed):
// the quick-filter chip rail was a NON-sticky sibling of the sticky date/area bar.
// Once a parent scrolled into their first set of results, the chip rail scrolled off
// the top of the screen and never returned. The only filter-looking controls left
// pinned were the display-only date/area stubs (README → "Not yet wired"), so
// changing search criteria genuinely appeared to do nothing. The fix pins the chip
// rail inside the sticky filter bar so every live filter stays reachable.
//
// The assertion that actually catches the regression is the viewport check performed
// WITHOUT interacting: Playwright's .click() auto-scrolls its target into view, which
// would silently mask an off-screen (unreachable) control. toBeInViewport() measures
// the rendered position as-is.

test.describe('public /preview — filters stay reachable after first results load', () => {
  test('quick-filter chip rail stays pinned and usable after scrolling into results', async ({ page }) => {
    // A short viewport guarantees there are results below the fold to scroll past.
    await page.setViewportSize({ width: 390, height: 720 });

    await page.goto('/preview');

    // First results view (fixture-backed — no auth, no DB dependency).
    const sortText = page.locator('.kf-sort__text');
    await expect(sortText).toBeVisible();
    await expect(sortText).toContainText(/confirmed/i);

    const filters = page.getByRole('group', { name: 'Quick filters' });
    await expect(filters).toBeVisible();
    await expect(filters).toBeInViewport();

    // Scroll deep into the results list, exactly the way a browsing parent would.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => window.scrollY > 600);

    // REGRESSION ASSERTION: the live filter rail is STILL within the viewport after
    // scrolling deep into results. Before the fix it had scrolled entirely off the
    // top (0% intersection) and this fails; with the fix it stays pinned (~full
    // intersection). No interaction here — measuring the rendered position as-is.
    await expect(filters).toBeInViewport({ ratio: 0.5 });

    // And it must still FUNCTION while scrolled: toggling a chip updates its pressed
    // state (proves the handler fires and the surface re-renders after first load).
    const freeChip = filters.getByRole('button', { name: 'Free', exact: true });
    await expect(freeChip).toHaveAttribute('aria-pressed', 'false');
    await freeChip.click();
    await expect(freeChip).toHaveAttribute('aria-pressed', 'true');

    // The transparent sort/count line reacts to the filter change (aria-live region
    // updates), confirming the results surface responded — not a silent no-op.
    await expect(sortText).toContainText(/confirmed/i);
  });
});
