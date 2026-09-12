import { test, expect, devices, type Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// /search — the first result has to be ON the first screen of a phone.
//
// ═══ WHY THIS FILE EXISTS WHEN search-mobile-filter-sheet.public.spec.ts ALREADY
//     MEASURES `firstResultTop` ═══
// That spec measures at `{ width: 390, height: 844 }` and passes when the first card is
// inside 1.2 viewport-heights. Both numbers are wrong for this question, and together they
// are why a page whose results start below the fold audited as fixed:
//
//   • 844 is the iPhone 14's SCREEN height, not its browser VIEWPORT. Playwright's own
//     descriptor for iPhone 12/13/14 is 390x664 — the screen minus Safari's address bar and
//     toolbar. The 180px difference is the entire margin of error on this measurement.
//   • "within 1.2 viewport-heights" is by construction a threshold that PERMITS a result
//     starting a fifth of a screen BELOW the fold. It was written to catch the inline filter
//     stack coming back (~1,470px, 1.74vh) and it is still a good guard for that; it was
//     never an above-the-fold assertion and should not be read as one.
//
// So that spec keeps its job — "the filter stack is not inline again" — and this one owns
// the question it was mistaken for: can a parent see a result without scrolling?
//
// ═══ MEASURED, NOT ASSUMED ═══
// Before the fix the first card sat at 617px on a 664px viewport: 47px of a 208px card, which
// is a sliver of a border and no words. The costs were the sort row (94px — the "Sort" label
// and four chips wrapped over THREE lines at 390px) and ~107px of margins tuned at desktop
// width. Both are addressed in the max-width:767px block of app/search/search.css.
//
// ═══ WHY THESE VIEWPORTS ═══
// They are Playwright's own device descriptors, not hand-picked numbers, so the definition of
// "a typical phone" is maintained upstream and cannot be quietly widened here to make a
// regression pass.
// ─────────────────────────────────────────────────────────────────────────────

/** Document-Y and height of the first result card. */
async function firstCard(page: Page): Promise<{ top: number; height: number }> {
  return page.evaluate(() => {
    const card = document.querySelector('.kf-card');
    if (!card) throw new Error('no .kf-card rendered — the fixture search returned nothing');
    const r = card.getBoundingClientRect();
    return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
  });
}

/** The phone classes this product is actually used on, straight from Playwright's device set. */
const PHONES = ['iPhone 12', 'iPhone 14', 'iPhone 14 Pro', 'iPhone 15', 'Pixel 5', 'Galaxy S9+'] as const;

for (const name of PHONES) {
  const device = devices[name];

  test.describe(`${name} (${device.viewport!.width}x${device.viewport!.height}) — /search`, () => {
    test.use({ viewport: device.viewport! });

    test('the first result starts above the fold', async ({ page }) => {
      await page.goto('/search');
      await page.evaluate(() => document.fonts.ready);

      const { top, height } = await firstCard(page);
      const vh = device.viewport!.height;

      expect(
        top,
        `first result starts at ${top}px on a ${vh}px viewport — a parent has to scroll before ` +
          'seeing any result at all',
      ).toBeLessThan(vh);

      // Nothing below the fold is measured here, only that the card genuinely begins on screen.
      expect(height, 'a zero-height card would satisfy the line above for the wrong reason').toBeGreaterThan(0);
    });
  });
}

test.describe('the mainstream phone sees a USABLE amount of the first result', () => {
  // 390x664 — the iPhone 12/13/14 descriptor, the single most common viewport this product
  // is opened on.
  test.use({ viewport: devices['iPhone 14'].viewport! });

  test('enough of the card is on screen to read what it is, not just its top border', async ({ page }) => {
    await page.goto('/search');
    await page.evaluate(() => document.fonts.ready);

    const { top, height } = await firstCard(page);
    const visible = 664 - top;

    // 96px is the measured height of the card's identifying block — the type eyebrow, the
    // activity name and the first line of schedule metadata. Below that a parent can see
    // that a result exists without being able to tell what it is, which is not the promise
    // "results are above the fold" makes. Measured at 131px after the fix, so the threshold
    // leaves room for a line of copy to grow without going red.
    expect(
      visible,
      `only ${visible}px of a ${height}px card is on screen (card starts at ${top}px)`,
    ).toBeGreaterThanOrEqual(96);
  });

  test('the chrome above the results stays within its budget', async ({ page }) => {
    await page.goto('/search');
    await page.evaluate(() => document.fonts.ready);

    // A direct guard on the thing that actually regresses: total height of everything between
    // the top of the document and the first card. 560px is the measured 533 plus a small
    // allowance; it fails loudly if a new banner, notice or control is added above the results
    // without something else giving way.
    const { top } = await firstCard(page);
    expect(top, 'something new was added above the results').toBeLessThanOrEqual(560);
  });

  test('the sort control is one thumb-rail line, and every option is still a real link', async ({ page }) => {
    await page.goto('/search');
    await page.evaluate(() => document.fonts.ready);

    const controls = page.locator('.kf-sbar__controls');
    await expect(controls).toBeVisible();

    // One line. The wrapped three-line version was 94px; a single rail of 32px chips is ~44px.
    const box = await controls.boundingBox();
    expect(box!.height, 'the sort row is wrapping again').toBeLessThanOrEqual(56);

    // Rail, not truncation: the options are all still there and still reachable.
    const options = controls.getByRole('link');
    expect(await options.count(), 'sort options went missing when the row stopped wrapping').toBeGreaterThanOrEqual(4);

    // Every one is a real URL navigation, exactly as before — this changed painting, not
    // architecture. (`aria-current` marks the active option; see SearchBar.tsx.)
    for (const href of await options.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
      // `/search` with no query string is the default sort's own href — params.ts omits a
      // param that equals the default rather than spelling it out.
      expect(href).toMatch(/^\/search(\?|$)/);
    }
    await expect(controls.locator('[aria-current="true"]')).toHaveCount(1);

    // The rail scrolls rather than hiding its overflow, which is what makes the one-line
    // layout honest — the off-screen options are reachable by the same swipe every other
    // filter rail on this page uses.
    const scrollable = await controls.evaluate((el) => el.scrollWidth > el.clientWidth);
    const overflowX = await controls.evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('auto');
    expect(scrollable, 'if nothing overflows, the rail is not being exercised by this fixture').toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A FILTERED SEARCH IS STILL BELOW THE FOLD. THIS IS RECORDED, NOT HIDDEN.
  //
  // Measured at 390x664 with the fixture catalogue, once ANY filter is applied:
  //     /search?q=swim      706px      /search?age=5-9     713px
  //     /search?free=1      735px      /search?when=today  890px
  //     /search?region=nvan&when=today                    1122px
  //
  // Filtering adds three blocks the bare landing does not have, and NONE of them is the
  // filter-chrome this change was scoped to:
  //     (+108px  `.kf-savebar` — the signed-out "Save this search" control and its
  //             "Sign in with Google to save searches…" explanation, rendered ABOVE the
  //             page's own <h1>. REMOVED 2026-09-12 with Google sign-in, so this block no
  //             longer exists and the budgets below are met with 108px to spare. The line is
  //             kept because the measured totals it explains were taken with it present.)
  //     + 26px  the sticky bar's applied-filter summary line;
  //     + 22px  the applied-filter token row inside QuerySummary.
  // And on a thin-coverage query the honesty notices stack on top of that: the coverage
  // notice (200px, including its "email me when this area is live" form), the broadening
  // notice (98px) and the constraint explanation (59px) — which is the whole 1122px case.
  //
  // Those notices are NOT accidental chrome. app/search/page.tsx argues their ORDER at
  // length and on the record ("a parent who reads 'widen your dates' before they read this
  // one has already been sent somewhere that cannot help"), and the save control is a
  // product surface. Shortening any of them is a copy or product decision, not a layout fix,
  // so this change does not take it — and does not quietly pick an easier query to measure
  // either. The guard below therefore pins the CURRENT number so the gap cannot widen while
  // nobody is looking, and says plainly in its own failure message that it is a floor, not
  // an endorsement.
  // ═══════════════════════════════════════════════════════════════════════════
  test('a filtered search does not get any worse than it already is', async ({ page }) => {
    await page.goto('/search?q=swim');
    await page.evaluate(() => document.fonts.ready);

    const cards = await page.locator('.kf-card').count();
    test.skip(cards === 0, 'this fixture query returns nothing — nothing to measure');

    const { top } = await firstCard(page);
    expect(
      top,
      `a one-filter search starts its first result at ${top}px on a 664px viewport. That is ` +
        'STILL BELOW THE FOLD and is a known, documented gap (see the comment above this ' +
        'test) — this assertion only stops it growing. If it has grown, something was added ' +
        'above the results.',
    ).toBeLessThanOrEqual(740);
  });
});

test.describe('desktop /search is untouched by the mobile fold work', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the sort row still wraps, and the filter rail is still a sidebar', async ({ page }) => {
    await page.goto('/search');

    // The rail treatment is scoped to max-width:767px. At desktop width the row has room to
    // lay its chips out normally and must not have become a scroller.
    const overflowX = await page.locator('.kf-sbar__controls').evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('visible');

    await expect(page.locator('.kf-filters')).toBeVisible();
    await expect(page.locator('.kf-mfilters')).toBeHidden();
  });
});
