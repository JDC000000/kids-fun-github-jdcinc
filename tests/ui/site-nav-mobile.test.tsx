import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// THE MOBILE NAV CLIPPED FOUR OF SIX DESTINATIONS (design/QA audit, 2026-09-04).
//
// MEASURED on a stock 390px iPhone viewport against the real stylesheet, BEFORE the fix:
// the destination row was 456px wide and 200px of it was visible. "What's on now" and
// "Swimming" fitted, "Storytime" was cut mid-word, and "Indoor play", "Classes" and "Free"
// were off the end entirely. At 320px it was worse: 130px of 456px, ONE destination.
//
// The row was a horizontal scroller with a fade mask as its only affordance, and the mask
// faded warm paper to transparent ON warm paper — so the single cue that four more
// destinations existed was text appearing to stop. The 2026-09-03 pass had already
// reclaimed ~80px by shedding "with Google" from the sign-in pill; that helped and could
// not be enough, because the arithmetic does not close: six pills need ~456px and a 390px
// phone has ~200px to give once the wordmark and the account control are paid for.
//
// THE FIX: below 768px the row is not rendered at all; a native <details> compact menu
// lists every destination instead. Above 768px nothing changes — the row already fitted.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. vitest runs in the `node` environment with no layout
// engine, so it cannot measure pixels; that is done for real, in Chromium, at 320/360/390/414
// by tests/e2e/public/site-nav-mobile.public.spec.ts. This file guards the mechanics that
// make the clipping impossible, and it is the copy that runs in the BLOCKING `unit` lane
// (the Playwright lane is report-only — see vitest.workspace.ts and the e2e job's header),
// so the regression has a gate and not only a report.
// (CSS-parse convention follows tests/ui/freshness-stamp-mobile.test.ts.)
// ─────────────────────────────────────────────────────────────────────────────

// Mutable so one file can render the bar on several routes — the account-nav exclusion is
// route-dependent and asserting it needs both an excluded and a non-excluded path.
let currentPath = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { SiteNav } = await import('../../app/_components/SiteNav');
const { SEARCH_SHORTCUTS, destinationHref, liveCategoryDestinations } = await import(
  '../../app/_lib/nav-destinations'
);

const cssRaw = readFileSync(
  fileURLToPath(new URL('../../app/_components/site-nav.css', import.meta.url)),
  'utf8'
);

/**
 * COMMENTS STRIPPED BEFORE ANYTHING IS MATCHED. This file is asserting DECLARATIONS, and
 * site-nav.css is heavily commented — including comments that name the very properties being
 * asserted ("`position` WITHOUT `z-index`, deliberately"). Matching the raw text made the
 * z-index assertion below pass against prose and fail against the code, which is precisely
 * backwards. Every check in this file reads `css`, never `cssRaw`.
 */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
function renderAt(path: string): string {
  currentPath = path;
  return renderToStaticMarkup(<SiteNav />);
}

/** The home page: not an SMS surface, so the full bar including the account pill. */
const html = renderAt('/');

/** Declaration body of an exact rule. `selector` is matched literally. */
function ruleBody(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`CSS rule not found: ${selector}`);
  return m[1];
}

/** The whole `@media (max-width: 767px)` block, brace-matched rather than regex-guessed. */
function narrowBlock(): string {
  const start = css.indexOf('@media (max-width: 767px) {');
  if (start < 0) throw new Error('the <768px media block is gone');
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in site-nav.css');
}

describe('the compact menu carries every destination below 768px', () => {
  const expected = [
    SEARCH_SHORTCUTS.onNow.href,
    ...liveCategoryDestinations().map(destinationHref),
    SEARCH_SHORTCUTS.free.href,
  ];

  it('renders all six destinations inside the menu, not a subset', () => {
    // The failure being guarded is a nav that shows two destinations and hides four. A menu
    // that carried only the "overflow" would leave the same split, just behind a control.
    const menu = html.match(/<ul class="kf-nav__menu">(.*?)<\/ul>/s);
    expect(menu, 'SiteNav must render <ul class="kf-nav__menu">').not.toBeNull();
    const hrefs = [...menu![1].matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expected);
    expect(hrefs).toHaveLength(6);
  });

  it('opens with no JavaScript — native <details>, server-rendered', () => {
    expect(html).toMatch(/<details[^>]*class="kf-nav__more"/);
    expect(html).toMatch(/<summary class="kf-nav__more-toggle"/);
    // Not `open` in the markup: it must start closed on every page load.
    expect(html).not.toMatch(/<details[^>]*class="kf-nav__more"[^>]*\sopen/);
  });

  it('the control is labelled, not a bare hamburger glyph', () => {
    const summary = html.match(/<summary class="kf-nav__more-toggle".*?<\/summary>/s)![0];
    expect(summary.replace(/<[^>]+>/g, '')).toContain('Menu');
    expect(summary).toContain('aria-hidden="true"'); // the icon is decorative
  });
});

describe('the clipping strip is gone below 768px, and only below 768px', () => {
  it('the inline row is not rendered on a phone', () => {
    expect(narrowBlock()).toMatch(/\.kf-nav__list\s*\{[^}]*display:\s*none/);
  });

  it('the compact menu is rendered ONLY on a phone', () => {
    // Base rule hides it; the media block reveals it.
    expect(ruleBody('.kf-nav__more')).toMatch(/display:\s*none/);
    expect(narrowBlock()).toMatch(/\.kf-nav__more\s*\{[^}]*display:\s*block/);
  });

  it('🔴 the base .kf-nav__more rule precedes the media query that overrides it', () => {
    // Same specificity, so SOURCE ORDER decides. Written the other way round — the base
    // `display: none` after the media block — the menu is dead on every phone and the
    // desktop row is dead everywhere: no nav at all below 768px. This happened while the
    // fix was being written and was caught only by rendering it, so it is pinned here.
    expect(css.indexOf('.kf-nav__more {')).toBeGreaterThan(-1);
    expect(css.indexOf('.kf-nav__more {')).toBeLessThan(css.indexOf('@media (max-width: 767px)'));
  });

  it('🔴 the panel sets `display` in BOTH states, so no UA stylesheet decides it', () => {
    // A closed <details> hides its children by a mechanism that differs across engines and
    // versions (`display: none` on the slot; `content-visibility: hidden` on
    // ::details-content in newer Chrome). An unconditional `display` on the panel overrides
    // the older one — the first cut of this CSS did exactly that and the panel rendered
    // permanently, open or closed, at every mobile width. Both states are now explicit.
    expect(ruleBody('.kf-nav__menu')).toMatch(/display:\s*none/);
    expect(ruleBody(".kf-nav__more[open] > .kf-nav__menu")).toMatch(/display:\s*flex/);
  });

  it('the invisible fade-mask affordance is gone rather than merely restyled', () => {
    expect(css).not.toMatch(/mask-image/);
  });

  it('the desktop row keeps its own rule and is untouched', () => {
    expect(ruleBody('.kf-nav__list')).toMatch(/display:\s*flex/);
  });
});

describe('the open panel is reachable, tappable and correctly layered', () => {
  it('is absolutely positioned, so a closed menu costs the bar no height', () => {
    // The scrolling strip was chosen over a wrapping nav to protect above-the-fold results
    // ("a wrapping nav would push the whole page down"). Overlaying keeps that promise.
    expect(ruleBody(".kf-nav__more[open] > .kf-nav__menu")).toMatch(/position:\s*absolute/);
  });

  it('is held to the bar gutters, so it cannot overflow a 320px screen', () => {
    // Anchored to the "Menu" control instead, a 222px panel started at x=103 and ran 5px
    // past the right edge of a 320px phone. Measured, then re-anchored to .kf-nav.
    const body = ruleBody(".kf-nav__more[open] > .kf-nav__menu");
    expect(body).toMatch(/left:\s*12px/);
    expect(body).toMatch(/right:\s*12px/);
    expect(ruleBody('.kf-nav')).toMatch(/position:\s*relative/);
  });

  it('🔴 .kf-nav sets NO z-index, so the header is not lifted over the page', () => {
    // /search's .kf-sbar and /preview's .kf-sticky are `position: sticky; top: 0; z-index: 20`.
    // A z-index here would make this header a stacking context and float the whole bar above
    // them. `position: relative` with `z-index: auto` creates no stacking context, so the
    // panel can elevate itself without the bar coming with it.
    expect(ruleBody('.kf-nav')).not.toMatch(/z-index/);
  });

  it('the panel outranks the in-page sticky bars but stays under the modal sheet', () => {
    const z = Number(ruleBody(".kf-nav__more[open] > .kf-nav__menu").match(/z-index:\s*(\d+)/)![1]);
    expect(z).toBeGreaterThan(25); // .kf-sbar (20) and .kf-mfilters (25)
    expect(z).toBeLessThan(55); //    .kf-msheet__scrim (55) / .kf-msheet (60) — a modal wins
  });

  it('every row and the control itself meet the WCAG 2.2 target-size floor', () => {
    expect(ruleBody('.kf-nav__more-toggle')).toMatch(/min-height:\s*44px/);
    expect(ruleBody('.kf-nav__menu .kf-nav__link')).toMatch(/min-height:\s*44px/);
  });

  it('current-page is still marked by more than colour (D10 / WCAG 1.4.1)', () => {
    expect(ruleBody(".kf-nav__menu .kf-nav__link[aria-current='page']")).toMatch(/box-shadow/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// THE ACCOUNT-NAV EXCLUSION MUST SURVIVE THE REWRITE.
// lib/sms/surfaces.ts hides the "Sign in with Google" pill on the SMS surfaces and on the
// pages a parent reaches from a text (/activity/, /preview/, /search, /u/). The compact menu
// rewrote this component's JSX, and re-introducing the pill on those routes would undo a
// Jon ruling — "capture the least data we need to provide value" — silently. Asserted in
// BOTH directions so a mechanism that simply stopped rendering the pill anywhere would fail.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('the sign-in pill exclusion still holds after the rewrite', () => {
  it('renders the account touchpoint where it belongs', () => {
    expect(renderAt('/')).toContain('kf-account');
  });

  for (const path of ['/search', '/preview/abc123', '/activity/abc123', '/u/tok3n']) {
    it(`hides it on ${path}`, () => {
      const out = renderAt(path);
      expect(out).not.toContain('kf-account');
      expect(out).not.toContain('Sign in');
      // …and the destinations are still all there on those pages.
      expect(out).toContain('kf-nav__menu');
      expect(out).toContain('kf-nav__list');
    });
  }
});
