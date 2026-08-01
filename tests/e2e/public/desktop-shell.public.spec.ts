import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Desktop shell regression guard.
//
// THE BUG THIS PINS: app/preview/preview.css began life as the /preview mobile
// fixture and hard-caps the app shell at `.kf-app { max-width: 440px }`. When
// app/layout.tsx started importing it globally, that phone artboard silently
// became the shell for every public route (/, /search, /activity/[id]). No
// width-based media query existed anywhere in the public CSS, so a 1920px
// desktop rendered the entire product as a 440px column — 23% of the viewport —
// on an empty dotted background. Reported by Jon from the live staging site:
// "On desktop, why does it look like mobile? It's one long, thin display."
//
// It regressed silently because nothing asserted that the shell responds AT ALL.
// A single missing media query is invisible to every jsdom test in the suite:
// jsdom has no layout engine and no media-query matching, so only a real browser
// can catch it. Hence Playwright, and hence measuring `.kf-app` rather than
// grepping the stylesheet for a breakpoint string — a grep would pass against a
// media query that exists but is overridden, misordered, or scoped to the wrong
// selector.
//
// Widths come from the approved Visual Blueprint v0.1, "Layout / spacing /
// radius": "Content max-width 1120-1280px; hero up to 1440px."
//
// Self-contained (page.setContent, no server/DB) so it stays deterministic and
// runs in the unauthenticated lane.
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-root-relative read. Playwright runs from the project root (config dir). */
function readRepoFile(rel: string): string {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) throw new Error(`desktop-shell spec: expected file not found: ${p} (cwd=${process.cwd()})`);
  return fs.readFileSync(p, 'utf8');
}

const TOKENS_CSS = readRepoFile('app/design-tokens.css');
const PREVIEW_CSS = readRepoFile('app/preview/preview.css');

/** The real ancestor chain every public route renders: .kf > .kf-page > .kf-app. */
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${TOKENS_CSS}${PREVIEW_CSS}html,body{margin:0}</style></head>
  <body><div class="kf"><div class="kf-page"><div class="kf-app">
    <header class="kf-hero"><h1 class="kf-hero__title">See what's on for your kids today.</h1></header>
    <main class="kf-results"><p>results</p></main>
  </div></div></div></body></html>`;

async function shellWidth(page: import('@playwright/test').Page, width: number): Promise<number> {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(PAGE_HTML, { waitUntil: 'load' });
  return page.evaluate(() => document.querySelector('.kf-app')!.getBoundingClientRect().width);
}

test.describe('the app shell responds to desktop viewports', () => {
  // The phone artboard is the intended design below the first breakpoint — this
  // side of the guard is what stops a "fix" from widening the mobile layout too.
  for (const width of [375, 390]) {
    test(`stays a phone-width column at ${width}px`, async ({ page }) => {
      const app = await shellWidth(page, width);
      expect(app, `.kf-app should fill a ${width}px phone viewport`).toBeGreaterThan(width * 0.85);
      expect(app, '.kf-app must never exceed the 440px phone artboard on mobile').toBeLessThanOrEqual(440);
    });
  }

  // The actual regression: at these widths the shell used to stay 440px.
  for (const width of [1280, 1440, 1920]) {
    test(`widens well past the 440px phone artboard at ${width}px`, async ({ page }) => {
      const app = await shellWidth(page, width);
      expect(app, `.kf-app was ${Math.round(app)}px at ${width}px — the phone artboard is leaking onto desktop`).toBeGreaterThan(440);
      expect(app, 'desktop shell should reach the blueprint 1120-1280px content measure').toBeGreaterThanOrEqual(1120);
      expect(app, 'blueprint caps content at 1280px — a full-bleed shell is not the fix').toBeLessThanOrEqual(1280);
    });
  }

  test('scales monotonically across the breakpoint scale', async ({ page }) => {
    const widths = [390, 768, 1024, 1280];
    const measured: number[] = [];
    for (const w of widths) measured.push(await shellWidth(page, w));

    for (let i = 1; i < measured.length; i++) {
      expect(
        measured[i],
        `.kf-app at ${widths[i]}px (${Math.round(measured[i])}px) must be at least its width at ` +
          `${widths[i - 1]}px (${Math.round(measured[i - 1])}px) — a breakpoint is inverted or misordered`,
      ).toBeGreaterThanOrEqual(measured[i - 1]);
    }
    // A shell that never changes across the whole scale is the bug itself.
    expect(new Set(measured.map(Math.round)).size, 'the shell width never changed across 390->1280px').toBeGreaterThan(1);
  });

  test('no horizontal page overflow at any width on the scale', async ({ page }) => {
    for (const width of [375, 390, 768, 1024, 1280, 1440, 1920]) {
      await shellWidth(page, width);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow of ${overflow}px at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});
