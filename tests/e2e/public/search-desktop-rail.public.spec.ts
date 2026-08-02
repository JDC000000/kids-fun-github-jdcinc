import { test, expect, type Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// /search — persistent DESKTOP filter rail, real site nav, query summary line
// (Desktop scope decision, 1 Aug 2026: Proposal A as the chassis, C as the
// intelligence layer, B's summary line grafted).
//
// WHY A BROWSER TEST
// Every claim here is a layout claim: which side of the results the rail sits on,
// how many columns the grid resolves to at a given viewport, how much chrome sits
// above the first card, and whether the page overflows horizontally once real page
// padding and the scrollbar are counted. jsdom has no layout engine and no media
// queries — the desktop-shell regression (one missing media query, the whole
// product rendered as a 440px column on desktop, every jsdom test green) is this
// repo's standing proof that none of this can be asserted without a browser.
//
// THE NUMBERS BELOW COME FROM THE DECISION DOC'S FINAL LADDER
//   shell = min(1504px, 100%)   fluid, never fixed — a fixed 1544px shell was
//                               measured to overflow a 1440px viewport by 183px
//   rail  = 200px               outside the content measure (it is chrome, not
//                               reading content), 24px gap
//   grid  = 12px gap, 3 columns from 1400px (NOT the deployed 1280: subtracting a
//                               rail from 1280 puts 3 columns under the 300px
//                               card floor)
// Assertions are written as INEQUALITIES against those rules rather than as exact
// pixel equalities, so a legitimate 1px sub-pixel or font-metric shift does not
// fail the suite while a real geometry regression still does.
// ─────────────────────────────────────────────────────────────────────────────

const RAIL_W = 200;
const CARD_FLOOR = 300;

const V = {
  phone: { width: 390, height: 844 },
  laptop: { width: 1024, height: 800 },
  desk1280: { width: 1280, height: 800 },
  desk1440: { width: 1440, height: 900 },
  desk1728: { width: 1728, height: 1000 },
};

interface Geometry {
  shellW: number;
  railW: number;
  railRight: number;
  resultsLeft: number;
  columns: number;
  cardW: number;
  firstCardTop: number;
  cardsFullyVisible: number;
  groupsUpFront: number;
  groupsTotal: number;
  groupsFolded: number;
  horizontalOverflow: boolean;
}

async function geometry(page: Page, viewportH: number): Promise<Geometry> {
  return page.evaluate((h) => {
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const filters = document.querySelector('.kf-filters');
    const details = document.querySelector('.kf-filters__more');
    const rail = filters?.getBoundingClientRect() ?? null;
    const results = rect('.kf-results');
    const grid = document.querySelector('.kf-results section');
    const cols = grid ? (getComputedStyle(grid).gridTemplateColumns.match(/px/g) ?? []).length : 0;
    const card = document.querySelector('.kf-card');
    const cards = [...document.querySelectorAll('.kf-card')];
    return {
      shellW: rect('.kf-app')?.width ?? 0,
      railW: rail?.width ?? 0,
      railRight: rail?.right ?? 0,
      resultsLeft: results?.left ?? 0,
      columns: cols,
      cardW: card?.getBoundingClientRect().width ?? 0,
      firstCardTop: card ? Math.round(card.getBoundingClientRect().top + window.scrollY) : 0,
      cardsFullyVisible: cards.filter((c) => {
        const b = c.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= h;
      }).length,
      groupsUpFront: filters ? [...filters.children].filter((c) => c.classList.contains('kf-fgroup')).length : 0,
      groupsTotal: document.querySelectorAll('.kf-fgroup').length,
      groupsFolded: details ? details.querySelectorAll('.kf-fgroup').length : 0,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, viewportH);
}

test.describe('desktop /search — the rail sits beside the results, and the results start above the fold', () => {
  test('at 1440 the first full row of results is visible without scrolling', async ({ page }) => {
    await page.setViewportSize(V.desk1440);
    await page.goto('/search');
    const g = await geometry(page, V.desk1440.height);

    // THE claim the whole decision rests on. Measured before this work: the first card
    // began 1,132px down — 1.26 viewport-heights of chrome, ZERO complete cards visible.
    // The rail alone was measured to get one partially-visible card and the chrome cleanup
    // alone two-thirds of one; only together do they clear a 365px card height, which is
    // why they shipped as one body of work rather than rail-now/cleanup-later.
    // Measured on this build: 461px, 0.51 viewport-heights, 3 complete cards + 6 partly
    // visible. The threshold is set at 0.6 screens — loose enough that a legitimate copy or
    // spacing change does not fail the suite, tight enough that either half of the work
    // silently regressing (the rail coming back inline, or the hero band returning) does.
    expect(g.firstCardTop, 'chrome above the first result').toBeLessThan(V.desk1440.height * 0.6);
    expect(g.cardsFullyVisible, 'complete cards above the fold').toBeGreaterThanOrEqual(3);
  });

  test('the rail is beside the results, not above them, and stays 200px', async ({ page }) => {
    await page.setViewportSize(V.desk1440);
    await page.goto('/search');
    const g = await geometry(page, V.desk1440.height);

    expect(Math.round(g.railW)).toBe(RAIL_W);
    // Genuinely two columns: the rail's right edge is at or left of where results begin.
    expect(g.railRight).toBeLessThanOrEqual(g.resultsLeft + 1);
  });

  test('the shell is FLUID, so no supported desktop width scrolls sideways', async ({ page }) => {
    // The specific bug this pins: a fixed shell (1384px, later 1544px) computes fine on
    // paper and overflows a real 1440px viewport once .kf-page's 24px padding and a ~15px
    // scrollbar are counted. `min(1504px, 100%)` degrades instead of overflowing.
    for (const vp of [V.phone, V.laptop, V.desk1280, V.desk1440, V.desk1728]) {
      await page.setViewportSize(vp);
      await page.goto('/search');
      const g = await geometry(page, vp.height);
      expect(g.horizontalOverflow, `horizontal overflow at ${vp.width}px`).toBe(false);
      expect(g.shellW, `shell exceeds its cap at ${vp.width}px`).toBeLessThanOrEqual(1504);
    }
  });

  test('cards never fall under the 300px floor once the rail takes its 200px', async ({ page }) => {
    // The catch that moved the 3-column breakpoint: at 1280 with a rail subtracted, three
    // columns would compute to ~296px cards. Two columns there is the deliberate answer.
    for (const vp of [V.desk1280, V.desk1440, V.desk1728]) {
      await page.setViewportSize(vp);
      await page.goto('/search');
      const g = await geometry(page, vp.height);
      expect(g.cardW, `card width at ${vp.width}px`).toBeGreaterThanOrEqual(CARD_FLOOR);
      expect(g.columns, `columns at ${vp.width}px`).toBeGreaterThanOrEqual(2);
    }
  });

  test('below the rail breakpoint the layout is exactly what the phone had', async ({ page }) => {
    // The rail is a relocation, not a rewrite: below 1043px both grid wrappers are
    // `display: contents`, so the phone's DOM order and the sheet architecture are
    // untouched. ONE FilterRail instance serves all three layouts.
    await page.setViewportSize(V.phone);
    await page.goto('/search');
    // Phone: the same rail is inside the closed bottom sheet (zero-size), reached by the
    // sticky bar. A 200px sidebar — or a full-width inline block — here would mean the
    // desktop work had leaked onto the 70% of parents on a phone.
    await expect(page.locator('.kf-mfilters')).toBeVisible();
    expect((await geometry(page, V.phone.height)).railW, 'no sidebar on the phone').toBe(0);

    // Laptop: the inline column /search has always had, full-shell width, no sidebar.
    await page.setViewportSize(V.laptop);
    await page.goto('/search');
    const laptop = await geometry(page, V.laptop.height);
    expect(laptop.railW, 'rail is not a sidebar at 1024px').toBeGreaterThan(RAIL_W);
  });
});

test.describe('the rail is ADAPTIVE — 5-6 groups up front, the rest one disclosure away', () => {
  test.use({ viewport: V.desk1440 });

  test('shows at most six groups up front and folds the rest without dropping any', async ({ page }) => {
    await page.goto('/search');
    const g = await geometry(page, V.desk1440.height);

    // Proposal C is not decoration: a persistent sidebar listing every group is the
    // "relocates 46 controls without reducing them" failure rotated ninety degrees, and
    // worse — unlike the old inline block it never scrolls away.
    expect(g.groupsUpFront).toBeLessThanOrEqual(6);
    expect(g.groupsFolded).toBeGreaterThan(0);
    expect(g.groupsUpFront + g.groupsFolded).toBe(g.groupsTotal);
  });

  test('the up-front set CHANGES with the query — that is the whole point', async ({ page }) => {
    const labels = async () =>
      page.evaluate(() => {
        const filters = document.querySelector('.kf-filters');
        return filters
          ? [...filters.children]
              .filter((c) => c.classList.contains('kf-fgroup'))
              .map((c) => c.querySelector('.kf-fgroup__label')?.textContent?.trim() ?? '')
          : [];
      });

    await page.goto('/search');
    const bare = await labels();
    await page.goto('/search?q=swim');
    const swim = await labels();

    expect(bare.length).toBeGreaterThan(0);
    expect(swim.length).toBeGreaterThan(0);
    expect(swim.join('|'), 'the rail is identical for every query — it is not adaptive').not.toBe(bare.join('|'));
  });

  test('a filter the parent applied is never folded away', async ({ page }) => {
    // Folding applied state would leave a parent filtering blind, with the control that
    // clears it hidden behind a disclosure they have no reason to open.
    await page.goto('/search?time=morning&reg=1');
    const foldedIds = await page.evaluate(() =>
      [...document.querySelectorAll('.kf-filters__more .kf-fgroup')].map((g) => g.getAttribute('aria-labelledby')),
    );
    expect(foldedIds).not.toContain('kf-fg-time');
    expect(foldedIds).not.toContain('kf-fg-courses');
  });

  test('folded groups are still real links in the DOM — deep links keep resolving', async ({ page }) => {
    // The Round-18 contract: every chip is a real <Link> carrying aria-current, never a
    // <button>. A folded group that stopped rendering would break the homepage's
    // quick-start deep links AND the back button.
    await page.goto('/search');
    const folded = page.locator('.kf-filters__more');
    await expect(folded).toBeVisible();

    const foldedLinks = await folded.locator('a[href^="/search"]').count();
    expect(foldedLinks).toBeGreaterThan(0);

    // …and a native <details>, so none of this needs JavaScript to reach.
    expect(await folded.evaluate((el) => el.tagName)).toBe('DETAILS');
  });

  test('selected chips still carry aria-current="true" and never aria-pressed', async ({ page }) => {
    await page.goto('/search?age=5-9&region=nvan');
    const selected = page.locator('.kf-filters a[aria-current="true"]');
    expect(await selected.count()).toBeGreaterThan(0);
    // aria-pressed on a link is a WCAG 4.1.2 violation — the exact regression Round 18 fixed.
    expect(await page.locator('.kf-filters a[aria-pressed]').count()).toBe(0);
    // And they are links, not buttons: the URL is the filter state.
    expect(await page.locator('.kf-filters button[aria-current]').count()).toBe(0);
  });

  test('the whole rail is keyboard-operable, including the disclosure', async ({ page }) => {
    await page.goto('/search');
    const summary = page.locator('.kf-filters__more > summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.kf-filters__more[open]')).toHaveCount(1);
    // Focus lands somewhere real inside the now-open group, by Tab alone.
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('.kf-filters__more'));
    expect(inside).toBe(true);
  });
});

test.describe('the query summary states what is being shown, and undoes it', () => {
  test.use({ viewport: V.desk1440 });

  test('carries the page h1 and names the applied filters in plain language', async ({ page }) => {
    await page.goto('/search?q=swim&age=5-9&region=nvan');
    await expect(page.locator('h1.kf-qsum__title')).toContainText('swim');
    const tokens = page.locator('.kf-qsum__tokens li');
    expect(await tokens.count()).toBeGreaterThanOrEqual(2);
  });

  test('each token removes exactly its own filter and leaves the others alone', async ({ page }) => {
    await page.goto('/search?q=swim&age=5-9&region=nvan');
    await page.locator('.kf-qsum__tok', { hasText: 'Ages' }).first().click();
    // Wait for the age param to actually go: the page is already on /search?… so a pattern
    // match against the path would resolve instantly against the PRE-click URL.
    await page.waitForURL((u) => !u.searchParams.has('age'));
    const url = new URL(page.url());
    expect(url.searchParams.get('age')).toBeNull();
    expect(url.searchParams.get('region')).toBe('nvan');
    expect(url.searchParams.get('q')).toBe('swim');
  });

  test('the duplicate hero band is gone from the results page', async ({ page }) => {
    // Quick Win #7: a measured 193px restating the value proposition to a parent who has
    // already arrived and typed a query. Deleting it is half of why the rail lands.
    await page.goto('/search');
    expect(await page.locator('.kf-hero').count()).toBe(0);
  });
});

test.describe('the site finally has navigation', () => {
  test.use({ viewport: V.desk1440 });

  test('offers a home link and real destinations, not just a sign-in button', async ({ page }) => {
    await page.goto('/search');
    const nav = page.locator('.kf-nav');
    await expect(nav.locator('a.kf-nav__word')).toHaveAttribute('href', '/');
    expect(await nav.locator('nav[aria-label="Main"] a').count()).toBeGreaterThanOrEqual(4);
  });

  test('does NOT surface the known-dead Festivals category', async ({ page }) => {
    // /search?q=festival returns zero results with no empty state — a data regression
    // (app/page.tsx records the same query returning 6 listings on 2026-07-14). Promoting
    // a dead link into new, more prominent navigation would multiply the damage, so it
    // stays out until the underlying bug is fixed. Flagged, deliberately not fixed here.
    await page.goto('/search');
    expect(await page.locator('.kf-nav a[href*="festival"]').count()).toBe(0);
  });
});
