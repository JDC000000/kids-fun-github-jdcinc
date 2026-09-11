import { test, expect, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// ─────────────────────────────────────────────────────────────────────────────
// The branded 404 (app/not-found.tsx).
//
// WHY A BROWSER TEST AND NOT ONLY THE UNIT TEST
// tests/not-found-page.test.tsx proves what the component RENDERS. Three things it cannot
// reach are the whole reason a custom 404 either works or silently does not:
//   • the HTTP STATUS. A 404 page served with 200 is worse than no custom page at all — it
//     tells every crawler the dead URL is a real one, and the only way to see the difference
//     is to make the request.
//   • the WIRING. `app/not-found.tsx` catching arbitrary unmatched paths is a framework
//     convention, not something the file itself asserts; it is also the bit that middleware
//     or a stray catch-all route can quietly take away.
//   • the WAY OUT actually working end to end — the form really navigating to real results.
// ─────────────────────────────────────────────────────────────────────────────

const MISSING = '/definitely-not-a-real-page-9f2a';

test.describe('an unmatched URL gets the product, not the framework default', () => {
  test('answers 404 — with the branded page, not Next.js’s built-in one', async ({ page }) => {
    const response = await page.goto(MISSING);

    // The status is the half a crawler reads.
    expect(response?.status(), 'a soft-404 tells search engines a dead URL is real').toBe(404);

    // The page is the half a parent reads.
    await expect(page.getByRole('heading', { level: 1, name: /That page isn/ })).toBeVisible();
    await expect(page).toHaveTitle('Page not found — KIDS FUN');
    // Next's built-in page renders this exact string; ours must have replaced it.
    await expect(page.locator('body')).not.toContainText('This page could not be found');
  });

  test('is reached from a deep path too, not just a top-level typo', async ({ page }) => {
    const response = await page.goto('/search/not/a/route');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: /That page isn/ })).toBeVisible();
  });

  test('the search box on it really reaches results', async ({ page }) => {
    await page.goto(MISSING);
    await page.getByLabel('What are you looking for?').fill('swim');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page).toHaveURL(/\/search\?.*q=swim/);
    // …and lands on the real results page, not another error.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('swim');
  });

  test('every onward link goes somewhere that exists', async ({ page, request }) => {
    await page.goto(MISSING);

    const hrefs = await page
      .locator('.kf-nf a[href]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));
    expect(hrefs.length, 'the page offers no way out at all').toBeGreaterThan(4);

    // A 404 that links to another 404 is the failure this page was written to end, so the
    // links are FOLLOWED rather than pattern-matched.
    for (const href of hrefs) {
      const res = await request.get(href);
      expect(res.status(), `${href} is itself broken`).toBe(200);
    }
  });

  test('works without JavaScript — the search form is a plain GET', async ({ browser }) => {
    // Unmatched URLs are served from the statically generated /_not-found output, so this
    // page has to be useful before (and without) hydration. It is also the page most likely
    // to be reached on a bad connection.
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(MISSING);

    await expect(page.getByRole('heading', { level: 1, name: /That page isn/ })).toBeVisible();
    await page.getByLabel('What are you looking for?').fill('storytime');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/\/search\?.*q=storytime/);

    await ctx.close();
  });
});

test.describe('the 404 stands on its own where the site chrome does not render', () => {
  // BARE_CHROME_PREFIXES (lib/sms/surfaces.ts) strips the nav and footer under /u and
  // /sms/*. A mistyped no-login preferences link — the kind that arrives by copy-paste out
  // of a text message — lands there. If this page leaned on the global nav for its way out,
  // that parent would have none.
  test('a mistyped /u link still offers a search box and links of its own', async ({ page }) => {
    // `/u/<token>` itself always resolves — the route renders its own "that link is not valid"
    // state rather than 404ing, which is correct. `/u/<token>/<something>` does not resolve, and
    // an extra path segment is exactly what a copy-paste out of a text message produces.
    const response = await page.goto('/u/not-a-real-token/preferences');
    expect(response?.status()).toBe(404);

    // Chrome really is suppressed here — otherwise this test is just a second copy of the
    // ones above and proves nothing about self-sufficiency.
    await expect(page.locator('.kf-nav')).toHaveCount(0);

    const region = page.locator('.kf-nf');
    await expect(region.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(region.locator('form[action="/search"]')).toBeVisible();
    await expect(region.getByRole('link', { name: /home page/ })).toBeVisible();
  });
});

test.describe('the 404 on a phone', () => {
  test.use({ viewport: devices['iPhone 14'].viewport! });

  test('the whole page — statement, search and exits — fits one screen', async ({ page }) => {
    await page.goto(MISSING);
    await page.evaluate(() => document.fonts.ready);

    // Somebody who has just hit a wrong address should not have to scroll to find the way
    // out of it. The links are the last thing on the page, so measuring the last one covers
    // everything above it.
    const links = page.locator('.kf-nf__link');
    await expect(links.last()).toBeInViewport();
    await expect(page.locator('.kf-nf form')).toBeInViewport();
  });
});

test.describe('accessibility', () => {
  test('axe finds no violations on the 404', async ({ page }) => {
    await page.goto(MISSING);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    // A new page ships clean or it does not ship — the same bar the mobile filter sheet is
    // held to, and for the same reason: pre-existing findings elsewhere are not a licence.
    expect(results.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
  });

  test('axe finds no violations on the 404 in dark mode', async ({ page }) => {
    // Dark mode is where this page's first real bug was: the "back to home" link was written
    // as `color: var(--anchor)`, which is an anchor SURFACE role — near-black on the dark
    // surface, about 1.4:1, and completely correct-looking in light mode. See not-found.css.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(MISSING);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(results.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
  });
});
