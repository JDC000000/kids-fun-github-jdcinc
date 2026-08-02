import { test, expect, type Page } from '@playwright/test';

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
//
// ── SPLIT BY VIEWPORT (mobile filter sheet, Blueprint §04) ───────────────────────────
// This originally ran only at 390px, because that is where BOTH halves of the root cause
// lived. The mobile sheet removed both of them on phones: the rail is no longer a tall
// column above the results, and .kf-sbar is no longer sticky below 768px. Neither the bug
// nor its guard was mobile-specific, though — the tall sticky search bar and the collapsing
// map behave exactly as they did at desktop widths, so the ORIGINAL guard now runs at
// 1280px against the inline rail it was written for. A second test keeps phone coverage in
// its new shape: the scroll must still not jump, and the pinned filter bar must survive.
// Deleting the phone case and calling the desktop one "the" guard would have quietly
// dropped coverage on the surface most parents use.

const GROUP_NAMES = ['When', 'Time of day', 'Ages', 'Areas', 'Quick filters', 'Max price'] as const;

async function toggleControls(page: Page) {
  const toggle = page.getByRole('group', { name: 'Choose how to view results' });
  await expect(toggle).toBeVisible();
  return {
    toggle,
    mapBtn: toggle.getByRole('button', { name: 'Map' }),
    listBtn: toggle.getByRole('button', { name: 'List' }),
  };
}

test.describe('public /search — List↔Map toggle must not disturb the filter rail', () => {
  test('desktop: toggling to Map (and back) keeps the scroll offset and every filter group stable', async ({
    page,
  }) => {
    // A shorter viewport guarantees a tall result list below the fold, so switching to the
    // compact map view would (pre-fix) collapse the page and clamp the scroll. The width is
    // the one that still carries the original pre-conditions: an inline rail above the
    // results, under a tall position:sticky search bar.
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto('/search');

    // First results view (fixture-backed — no auth, no DB, no map key: Map falls back).
    const { mapBtn, listBtn } = await toggleControls(page);

    // The full filter rail and its groups exist up front.
    const filters = page.locator('.kf-filters');
    await expect(filters).toBeVisible();
    for (const name of GROUP_NAMES) {
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
    expect(Math.abs(railAfterMap!.y - railBefore!.y)).toBeLessThanOrEqual(4);

    // The DOM was never the problem, but prove every group + the Ages pills survive the toggle.
    for (const name of GROUP_NAMES) {
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

  test('mobile: toggling to Map keeps the scroll steady and leaves the filters reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });

    await page.goto('/search');
    const { mapBtn, listBtn } = await toggleControls(page);

    const bar = page.locator('.kf-mfilters');
    await expect(bar).toBeVisible();

    await mapBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));

    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.kf-map')).toBeVisible();
    await page.waitForTimeout(300);

    // Same regression assertion, phone shape: the collapsing map must not yank the scroll.
    expect(Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - scrollBefore)).toBeLessThanOrEqual(4);

    // The filter bar is pinned, so — unlike the pre-fix rail — it cannot be scrolled away
    // or hidden behind the search module no matter what the toggle does to page height.
    await expect(bar).toBeInViewport({ ratio: 0.9 });

    // And the whole filter set is still one tap away, in Map view.
    await page.getByRole('button', { name: /^⚙?\s*Filters/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Filters' });
    for (const name of GROUP_NAMES) {
      await expect(dialog.getByRole('group', { name })).toHaveCount(1);
    }
    await page.keyboard.press('Escape');

    await listBtn.click();
    await expect(listBtn).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(200);
    expect(Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - scrollBefore)).toBeLessThanOrEqual(4);
  });
});
