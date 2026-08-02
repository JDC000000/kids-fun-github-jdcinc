import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// ─────────────────────────────────────────────────────────────────────────────
// /search — mobile sticky filter bar + filter bottom sheet (Visual Blueprint v0.2
// §04 / Screen 5). Approved, specified, and unbuilt until now.
//
// WHY THIS IS A BROWSER TEST AND NOT A COMPONENT TEST
// Every claim below depends on something the node test environment does not have:
// media-query matching (the same DOM node is an inline rail at >=768px and a modal
// sheet at <=767px), layout (the "how much chrome sits above the first result"
// measurement), and real focus/scroll behaviour. The desktop-shell regression —
// a single missing media query that every jsdom test in the suite happily passed —
// is the standing proof that this cannot be verified without a browser.
//
// WHY THE ACCESSIBILITY ASSERTIONS ARE HARD FAILURES HERE
// tests/e2e/a11y/*.a11y.spec.ts is deliberately audit-only (records, never fails) so
// it can sweep pre-existing findings across the whole app. A modal dialog is the one
// component where a missing focus trap or a stray aria attribute is not a finding to
// log but a control a parent cannot escape, so this spec gates on them directly and
// scopes its axe run to the sheet.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

const panel = (page: Page) => page.locator('#kf-msheet-panel');
const filtersTrigger = (page: Page) => page.getByRole('button', { name: /^⚙?\s*Filters/ });

/** Document-Y of the first result card — the measurement the design audits used. */
async function firstResultTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const card = document.querySelector('.kf-card');
    if (!card) throw new Error('no .kf-card rendered — the fixture search returned nothing');
    return Math.round(card.getBoundingClientRect().top + window.scrollY);
  });
}

test.describe('mobile /search — the filter stack is behind a sheet, not above the results', () => {
  test.use({ viewport: PHONE });

  test('a parent reaches the first result inside one viewport-height', async ({ page }) => {
    await page.goto('/search');

    const top = await firstResultTop(page);
    const viewportHeights = top / PHONE.height;
    // Pre-change this was ~1,470px / ~1.74 viewport-heights of filter chrome. The
    // threshold is deliberately loose (results must simply start within the first
    // screenful-and-a-bit); it exists to fail loudly if the inline stack ever comes back.
    expect(
      viewportHeights,
      `first result sits ${top}px down (${viewportHeights.toFixed(2)} viewport-heights) — the filter stack is inline again`,
    ).toBeLessThan(1.2);

    // The permanently-expanded rail must not be rendered above the results at all.
    await expect(page.locator('.kf-filters')).toBeHidden();
  });

  test('the sticky bar summarises the filter state and stays reachable deep into the results', async ({ page }) => {
    await page.goto('/search');

    const bar = page.locator('.kf-mfilters');
    await expect(bar).toBeVisible();
    // Untouched search: both named controls read as "no constraint", never as a filter.
    await expect(bar).toContainText('Any day');
    await expect(bar).toContainText('Any area');

    // Measured WITHOUT interacting — Playwright's .click() auto-scrolls its target into
    // view, which would mask a bar that had scrolled away (the /preview lesson).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => window.scrollY > 600);
    await expect(bar).toBeInViewport({ ratio: 0.9 });

    // …and the trigger still works from down here.
    await filtersTrigger(page).click();
    await expect(panel(page)).toBeVisible();
  });

  test('the bar reports deep-linked filter state, so a parent is never filtering blind', async ({ page }) => {
    await page.goto('/search?region=nvan&when=today&age=5-9');

    const bar = page.locator('.kf-mfilters');
    await expect(bar).toContainText('Today');
    await expect(bar).toContainText('North Van');
    // when + areas + ages = 3 constraints, stated as a badge AND in words.
    await expect(bar.locator('.kf-mfilters__count')).toHaveText('3');
    await expect(bar).toContainText('3 filters applied');
  });
});

test.describe('mobile /search — the sheet is a real dialog', () => {
  test.use({ viewport: PHONE });

  test('opens with dialog semantics, a named heading and focus moved inside', async ({ page }) => {
    await page.goto('/search');
    const trigger = filtersTrigger(page);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Filters' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Focus is INSIDE the sheet, not left behind on the page underneath it.
    expect(await page.evaluate(() => document.querySelector('#kf-msheet-panel')!.contains(document.activeElement))).toBe(
      true,
    );

    // The full filter set is REACHABLE — nothing is dropped. Since the desktop-rail work
    // (Round 31) the same single FilterRail instance carries an adaptive plan at every
    // breakpoint, so a group that cannot narrow the current query renders inside the
    // "More filters" <details> instead of up front. Reachable, not necessarily on screen:
    // asserting visibility here would be asserting that the reduction had NOT happened.
    for (const id of ['when', 'time', 'ages', 'areas', 'quick', 'cost', 'near', 'courses', 'daterange']) {
      await expect(dialog.locator(`[aria-labelledby="kf-fg-${id}"]`)).toHaveCount(1);
    }
    // …and whatever is folded is one keyboard-operable, JS-free disclosure away.
    const folded = dialog.locator('.kf-filters__more');
    if (await folded.count()) {
      await folded.locator('summary').click();
      await expect(dialog.getByRole('group', { name: 'Max price' })).toHaveCount(1);
    }
  });

  test('Esc closes it and returns focus to the exact control that opened it', async ({ page }) => {
    await page.goto('/search');
    const trigger = filtersTrigger(page);
    await trigger.click();
    await expect(panel(page)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(panel(page)).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  test('the Close button closes it and also returns focus to its opener', async ({ page }) => {
    await page.goto('/search');
    // Open from the WHEN control specifically — focus must come back HERE, not to
    // whichever trigger happens to be first in the DOM.
    const whenTrigger = page.getByRole('button', { name: /^When/ });
    await whenTrigger.click();
    await expect(panel(page)).toBeVisible();

    await page.getByRole('button', { name: 'Close filters' }).click();

    await expect(panel(page)).toBeHidden();
    await expect(whenTrigger).toBeFocused();
  });

  test('"Show results" dismisses the sheet from the thumb zone', async ({ page }) => {
    await page.goto('/search');
    await filtersTrigger(page).click();
    await page.getByRole('button', { name: 'Show results' }).click();
    await expect(panel(page)).toBeHidden();
  });

  test('traps focus: Tab can never walk out onto the page behind the sheet', async ({ page }) => {
    await page.goto('/search');
    await filtersTrigger(page).click();
    await expect(panel(page)).toBeVisible();

    // Tab well past the number of controls in the sheet; focus must wrap, never escape.
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        document.querySelector('#kf-msheet-panel')!.contains(document.activeElement),
      );
      expect(inside, `focus left the dialog after ${i + 1} Tab presses`).toBe(true);
    }

    // Shift+Tab wraps backwards too.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Shift+Tab');
      const inside = await page.evaluate(() =>
        document.querySelector('#kf-msheet-panel')!.contains(document.activeElement),
      );
      expect(inside, `focus left the dialog after ${i + 1} Shift+Tab presses`).toBe(true);
    }
  });

  test('locks the page behind it, and gives the parent their place back on close', async ({ page }) => {
    await page.goto('/search', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(200);

    // Where a real card sits on screen — the thing a parent would actually notice moving.
    const cardY = () => page.evaluate(() => Math.round(document.querySelector('.kf-card')!.getBoundingClientRect().top));

    // Baseline and open happen in ONE task, deliberately. Two things would otherwise
    // corrupt a baseline taken over the wire: Playwright's .click() auto-scrolls its
    // target into view (and `html { scroll-padding-top }` makes it nudge even a control
    // that is already visible), and Chrome's scroll anchoring keeps adjusting the offset
    // by ~10px while webfonts settle the document height. Neither is the scroll lock;
    // measuring across them would report a drift this test would then blame on the sheet.
    const before = await page.evaluate(() => {
      const y = {
        card: Math.round(document.querySelector('.kf-card')!.getBoundingClientRect().top),
        scrollY: Math.round(window.scrollY),
      };
      (document.querySelector('.kf-mfilters__btn--all') as HTMLButtonElement).click();
      return y;
    });
    await expect(panel(page)).toBeVisible();
    const yBeforeOpen = before.card;
    const scrollBeforeOpen = before.scrollY;
    expect(scrollBeforeOpen, 'the page needs to be genuinely scrolled for this test to mean anything').toBeGreaterThan(
      100,
    );

    // Opening the sheet must not shift the results underneath it…
    expect(Math.abs((await cardY()) - yBeforeOpen)).toBeLessThanOrEqual(2);

    // …and REAL scroll input over the sheet must not move them either. (Note the method:
    // `window.scrollBy` would "pass" against a broken lock — per spec, an overflow:hidden
    // box is still programmatically scrollable, so asserting on it proves nothing.)
    await page.mouse.move(195, 200);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(150);
    expect(Math.abs((await cardY()) - yBeforeOpen), 'the results scrolled away under the open sheet').toBeLessThanOrEqual(
      2,
    );

    // The lock is released on close — and the parent is put back exactly where they were,
    // not at the top of a re-scrolled page.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    expect(Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - scrollBeforeOpen)).toBeLessThanOrEqual(2);
    expect(Math.abs((await cardY()) - yBeforeOpen)).toBeLessThanOrEqual(2);

    // …and the page scrolls normally again.
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(scrollBeforeOpen);
  });

  test('honours prefers-reduced-motion — the sheet opens, it just does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/search');
    await filtersTrigger(page).click();

    await expect(panel(page)).toBeVisible();
    const animation = await page.evaluate(
      () => getComputedStyle(document.querySelector('#kf-msheet-panel')!).animationName,
    );
    expect(animation).toBe('none');
  });

  test('axe finds no accessibility violations inside the open sheet', async ({ page }) => {
    await page.goto('/search');
    await filtersTrigger(page).click();
    await expect(panel(page)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('#kf-msheet-panel')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    expect(
      results.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`),
      'the sheet is a new component — it ships clean or it does not ship',
    ).toEqual([]);
  });
});

test.describe('mobile /search — the sheet does not break URL-driven filter state', () => {
  test.use({ viewport: PHONE });

  test('a filter set inside the sheet lands in the URL and the sheet stays open for the next one', async ({ page }) => {
    await page.goto('/search');
    await filtersTrigger(page).click();
    const dialog = page.getByRole('dialog', { name: 'Filters' });

    // Every chip is still a real <a href> — the URL-state architecture the homepage
    // quick-start links depend on (Chip.tsx, Round 18) is untouched by the relocation.
    const today = dialog.getByRole('group', { name: 'When' }).getByRole('link', { name: 'Today' });
    await expect(today).toHaveAttribute('href', /when=today/);
    await today.click();

    await expect(page).toHaveURL(/when=today/);
    await expect(today).toHaveAttribute('aria-current', 'true');

    // A parent setting several filters must not have to reopen the sheet each time.
    await expect(dialog).toBeVisible();

    // A second filter, from a different group, composes with the first.
    await dialog.getByRole('group', { name: 'Areas' }).getByRole('link', { name: 'North Van' }).click();
    await expect(page).toHaveURL(/when=today/);
    await expect(page).toHaveURL(/region=nvan/);
    await expect(dialog).toBeVisible();

    // Close: the bar now reports what the URL says.
    await page.keyboard.press('Escape');
    await expect(page.locator('.kf-mfilters')).toContainText('Today');
    await expect(page.locator('.kf-mfilters')).toContainText('North Van');
  });

  test('the sheet state survives the back button, and the filters come back with it', async ({ page }) => {
    await page.goto('/search');
    await filtersTrigger(page).click();
    await page
      .getByRole('dialog', { name: 'Filters' })
      .getByRole('group', { name: 'When' })
      .getByRole('link', { name: 'Today' })
      .click();
    await expect(page).toHaveURL(/when=today/);

    await page.goBack();
    await expect(page).not.toHaveURL(/when=today/);
    // Back-button-safe: the deep-linked state is gone from the bar too, not just the URL.
    await expect(page.locator('.kf-mfilters')).toContainText('Any day');
  });

  test('"Clear all" from the bar wipes the filters but keeps the query', async ({ page }) => {
    await page.goto('/search?q=swim&region=nvan&when=today');
    await expect(page.locator('.kf-mfilters__count')).toBeVisible();

    await page.locator('.kf-mfilters').getByRole('link', { name: 'Clear all' }).click();

    await expect(page).toHaveURL(/q=swim/);
    await expect(page).not.toHaveURL(/region=nvan/);
    await expect(page.locator('.kf-mfilters')).toContainText('Any area');
  });
});

test.describe('desktop /search — untouched by the mobile work', () => {
  test.use({ viewport: DESKTOP });

  test('keeps a persistent filter rail, with no sticky bar and no dialog anywhere', async ({ page }) => {
    await page.goto('/search');

    // Still the same single FilterRail instance, still server-rendered, still visible.
    await expect(page.locator('.kf-filters')).toBeVisible();
    // Every group is present in the DOM at this width (up front or folded) — the
    // primary/secondary split itself is asserted in search-desktop-rail.public.spec.ts.
    for (const id of ['when', 'time', 'ages', 'areas', 'quick', 'cost', 'near', 'courses', 'daterange']) {
      await expect(page.locator(`[aria-labelledby="kf-fg-${id}"]`)).toHaveCount(1);
    }

    // None of the sheet's chrome exists at this width…
    await expect(page.locator('.kf-mfilters')).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close filters' })).toBeHidden();

    // …and the rail is a real sidebar beside the results rather than a block above them.
    // (Superseded assertion: this used to check the inline rail's own 3-column chip grid,
    // which was the pre-rail desktop layout. Round 31 replaced that layout; the geometry
    // that matters now — 200px sidebar, results to its right — is pinned in the desktop
    // rail spec, and re-asserted in one line here so this file cannot silently pass while
    // the rail has collapsed back into the content column.)
    const box = await page.locator('.kf-filters').boundingBox();
    expect(box?.width).toBeLessThanOrEqual(240);
  });
});
