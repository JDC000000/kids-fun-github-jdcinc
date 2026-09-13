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
//
// ═══ T3.4 — THE MUTATION MATRIX (standing F-4 lesson) ═══
// The nav contract changed by design, so these assertions were REWRITTEN rather than relaxed —
// and a rewritten assertion is exactly the kind that can come back weaker than it went in. Every
// new guard below was therefore mutation-tested: the regression applied to the real source, the
// suite run, the source restored. All seven turned this lane red.
//
//  #   guard                                                     mutation that kills it
//  N1  the SMS entry LEADS the bar, not merely appears in it     move it to the end of LINKS
//  N2  the nav points at /sms/start, never the /sms/signup 308   swap the href for the redirect
//  N3  the wide row and the compact menu cannot drift apart      render LINKS.slice(1) in the row
//  N4  the SMS marker renders on BOTH surfaces, one renderer     drop the --sms class
//  N5  the marker is WEIGHT, not its Leaf dot alone (WCAG 1.4.1) set font-weight back to 400
//  N6  the entry is DROPPED when signup is unavailable (AC-12)  default smsSignupHref to the path
//  N7  …and the bar degrades to the search list, not to nothing return [] from navLinks()
//
// 🔴 N6 EARNED THE PASS. The first cut of T3.1 built the SMS entry at module scope from
// SMS_SIGNUP_PATH, unconditionally. Every assertion in both nav files was green, because none of
// them knew the flag existed — and tests/home/sms-offer.test.tsx renders <Home /> alone, so the
// nav was outside its AC-12 sweep too. Loading the BUILT page with SMS_SIGNUP_ENABLED=false still
// returned `href="/sms/start"`, from the bar, on the one page whose entire fail-safe branch exists
// to prevent exactly that. The guard is here because the gap was between two files, not inside one.
// ─────────────────────────────────────────────────────────────────────────────

// Mutable so one file can render the bar on several routes. It was introduced for the
// route-dependent account-nav exclusion (now removed with the pill itself, 2026-09-12) and
// is still needed: the pill's absence is asserted on every route, and `aria-current` is
// route-dependent too.
let currentPath = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { SiteNav } = await import('../../app/_components/SiteNav');
const { SEARCH_SHORTCUTS, destinationHref, liveCategoryDestinations } = await import(
  '../../app/_lib/nav-destinations'
);
const { SMS_SIGNUP_PATH } = await import('../../lib/sms/config');

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
function renderAt(path: string, smsSignupHref: string | null = SMS_SIGNUP_PATH): string {
  currentPath = path;
  return renderToStaticMarkup(<SiteNav smsSignupHref={smsSignupHref} />);
}

/** The home page. (It used to be the one route that still rendered the account pill.) */
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
  /**
   * ═══ THE LIST GREW BY ONE, AT THE FRONT (TSD v1.2 T3.1 / T3.4) ═══
   * The bar now leads with the SMS offer and keeps the whole search run behind it. On a phone
   * that entry is inside this menu like every other, which is the reason the menu matters more
   * than it did: the home page is 90% SMS offer and its search block is deliberately at the
   * bottom of a long page, so this panel is the only above-the-fold route to search a phone has.
   * A menu that clipped anything would now cost a parent the search product outright.
   *
   * DERIVED, NEVER TYPED OUT — a literal list here would pass while the shared vocabulary said
   * something else, which is the drift both nav test files exist to catch.
   */
  const expected = [
    SMS_SIGNUP_PATH,
    SEARCH_SHORTCUTS.onNow.href,
    ...liveCategoryDestinations().map(destinationHref),
    SEARCH_SHORTCUTS.free.href,
  ];

  const menuHrefs = (): string[] => {
    const menu = html.match(/<ul class="kf-nav__menu">(.*?)<\/ul>/s);
    expect(menu, 'SiteNav must render <ul class="kf-nav__menu">').not.toBeNull();
    return [...menu![1].matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  };

  it('renders every destination inside the menu, not a subset', () => {
    // The failure being guarded is a nav that shows two destinations and hides the rest. A menu
    // that carried only the "overflow" would leave the same split, just behind a control.
    expect(menuHrefs()).toEqual(expected);
    // Count derived from the sources — the three fixed entries plus every live category — so
    // adding a category widens it automatically and dropping one to make room fails here.
    expect(menuHrefs()).toHaveLength(3 + liveCategoryDestinations().length);
  });

  it('🔴 AC-12 — the phone menu drops the SMS row when signup is unavailable', () => {
    // The compact menu is the ONLY above-the-fold route the phone has, so a dead row in it is
    // the whole product's first tap. `smsSignupHref` is null when SMS_SIGNUP_ENABLED is not
    // exactly 'true' — which is its DEFAULT — and the bar must degrade to the search list it
    // has always carried rather than to a link that 404s, or to nothing.
    const degraded = renderAt('/', null);
    const menu = degraded.match(/<ul class="kf-nav__menu">(.*?)<\/ul>/s)![1];
    const hrefs = [...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expected.slice(1));
    expect(hrefs).not.toContain(SMS_SIGNUP_PATH);
    expect(degraded).not.toContain('kf-nav__link--sms');
  });

  it('🔴 the SMS offer is the first row, and is marked as the one non-search entry', () => {
    expect(menuHrefs()[0]).toBe(SMS_SIGNUP_PATH);
    const menu = html.match(/<ul class="kf-nav__menu">(.*?)<\/ul>/s)![1];
    expect(menu.match(/kf-nav__link--sms/g)).toHaveLength(1);
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

  it('🔴 the SMS entry is distinguished by WEIGHT, not by its Leaf dot alone (D10 / WCAG 1.4.1)', () => {
    // The dot is the brand's action colour appearing where the one action is. It is a ::after
    // pseudo-element, so it is not in the accessibility tree and carries no meaning on its own —
    // which is exactly why the entry must also differ in a channel that survives colour being
    // unavailable. Font weight is that channel. Leaf is used as a BACKGROUND here and never as
    // text: it is 2.17:1 on white and would be a contrast failure as a label.
    expect(ruleBody('.kf-nav__link--sms')).toMatch(/font-weight:\s*700/);
    const dot = ruleBody('.kf-nav__link--sms::after');
    expect(dot).toMatch(/background:\s*var\(--kf-leaf\)/);
    expect(dot).toMatch(/content:\s*''/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// THE SIGN-IN PILL IS GONE FROM EVERY ROUTE, AND MUST STAY GONE.
//
// This block used to assert the pill's route-dependent EXCLUSION: present on '/', hidden on
// the SMS surfaces and on the pages a parent reaches from a text (/activity/, /preview/,
// /search, /u/), via lib/sms/surfaces.ts `hidesAccountNav`. Jon removed the control outright
// on 2026-09-12 — "the only product i want to promote is the SMS product. we don't want
// people to sign in with google. this functionality adds no value. remove it." — so the
// exclusion has no remaining "present" case to assert and the direction of the test flips:
// the pill must now be absent EVERYWHERE, '/' included.
//
// Kept as a test rather than deleted, because "absent everywhere" is the invariant that can
// silently regress. AccountNav was mounted globally in SiteNav; anything that re-adds a
// sign-in affordance to the bar — or re-introduces the component — fails here rather than
// shipping. The destinations are re-asserted alongside so a component that regressed to
// rendering NOTHING could not pass this by being empty.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('the Google sign-in pill is gone from the nav on every route', () => {
  for (const path of ['/', '/search', '/preview/abc123', '/activity/abc123', '/u/tok3n']) {
    it(`renders no account touchpoint on ${path}`, () => {
      const out = renderAt(path);
      expect(out).not.toContain('kf-account');
      expect(out).not.toContain('Sign in');
      expect(out).not.toContain('/auth/signin');
      // …and the destinations are still all there on those pages.
      expect(out).toContain('kf-nav__menu');
      expect(out).toContain('kf-nav__list');
    });
  }
});
