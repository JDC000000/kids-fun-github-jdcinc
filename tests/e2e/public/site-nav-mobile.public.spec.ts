import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  SEARCH_SHORTCUTS,
  destinationHref,
  liveCategoryDestinations,
} from '../../../app/_lib/nav-destinations';

// ─────────────────────────────────────────────────────────────────────────────
// THE MOBILE NAV CLIPPED FOUR OF SIX DESTINATIONS (design/QA audit, 2026-09-04).
//
// MEASURED IN THIS HARNESS against the pre-fix stylesheet, so the numbers below are this
// file's own output rather than a report of someone else's:
//     390px — 200.4px of a 456px row visible. Fully visible: "What's on now", "Swimming".
//             CLIPPED MID-WORD: "Storytime". Entirely off the end: "Indoor play",
//             "Classes", "Free".
//     360px — 170.4px visible; ONE destination readable.
//     320px — 130.4px visible; ONE destination readable.
// The only affordance was a right-edge fade mask that faded warm paper to transparent ON
// warm paper — invisible in a screenshot, so the sole cue that four more destinations
// existed was text appearing to stop.
//
// It is arithmetic, not tuning: six pills need ~456px and a 390px phone offers ~200px once
// the wordmark and the account control are paid for. Below 768px the row is therefore not
// rendered at all and a native <details> menu lists every destination; at 768px and above,
// where the row already fitted, NOTHING changes — asserted here too, because "fixed the
// phone, broke the desktop" is the obvious way for this change to go wrong.
//
// WHY PLAYWRIGHT AND NOT ONLY VITEST: the defect is pure CSS layout — overflow, clipping,
// stacking, tap-target size. vitest runs in `node` with no layout engine, so its sibling
// (tests/ui/site-nav-mobile.test.tsx) can only assert the CSS DECLARATIONS. This spec
// MEASURES a real Chromium layout pass. It is self-contained (page.setContent, no server,
// no database), like tests/e2e/public/freshness-stamp-mobile.public.spec.ts, so it needs
// nothing seeded and cannot flake on data.
//
// ⚠ The nav DOM below is HAND-BUILT and could drift from SiteNav.tsx. The guard test at the
// top reads the real component and fails if its class contract changes — the same anti-drift
// device the freshness spec uses, for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

function readRepoFile(rel: string): string {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) throw new Error(`site-nav spec: expected file not found: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

const NAV_SRC = readRepoFile('app/_components/SiteNav.tsx');
const CSS =
  readRepoFile('app/design-tokens.css') + '\n' + readRepoFile('app/_components/site-nav.css');

// The REAL destination list, imported rather than restated, so a category added or retired
// in app/_lib/nav-destinations.ts is measured here automatically.
const LINKS = [
  { href: SEARCH_SHORTCUTS.onNow.href, label: SEARCH_SHORTCUTS.onNow.label, primary: true },
  ...liveCategoryDestinations().map((d) => ({ href: destinationHref(d), label: d.label, primary: false })),
  { href: SEARCH_SHORTCUTS.free.href, label: SEARCH_SHORTCUTS.free.label, primary: false },
];

const MOBILE = [320, 360, 390, 414];
const DESKTOP = [768, 1024, 1440];
const TOL = 0.6;

/**
 * Pre-fix bar height on a phone. This was MEASURED at 68.5px back when a 44px "Sign in with
 * Google" target set it. That pill was removed on 2026-09-12 and the bar now measures 50px,
 * so this is no longer a description of the current bar — it is deliberately KEPT as the
 * ceiling the compact menu must never push the bar back up to. The assertion below is
 * `<=`, so the 18.5px the removal freed is headroom, not a failure.
 */
const BASELINE_MOBILE_BAR = 68.5;

const items = LINKS.map(
  (l) => `<li><a class="kf-nav__link${l.primary ? ' kf-nav__link--strong' : ''}" href="${l.href}">${l.label}</a></li>`
).join('');

const ICON =
  '<svg class="kf-nav__more-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path d="M1 3h14M1 8h14M1 13h14" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" fill="none"/></svg>';

/** `sticky` adds a stand-in for /search's real `.kf-sbar` (position:sticky; top:0; z-index:20). */
function buildPage(open: boolean, sticky = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}
html,body{margin:0}
.sbar{position:sticky;top:0;z-index:20;background:#cfe;padding:14px 16px;border-bottom:1px solid #999}
</style></head><body>
<header class="kf-nav"><div class="kf-nav__inner">
  <a class="kf-nav__word" href="/">KIDS<span class="kf-nav__word-b">FUN</span></a>
  <nav class="kf-nav__primary" aria-label="Main">
    <ul class="kf-nav__list">${items}</ul>
    <details class="kf-nav__more"${open ? ' open' : ''}>
      <summary class="kf-nav__more-toggle">${ICON}Menu</summary>
      <ul class="kf-nav__menu">${items}</ul>
    </details>
  </nav>
</div></header>
<main>${sticky ? '<div class="sbar">Search</div>' : ''}<p style="padding:16px">page content</p><div style="height:1600px"></div></main>
</body></html>`;
}

test.describe('mobile nav: every destination is reachable below 768px', () => {
  test('guard: SiteNav still emits the class contract this spec hand-builds', () => {
    expect(NAV_SRC, 'the wide inline row').toContain('<ul className="kf-nav__list">');
    expect(NAV_SRC, 'the compact menu container').toMatch(/<details\s+className="kf-nav__more"/);
    expect(NAV_SRC, 'the menu toggle').toContain('<summary className="kf-nav__more-toggle">');
    expect(NAV_SRC, 'the menu list').toContain('<ul className="kf-nav__menu">');
    expect(LINKS.length, 'the shared destination list should be non-trivial').toBeGreaterThan(3);
    // The hand-built DOM above no longer contains an account pill, because SiteNav no longer
    // renders one (Jon, 2026-09-12). If it comes back, this spec would silently be measuring a
    // bar that is narrower than the real one — so fail here instead.
    //
    // Matched against COMMENT-STRIPPED source, the same discipline tests/ui/site-nav-mobile
    // .test.tsx applies to the stylesheet: SiteNav's own prose explains why the pill was
    // removed and necessarily names it (and `hidesAccountNav`), so a raw substring check
    // fails against the explanation rather than the code.
    const navCode = NAV_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(navCode, 'the account pill must stay removed').not.toMatch(/<AccountNav\b/);
    expect(navCode, 'AccountNav must not be re-imported').not.toMatch(/from\s+'\.\/AccountNav'/);
    expect(navCode, 'no sign-in affordance in the bar').not.toContain('/auth/signin');
  });

  for (const width of MOBILE) {
    test(`${width}px — closed: the clipping strip is gone and the menu control is tappable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.setContent(buildPage(false), { waitUntil: 'load' });

      const r = await page.evaluate(() => {
        const list = document.querySelector('.kf-nav__list')!;
        const more = document.querySelector('.kf-nav__more')!;
        const sum = document.querySelector('.kf-nav__more-toggle')!.getBoundingClientRect();
        return {
          listDisplay: getComputedStyle(list).display,
          moreDisplay: getComputedStyle(more).display,
          panelBoxes: document.querySelector('.kf-nav__menu')!.getClientRects().length,
          barHeight: +document.querySelector('.kf-nav__inner')!.getBoundingClientRect().height.toFixed(2),
          summaryHeight: +sum.height.toFixed(2),
          summaryRight: +sum.right.toFixed(2),
          pageHScroll: +(document.documentElement.scrollWidth - window.innerWidth).toFixed(2),
        };
      });

      expect(r.listDisplay, 'the overflowing inline row must not render on a phone').toBe('none');
      expect(r.moreDisplay, 'the compact menu control must render on a phone').toBe('block');
      expect(r.panelBoxes, 'a closed menu must not paint its panel').toBe(0);
      expect(r.barHeight, 'a closed menu must cost the bar no extra height').toBeLessThanOrEqual(BASELINE_MOBILE_BAR);
      expect(r.summaryHeight, 'WCAG 2.2 target size').toBeGreaterThanOrEqual(44);
      expect(r.summaryRight, 'the control sits inside the viewport').toBeLessThanOrEqual(width + TOL);
      expect(r.pageHScroll, 'the page must not scroll horizontally').toBeLessThanOrEqual(TOL);
    });

    test(`${width}px — open: all ${LINKS.length} destinations legible, unclipped, in-viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.setContent(buildPage(true), { waitUntil: 'load' });

      const r = await page.evaluate((vw) => {
        const menu = document.querySelector('.kf-nav__menu')!;
        const mr = menu.getBoundingClientRect();
        return {
          panelRight: +mr.right.toFixed(2),
          panelLeft: +mr.left.toFixed(2),
          barHeight: +document.querySelector('.kf-nav__inner')!.getBoundingClientRect().height.toFixed(2),
          pageHScroll: +(document.documentElement.scrollWidth - vw).toFixed(2),
          links: Array.from(menu.querySelectorAll('.kf-nav__link')).map((a) => {
            const b = a.getBoundingClientRect();
            return {
              label: (a.textContent || '').trim(),
              href: a.getAttribute('href'),
              height: +b.height.toFixed(2),
              left: +b.left.toFixed(2),
              right: +b.right.toFixed(2),
              selfClip: +(a.scrollWidth - a.clientWidth).toFixed(2),
              // Is this exact element the thing a thumb would hit at its centre?
              hitsItself: (() => {
                const el = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                return !!(el && (el === a || a.contains(el)));
              })(),
            };
          }),
        };
      }, width);

      expect(r.panelLeft, 'panel inside the viewport (left)').toBeGreaterThanOrEqual(-TOL);
      expect(r.panelRight, 'panel inside the viewport (right)').toBeLessThanOrEqual(width + TOL);
      expect(r.barHeight, 'the panel overlays — it must not push the page down').toBeLessThanOrEqual(BASELINE_MOBILE_BAR);
      expect(r.pageHScroll, 'no horizontal page scroll with the menu open').toBeLessThanOrEqual(TOL);

      // THE ACTUAL BUG: every destination present, readable and reachable.
      expect(r.links.map((l) => l.href)).toEqual(LINKS.map((l) => l.href));
      for (const l of r.links) {
        const where = `"${l.label}" @ ${width}px`;
        expect(l.selfClip, `${where} is clipped mid-word`).toBeLessThanOrEqual(TOL);
        expect(l.left, `${where} starts off-screen`).toBeGreaterThanOrEqual(-TOL);
        expect(l.right, `${where} runs past the right edge`).toBeLessThanOrEqual(width + TOL);
        expect(l.height, `${where} misses the WCAG 2.2 44px target`).toBeGreaterThanOrEqual(44);
        expect(l.hitsItself, `${where} is not the element a thumb would hit`).toBe(true);
      }
    });
  }

  test('390px — the open panel paints over a sticky in-page bar, not under it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await page.setContent(buildPage(true, true), { waitUntil: 'load' });
    const r = await page.evaluate(() => {
      const mr = document.querySelector('.kf-nav__menu')!.getBoundingClientRect();
      const sr = document.querySelector('.sbar')!.getBoundingClientRect();
      const overlap = Math.min(mr.bottom, sr.bottom) - Math.max(mr.top, sr.top);
      const el = document.elementFromPoint(mr.left + mr.width / 2, Math.max(mr.top, sr.top) + Math.min(overlap, 20) / 2);
      return {
        overlap: +overlap.toFixed(2),
        topmostIsMenu: !!(el && el.closest('.kf-nav__menu')),
        navZ: getComputedStyle(document.querySelector('.kf-nav')!).zIndex,
      };
    });
    expect(r.overlap, 'the two must genuinely overlap or this proves nothing').toBeGreaterThan(0);
    expect(r.topmostIsMenu, 'the menu must be on top of the sticky bar').toBe(true);
    // The header itself must NOT be lifted: .kf-sbar / .kf-sticky pin under it and win.
    expect(r.navZ, '.kf-nav must not become a stacking context').toBe('auto');
  });
});

test.describe('desktop nav is untouched at 768px and above', () => {
  for (const width of DESKTOP) {
    test(`${width}px — the inline row still shows all ${LINKS.length}, with no menu control`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.setContent(buildPage(false), { waitUntil: 'load' });
      const r = await page.evaluate((vw) => {
        const list = document.querySelector('.kf-nav__list')!;
        const lr = list.getBoundingClientRect();
        return {
          moreDisplay: getComputedStyle(document.querySelector('.kf-nav__more')!).display,
          listDisplay: getComputedStyle(list).display,
          hiddenPx: +(list.scrollWidth - lr.width).toFixed(2),
          barHeight: +document.querySelector('.kf-nav__inner')!.getBoundingClientRect().height.toFixed(2),
          pageHScroll: +(document.documentElement.scrollWidth - vw).toFixed(2),
          fullyVisible: Array.from(list.querySelectorAll('.kf-nav__link')).filter((a) => {
            const b = a.getBoundingClientRect();
            return b.left >= lr.left - 0.6 && b.right <= lr.right + 0.6;
          }).length,
        };
      }, width);
      expect(r.moreDisplay, 'no compact menu on desktop').toBe('none');
      expect(r.listDisplay, 'the inline row renders on desktop').toBe('flex');
      expect(r.fullyVisible, 'every destination fully visible inline').toBe(LINKS.length);
      expect(r.hiddenPx, 'nothing hidden in the strip').toBeLessThanOrEqual(TOL);
      expect(r.barHeight, 'the desktop bar keeps its 50px budget').toBeLessThanOrEqual(50.5);
      expect(r.pageHScroll).toBeLessThanOrEqual(TOL);
    });
  }
});
