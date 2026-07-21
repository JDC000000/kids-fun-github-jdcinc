import { test, expect } from '@playwright/test';

// Regression (Round 30) — switching /search from List to Map view must NOT corrupt the
// filter rail. Bug found by an independent UX review against production:
// "switching List → Map on /search makes a ~230px blank gap appear, the AGES section
// shows its header with no pills, and AREAS / QUICK FILTERS disappear from the panel."
//
// Real root cause (reproduced in a headless browser against production, not guessed):
// the filter rail is a tall column ABOVE the results, and the results sit under a tall
// (~245px) position:sticky search bar. Map view — especially the compact "map not
// available" fallback shown when no map key is configured — is thousands of pixels
// shorter than a full result list, so toggling to Map collapsed the page height. The
// browser then CLAMPED the scroll offset, dropping the parent into the middle of the
// filter rail with several groups (Time of day / Ages pills / Areas) hidden behind the
// sticky search bar — the reported "blank gap + missing pills". The DOM was never
// corrupted; it was a scroll-clamp + sticky-overlap artifact. The fix reserves the map's
// vertical footprint the moment Map view mounts, so the page height stays stable and the
// toggle no longer yanks the scroll.
//
// The assertion that actually catches the regression is the scroll-offset + filter-rail
// position check performed WITHOUT re-scrolling: toggling the view must leave both the
// window scroll offset and the filter rail's rendered position essentially unchanged.
// Before the fix the scroll jumped by well over 100px and the rail reflowed under the
// sticky bar; with the fix both stay put.

test.describe('public /search — List↔Map toggle must not disturb the filter rail', () => {
  test('toggling to Map (and back) keeps the scroll offset and every filter group stable', async ({ page }) => {
    // A shorter viewport guarantees a tall result list below the fold, so switching to the
    // compact map view would (pre-fix) collapse the page and clamp the scroll.
    await page.setViewportSize({ width: 390, height: 720 });

    await page.goto('/search');

    // First results view (fixture-backed — no auth, no DB, no map key: Map falls back).
    const toggle = page.getByRole('group', { name: 'Choose how to view results' });
    await expect(toggle).toBeVisible();
    const mapBtn = toggle.getByRole('button', { name: 'Map' });
    const listBtn = toggle.getByRole('button', { name: 'List' });

    // The full filter rail and its groups exist up front.
    const filters = page.locator('.kf-filters');
    const groupNames = ['When', 'Time of day', 'Ages', 'Areas', 'Quick filters', 'Max price'] as const;
    for (const name of groupNames) {
      await expect(page.getByRole('group', { name })).toHaveCount(1);
    }
    // Ages must actually carry its chips (the reviewer saw "header with no pills").
    const agesChips = page.getByRole('group', { name: 'Ages' }).getByRole('link');
    const agesChipCount = await agesChips.count();
    expect(agesChipCount).toBeGreaterThan(0);

    // Scroll down to the toggle, exactly the way a parent reaches it (it sits below the rail).
    await mapBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);

    const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));
    const railBefore = await filters.boundingBox();
    expect(railBefore).not.toBeNull();

    // Switch to Map.
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');
    // Map view mounted (real canvas OR the honest "not available" fallback — both reserve height).
    await expect(page.locator('.kf-map')).toBeVisible();
    await page.waitForTimeout(300); // allow the dynamic import + any reflow to settle

    const scrollAfterMap = await page.evaluate(() => Math.round(window.scrollY));
    const railAfterMap = await filters.boundingBox();
    expect(railAfterMap).not.toBeNull();

    // REGRESSION ASSERTION 1 — the toggle must not yank the scroll offset. Pre-fix this
    // jumped by 150–190px (the page collapsed and the browser clamped the scroll); with the
    // fix it holds within a couple of px.
    expect(Math.abs(scrollAfterMap - scrollBefore)).toBeLessThanOrEqual(4);

    // REGRESSION ASSERTION 2 — the filter rail must not reflow relative to the viewport.
    expect(Math.abs((railAfterMap!.y) - (railBefore!.y))).toBeLessThanOrEqual(4);

    // The DOM was never the problem, but prove every group + the Ages pills survive the toggle.
    for (const name of groupNames) {
      await expect(page.getByRole('group', { name })).toHaveCount(1);
    }
    expect(await page.getByRole('group', { name: 'Ages' }).getByRole('link').count()).toBe(agesChipCount);

    // Switching back to List must likewise leave the scroll offset stable (the reviewer's
    // open question — pre-fix, returning to List did NOT recover the view because the scroll
    // stayed clamped; with the fix nothing moved in the first place).
    await listBtn.click();
    await expect(listBtn).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(200);
    const scrollBackToList = await page.evaluate(() => Math.round(window.scrollY));
    expect(Math.abs(scrollBackToList - scrollBefore)).toBeLessThanOrEqual(4);
  });
});
