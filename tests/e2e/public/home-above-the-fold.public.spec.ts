import { test, expect, devices, type Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// THE HOME PAGE'S FIRST SCREEN — PHONE FIRST (TSD v1.2 §9 M4 T4.1 / AC-01, AC-02, AC-03, AC-17).
//
// ═══ THIS FILE OWNS THE HARD HALF OF THE 90/10 RATIO (TSD §6.2) ═══
// Jon, verbatim: "it should heavily promote SMS. this will be 90% of it. below the fold is ok to
// allow for a search engine and keep the site active." A ratio nobody can measure becomes a debate
// at every future change to this page, so the TSD split it into two tests: a JUDGED weight test
// (the search block is ~a tenth of total height — assessed at the design gate, not automatable)
// and ONE HARD BINARY TEST, which is this file:
//
//     at a phone viewport, THE FIRST SCREEN CONTAINS ZERO SEARCH AFFORDANCES
//     — no search input, no category tile, no quick-start chip.
//
// It passes or it fails. That is the whole point: "90%" stops being an opinion the next person
// can re-argue and becomes a line a diff either crosses or does not.
//
// ═══ WHY PHONE IS ASSERTED FIRST, AND WHY THAT IS ENFORCED RATHER THAN JUST WRITTEN DOWN ═══
// AC-17: the home page is reviewed on a phone first — "this is the frame Jon is judging against"
// (Mod Spec §1.6). `test.describe.configure({ mode: 'serial' })` makes that structural rather than
// decorative: playwright.config.ts sets `fullyParallel: true`, which would otherwise scatter these
// tests across workers and let a desktop PASS be reported while the phone result was still
// unknown. In serial mode the phone block genuinely runs first and a phone failure SKIPS the
// desktop block — the correct semantic for a criterion that says phone is the frame.
//
// ═══ WHY BOTH 390x844 AND THE REAL DEVICE VIEWPORTS ═══
// The TSD names 390x844. That is the iPhone 14's SCREEN height, not its browser VIEWPORT —
// Playwright's own descriptor for iPhone 12/13/14 is 390x664, the screen minus Safari's address
// bar and toolbar (the same 180px trap documented at length in search-above-the-fold.public.
// spec.ts, where it was the entire margin of error). Both are asserted here and neither is a
// substitute for the other:
//   • 390x844 is the TSD's literal, approved figure, and it is the STRICTER of the two for the
//     zero-affordance test — a taller first screen has more room to contain something it should
//     not. Passing at 844 implies passing at 664.
//   • the device descriptors are what a parent's browser actually gives them, and they are the
//     stricter side of the "the offer FITS" test — a shorter first screen is the one the offer
//     can overflow. They come from Playwright's maintained device set, so "a typical phone"
//     cannot be quietly widened here to make a regression pass.
//
// ═══ WHAT THIS ADDS OVER tests/home/front-door.test.tsx ═══
// That unit test renders the page and asserts DOM ORDER — no search affordance appears before the
// weight boundary. It is the right test and it is not this one. "Above the fold" is a rendered,
// geometric property of a real browser at a real viewport with real CSS: a block can be correctly
// ordered and still be pushed off the first screen by a line of copy growing, a font loading, or
// a padding change three files away. Every number below was MEASURED against a real `next start`
// build, not assumed.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

/**
 * SEARCH AFFORDANCES, ENUMERATED. The first three entries are the TSD's own three named items;
 * the fourth is the catch-all that stops a fourth kind being invented.
 *
 * `a[href^="/search"]` is deliberately broad — it catches a category tile, a quick-start chip, a
 * bare "go to search" link and a nav category entry alike, because from the fold's point of view
 * they are the same thing: a visible route into search spending height the offer was given.
 */
const SEARCH_AFFORDANCES: readonly { kind: string; selector: string }[] = [
  { kind: 'search input', selector: 'input[type="search"], input[name="q"]' },
  { kind: 'search form', selector: 'form[action^="/search"], [role="search"]' },
  { kind: 'category tile', selector: '.kf-home__tiles, .kf-home__tile' },
  { kind: 'quick-start chip', selector: '.kf-home__quickstart, .kf-home__chip, [data-quickstart]' },
  { kind: 'link into search', selector: 'a[href^="/search"]' },
];

interface FoundElement {
  kind: string;
  tag: string;
  cls: string | null;
  href: string | null;
  text: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Every element matching `groups` that is RENDERED and INTERSECTS THE FIRST SCREEN.
 *
 * "First screen" is the viewport rectangle with the page unscrolled — intersected on BOTH axes,
 * not just vertically. The horizontal half is load-bearing rather than pedantic: the page's
 * "Skip to search" link sits at `left: -9999px` until focused (app/_components/home.css), so a
 * top-only test would report the one deliberate off-screen element as an above-fold search
 * affordance and this file would fail for the wrong reason forever.
 */
async function inFirstScreen(
  page: Page,
  groups: readonly { kind: string; selector: string }[],
): Promise<FoundElement[]> {
  return page.evaluate((defs: readonly { kind: string; selector: string }[]) => {
    const seen = new Set<Element>();
    const out: FoundElement[] = [];
    for (const { kind, selector } of defs) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const intersects =
          r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
        if (!intersects) continue;
        out.push({
          kind,
          tag: el.tagName.toLowerCase(),
          cls: el.getAttribute('class'),
          href: el.getAttribute('href'),
          text: (el.textContent ?? '').trim().slice(0, 60),
          top: Math.round(r.top + window.scrollY),
          left: Math.round(r.left + window.scrollX),
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
    }
    return out;
  }, groups);
}

/** Document-space box of a single element, for "does the whole thing fit on the first screen". */
async function box(page: Page, selector: string): Promise<{ top: number; bottom: number; height: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} does not exist on this page`);
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top + window.scrollY),
      bottom: Math.round(r.bottom + window.scrollY),
      height: Math.round(r.height),
    };
  }, selector);
}

function describeFound(found: FoundElement[]): string {
  return found
    .map((f) => `      • ${f.kind}: <${f.tag} class="${f.cls ?? ''}" href="${f.href ?? ''}"> ` +
      `at y=${f.top}..${f.top + f.height} x=${f.left} — ${JSON.stringify(f.text)}`)
    .join('\n');
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'load' });
  // Fonts change metrics, and every threshold below was measured with them loaded.
  await page.evaluate(() => document.fonts.ready);
  await expect(page, 'the page must be unscrolled — "first screen" means from the top').toHaveURL(/\/$/);
  expect(await page.evaluate(() => window.scrollY), 'page arrived pre-scrolled').toBe(0);
}

// ═════════════════════════════════════════════════════════════════════════════
// PHONE — FIRST, AND THE FRAME THE PRODUCT IS JUDGED ON (AC-17).
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The TSD's literal figure plus Playwright's own device descriptors. The TSD entry is first so
 * that in serial mode the approved number is the first thing that runs in the whole file.
 */
const PHONES: readonly { name: string; viewport: { width: number; height: number } }[] = [
  // TSD §6.2's approved figure, kept EXACTLY as written even though 844 is a screen height
  // rather than a viewport height — see the header. It is the stricter viewport for this test.
  { name: 'TSD §6.2 fold test — 390x844', viewport: { width: 390, height: 844 } },
  { name: 'iPhone 14', viewport: devices['iPhone 14'].viewport! },
  { name: 'iPhone 12', viewport: devices['iPhone 12'].viewport! },
  { name: 'Pixel 5', viewport: devices['Pixel 5'].viewport! },
  // The narrowest phone in the set. It is the one the offer can overflow, which is why it is here.
  { name: 'Galaxy S9+', viewport: devices['Galaxy S9+'].viewport! },
];

for (const { name, viewport } of PHONES) {
  test.describe(`PHONE ${name} (${viewport.width}x${viewport.height}) — the first screen`, () => {
    test.use({ viewport });

    test('🔴 ZERO search affordances — the binary half of the 90/10 ratio (TSD §6.2)', async ({
      page,
    }) => {
      await gotoHome(page);

      // Prove the page actually rendered BEFORE concluding anything from an empty match set.
      // Without this, a blank or errored page is the easiest possible way to pass this test.
      await expect(
        page.locator('section.kf-home__sms'),
        'the offer block is missing — an empty page would satisfy the assertion below for the ' +
          'worst possible reason',
      ).toHaveCount(1);

      const found = await inFirstScreen(page, SEARCH_AFFORDANCES);

      expect(
        found,
        `${found.length} search affordance(s) render inside the first screen at ${viewport.width}x` +
          `${viewport.height}. TSD §6.2 makes this the one HARD, BINARY test of Jon's 90/10 ` +
          'ratio: at a phone viewport the first screen is the SMS offer and nothing else.\n' +
          describeFound(found) +
          '\n\n    If this is intentional, it is a change to an approved ratio (TSD §6, decided by ' +
          'Jon) and belongs at the design gate — not in this assertion.',
      ).toEqual([]);

      // THE COUNTERWEIGHT, and it matters as much as the line above. "Zero search affordances in
      // the first screen" is trivially satisfiable by deleting search from the page, which would
      // fail AC-07 exactly as loudly. Search must be ABSENT ABOVE and PRESENT BELOW.
      const searchBlock = await box(page, '#kf-home-search');
      expect(
        searchBlock.top,
        'the search block must be BELOW the first screen, not merely missing from it',
      ).toBeGreaterThanOrEqual(viewport.height);
      await expect(
        page.locator('#kf-home-search form[action="/search"] input[name="q"]'),
        'AC-07 — search is demoted, never deleted: a real GET form to /search must still be on ' +
          'the page below the boundary',
      ).toHaveCount(1);
      await expect(
        page.locator('#kf-home-search .kf-home__tile'),
        'AC-07 — the compact category tiles live in the below-boundary block (TSD §6.3, Delta 6)',
      ).not.toHaveCount(0);
    });

    test('the offer is wholly ON the first screen, unscrolled (AC-01)', async ({ page }) => {
      await gotoHome(page);

      const offer = await box(page, 'section.kf-home__sms');
      expect(
        offer.bottom,
        `the offer block runs from ${offer.top}px to ${offer.bottom}px on a ${viewport.height}px ` +
          'first screen — a parent has to scroll to finish reading the thing the page is for',
      ).toBeLessThanOrEqual(viewport.height);
      expect(offer.height, 'a zero-height block would satisfy the line above for the wrong reason')
        .toBeGreaterThan(0);
    });

    test('the first screen answers C-01…C-05 (AC-02)', async ({ page }) => {
      await gotoHome(page);

      // C-01 — what is this? The heading, which is Jon's own wording (app/sms/start/copy.ts).
      const h1 = page.locator('h1.kf-home__sms-title');
      await expect(h1, 'C-01 — one h1, and it is the offer').toHaveCount(1);
      await expect(h1, 'C-01 — the heading says what the product is').toHaveText(
        /activities .*delivered by SMS once per week/i,
      );
      expect((await box(page, 'h1.kf-home__sms-title')).bottom).toBeLessThanOrEqual(viewport.height);

      // C-02…C-05 — the four labelled facts, each checked for the fact it carries AND for being
      // on the first screen. Matched on the LABEL rather than on position, so re-ordering the
      // grid is allowed and dropping one is not.
      const answers: { c: string; label: string; must: RegExp }[] = [
        { c: 'C-02 (what exactly will I get)', label: 'What you get', must: /matched to your kids/i },
        { c: 'C-03 (how often)', label: 'How often', must: /one text a week/i },
        // C-04 is also AC-15 and the mitigation for R-03 — an out-of-area parent handing over a
        // number for a service that cannot cover them. It is the single most expensive fact to
        // lose from this screen.
        { c: 'C-04 (where does it work)', label: 'Where', must: /Metro Vancouver/ },
        { c: 'C-05 (what does it cost)', label: 'Cost', must: /free to receive/i },
      ];

      for (const { c, label, must } of answers) {
        const fact = page.locator('.kf-home__fact').filter({ has: page.locator('dt', { hasText: label }) });
        await expect(fact, `${c} — no "${label}" row in the offer's facts`).toHaveCount(1);
        await expect(fact.locator('dd'), `${c} — the "${label}" row does not answer it`).toHaveText(must);

        const r = await fact.boundingBox();
        expect(r, `${c} — the "${label}" row is not rendered`).not.toBeNull();
        expect(
          Math.round(r!.y + r!.height),
          `${c} — the "${label}" row ends at ${Math.round(r!.y + r!.height)}px on a ` +
            `${viewport.height}px first screen, so a parent must scroll to read it`,
        ).toBeLessThanOrEqual(viewport.height);
      }

      // C-07 — how do I stop it. Not one of T4.1's four ACs, but it is the one compliance fact
      // the offer makes a promise about, and only a rendered test can say it is on the FIRST
      // SCREEN rather than merely on the page.
      const micro = page.locator('.kf-home__sms-micro');
      await expect(micro, 'C-07 — "Reply STOP any time" belongs in the first screen').toHaveText(
        /reply stop any time/i,
      );
      expect((await box(page, '.kf-home__sms-micro')).bottom).toBeLessThanOrEqual(viewport.height);
    });

    test('exactly ONE action in the first screen, and it is the signup CTA (AC-03)', async ({
      page,
    }) => {
      await gotoHome(page);

      // Scoped to <main> — the page's own content. The site nav is a site-wide surface and is
      // governed separately (TSD §6.4); on a phone it is one wordmark and a "Menu" control, and
      // neither is a competing SIGNUP action. What AC-03 forbids is a second action of equal
      // weight in the page's own first screen.
      const actions = await page.evaluate(() => {
        const main = document.querySelector('main');
        if (!main) throw new Error('no <main> — the page did not render its content landmark');
        return Array.from(main.querySelectorAll('a, button, input, summary, [role="button"]'))
          .filter((el) => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
          })
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            cls: el.getAttribute('class'),
            href: el.getAttribute('href'),
            text: (el.textContent ?? '').trim().slice(0, 60),
          }));
      });

      expect(
        actions.map((a) => `<${a.tag} class="${a.cls ?? ''}" href="${a.href ?? ''}"> ${JSON.stringify(a.text)}`),
        'AC-03 — the first screen must offer exactly one action, and it must be unmistakably ' +
          'the main one. Anything else listed here is a competing call to action inside the fold',
      ).toHaveLength(1);
      expect(actions[0].cls, 'the one action must be the signup CTA').toContain('kf-home__sms-cta');
      expect(actions[0].href, 'and it must point at the signup destination').toBe('/sms/start');

      // THE ONE DELIBERATE EXCEPTION, ASSERTED RATHER THAN IGNORED. "Skip to search" is the first
      // tab stop and the only above-fold route into search that costs the fold no height — it is
      // parked at left:-9999px until focused. Pinning that here means it cannot be "improved"
      // into a visible above-fold search affordance without this file failing.
      const skip = await box(page, 'a.kf-home__skip');
      const skipLeft = await page.evaluate(
        () => Math.round(document.querySelector('a.kf-home__skip')!.getBoundingClientRect().left),
      );
      expect(skip.height, 'the skip link must still exist — it is AC-07 for keyboard users')
        .toBeGreaterThan(0);
      expect(
        skipLeft,
        'the skip link is rendered ON screen while unfocused, so it now spends fold budget and ' +
          'puts a visible route into search inside the first screen',
      ).toBeLessThan(0);
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// DESKTOP — SECOND, DELIBERATELY (AC-17).
// ═════════════════════════════════════════════════════════════════════════════

test.describe('DESKTOP 1280x900 — the first screen (asserted after phone, per AC-17)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the offer, its facts and the one CTA are all above the fold (AC-01, AC-02, AC-03)', async ({
    page,
  }) => {
    await gotoHome(page);

    const offer = await box(page, 'section.kf-home__sms');
    expect(offer.bottom, 'the offer must finish inside the first screen at desktop width too')
      .toBeLessThanOrEqual(900);

    await expect(page.locator('.kf-home__fact')).toHaveCount(4);
    expect((await box(page, '.kf-home__facts')).bottom).toBeLessThanOrEqual(900);

    const cta = page.locator('main a.kf-home__sms-cta');
    await expect(cta, 'AC-03 — one signup action in the page content, not two').toHaveCount(1);
    expect((await box(page, 'main a.kf-home__sms-cta')).bottom).toBeLessThanOrEqual(900);
  });

  test('the page CONTENT still shows no search affordance above the fold', async ({ page }) => {
    await gotoHome(page);

    // Scoped to <main>, and the scope is the finding rather than a convenience. TSD §6.4 settles
    // the tension explicitly: the global nav keeps its category row, because the 90/10 governs
    // the HOME PAGE'S CONTENT weight and stripping a site-wide nav would degrade every other page
    // to serve a ratio about one of them — and because removing it would make search MENU-ONLY,
    // which is precisely what "not buried behind a menu-only link" forbids.
    const found = (await inFirstScreen(page, SEARCH_AFFORDANCES)).filter((f) => !f.cls?.includes('kf-nav__'));
    expect(
      found,
      'the home page\'s own content put a search affordance above the fold at desktop width:\n' +
        describeFound(found),
    ).toEqual([]);

    const searchBlock = await box(page, '#kf-home-search');
    expect(searchBlock.top, 'the search block must still be below the first screen at 900px')
      .toBeGreaterThanOrEqual(900);
  });

  test('TSD §6.4 — the nav category row is above the fold BY DECISION, and is still there', async ({
    page,
  }) => {
    await gotoHome(page);

    // The mirror image of the test above: §6.4's resolution was "keep the category row, add one
    // SMS entry". Asserting it POSITIVELY means the resolution cannot be quietly reverted in
    // either direction — the row cannot vanish (which would make search menu-only on desktop),
    // and the SMS entry cannot vanish with it.
    //
    // `:visible` IS REQUIRED, NOT TIDINESS. SiteNav renders its destination list TWICE — once as
    // the desktop row (`.kf-nav__list`) and once inside the collapsed `<details>` Menu
    // (`.kf-nav__menu`), which is how one component serves both breakpoints with no JavaScript.
    // Both copies are in the DOM at every width; CSS decides which is rendered. Counting DOM
    // nodes would therefore report two of everything and say nothing about the fold.
    await expect(
      page.locator('header.kf-nav a[href^="/search"]:visible'),
      'the site nav lost its category row — TSD §6.4 keeps it precisely so search does not ' +
        'become menu-only. Removing it is a decision, not a tidy-up',
    ).not.toHaveCount(0);
    await expect(
      page.locator('header.kf-nav a[href="/sms/start"]:visible'),
      'TSD §6.4 — the nav gained exactly one SMS entry; it must still be there, and exactly once',
    ).toHaveCount(1);
  });
});
