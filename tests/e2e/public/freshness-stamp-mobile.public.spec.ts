import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// BUG-011 regression (R27 G-T39-3) — the freshness stamp must never overflow a
// narrow mobile viewport.
//
// The stamp ("✓ Confirmed · <source> · Checked today") is the product's core
// trust signal. Before the fix, a long source hostname pushed the single
// non-wrapping inline-flex row past the right edge of a ~375px viewport and
// clipped "Checked today" on every card + detail page.
//
// WHY THIS IS A PLAYWRIGHT (REAL-BROWSER) TEST, NOT A VITEST/jsdom ONE:
// the defect is pure CSS layout (wrapping / overflow / clipping). jsdom has no
// layout engine, so the sibling unit test (tests/ui/freshness-stamp-mobile.test.tsx)
// can only assert the CSS *declarations* exist and that the component renders the
// breakable `.kf-stamp__src` span — it CANNOT measure real pixel overflow. This
// spec closes that gap: it loads the REAL app CSS (design-tokens.css + preview.css)
// into a faithful card + detail scaffold and MEASURES, in a real Chromium layout
// pass, that nothing overflows at 320/360/375/390px — including an adversarial
// unbreakable-hostname stress case.
//
// It is self-contained (page.setContent, no server/DB needed) so the adversarial
// inputs are deterministic rather than dependent on seeded source names. A guard
// test keeps the hand-built stamp DOM in sync with the real component's class
// contract, so this cannot silently drift.
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-root-relative read. Playwright runs from the project root (config dir). */
function readRepoFile(rel: string): string {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) throw new Error(`BUG-011 spec: expected file not found: ${p} (cwd=${process.cwd()})`);
  return fs.readFileSync(p, 'utf8');
}

const TOKENS_CSS = readRepoFile('app/design-tokens.css');
const PREVIEW_CSS = readRepoFile('app/preview/preview.css');
const STAMP_SRC = readRepoFile('app/preview/_components/FreshnessStamp.tsx');

// The exact bug repro hostname + two harder cases (a longer real-shaped hostname
// and an unbreakable single-token hostname that has no natural break opportunity).
const SOURCES = [
  'yourlibrary.bibliocommons.com',
  'vancouverpubliclibrary.bibliocommons.com',
  'reallyreallylongsinglewordhostnamewithnobreaks.example.museum',
];
const WIDTHS = [320, 360, 375, 390];
const TOL = 0.6; // sub-pixel rounding tolerance

// Mirrors FreshnessStamp.tsx output for a `confirmed` activity checked today.
// The guard test below fails loudly if the component's class contract changes.
function stampMarkup(sourceName: string): string {
  return (
    '<span class="kf-stamp kf-stamp--confirmed">' +
    '<span class="kf-stamp__icon" aria-hidden="true">✓</span>' +
    '<span>Confirmed</span>' +
    '<span aria-hidden="true">·</span>' +
    `<span class="kf-stamp__src">${sourceName}</span>` +
    '<span aria-hidden="true">·</span>' +
    '<span>Checked today</span>' +
    '</span>'
  );
}

// Faithful real ancestor chain: div.kf > div.kf-page > div.kf-app > (kf-results cards | kf-detail).
// Card context = the tighter one (72px tile eats width via the grid); detail context = flex row.
function buildPage(): string {
  const card = (src: string, i: number) => `
    <a class="kf-card" data-ctx="card" data-src="${src}" data-i="${i}" href="#">
      <div style="width:72px;height:72px;background:var(--surface-subtle);border-radius:10px" aria-hidden="true"></div>
      <div class="kf-card__body">
        <p class="kf-card__type">Storytime</p>
        <h3 class="kf-card__title">Brighouse Branch</h3>
        <div class="kf-card__meta"><span><b>Mon</b> · 10:30 AM</span><span>Ages 0–5 · Free</span></div>
        ${stampMarkup(src)}
        <span class="kf-card__cta">See details →</span>
      </div>
    </a>`;
  const detail = (src: string, i: number) => `
    <div class="kf-detail">
      <div class="kf-detail__hero">
        <p class="kf-detail__type">Storytime</p>
        <h1 class="kf-detail__title">Brighouse Branch</h1>
        <p class="kf-detail__venue">Metro Vancouver · 8 min drive · 3.2 km</p>
        <div data-ctx="detail" data-src="${src}" data-i="${i}" style="margin-top:12px;display:flex;gap:12px;align-items:center">
          <div style="width:64px;height:64px;background:var(--surface-subtle);border-radius:10px;flex:0 0 auto" aria-hidden="true"></div>
          ${stampMarkup(src)}
        </div>
      </div>
    </div>`;
  const cards = SOURCES.map(card).join('\n');
  const details = SOURCES.map(detail).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      ${TOKENS_CSS}
      ${PREVIEW_CSS}
      html,body{margin:0}
      .kf-results{padding:12px}
    </style></head>
    <body><div class="kf"><div class="kf-page"><div class="kf-app">
      <section class="kf-results">${cards}</section>
      ${details}
    </div></div></div></body></html>`;
}

const PAGE_HTML = buildPage();

test.describe('BUG-011: freshness stamp never overflows a narrow mobile viewport', () => {
  // Anti-drift: the hand-built stamp DOM above must match the real component's
  // class contract. If FreshnessStamp stops emitting these, this spec is stale.
  test('guard: FreshnessStamp still emits the .kf-stamp / .kf-stamp__src contract', () => {
    expect(STAMP_SRC, 'component must wrap the row in .kf-stamp').toMatch(/className=\{`kf-stamp kf-stamp--\$\{[^}]+\}`\}/);
    expect(STAMP_SRC, 'component must render the source through the breakable .kf-stamp__src span')
      .toMatch(/className="kf-stamp__src">\{activity\.sourceName\}/);
  });

  for (const width of WIDTHS) {
    test(`no overflow / clipping at ${width}px (card + detail, incl. long-hostname stress)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(PAGE_HTML, { waitUntil: 'load' });

      const report = await page.evaluate((tol) => {
        const innerWidth = window.innerWidth;
        const pageHScroll = document.documentElement.scrollWidth - innerWidth;

        function contentRight(el: Element): number {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        }

        const stamps = Array.from(document.querySelectorAll('.kf-stamp')).map((stamp) => {
          const holder = stamp.closest('[data-ctx]')!;
          const ctx = holder.getAttribute('data-ctx')!;
          const src = holder.getAttribute('data-src')!;
          const sRect = stamp.getBoundingClientRect();
          const container = ctx === 'card' ? stamp.closest('.kf-card')! : document.querySelector('.kf-app')!;
          const cRight = contentRight(container);

          let maxChildRight = -Infinity;
          let childPastStamp: string | null = null;
          for (const d of Array.from(stamp.querySelectorAll('*'))) {
            const dr = d.getBoundingClientRect();
            if (dr.width > 0) maxChildRight = Math.max(maxChildRight, dr.right);
            if (dr.right > sRect.right + tol) childPastStamp = (d.textContent || '').slice(0, 40);
          }

          return {
            ctx, src,
            overflowsContainer: +(sRect.right - cRight).toFixed(2),
            overflowsViewport: +(sRect.right - innerWidth).toFixed(2),
            selfClip: +(stamp.scrollWidth - stamp.clientWidth).toFixed(2),
            childPastContainer: +(maxChildRight - cRight).toFixed(2),
            childPastStamp,
          };
        });
        return { innerWidth, pageHScroll, stamps };
      }, TOL);

      // (1) the page itself must not scroll horizontally
      expect(report.pageHScroll, `page h-scroll at ${width}px`).toBeLessThanOrEqual(TOL);

      // (2) every stamp — in both contexts, for every hostname — stays contained + unclipped
      expect(report.stamps.length).toBe(SOURCES.length * 2);
      for (const s of report.stamps) {
        const where = `${s.ctx} @ ${width}px · ${s.src}`;
        expect(s.overflowsContainer, `stamp overflows its container (${where})`).toBeLessThanOrEqual(TOL);
        expect(s.overflowsViewport, `stamp overflows the viewport (${where})`).toBeLessThanOrEqual(TOL);
        expect(s.selfClip, `stamp clips its own content (${where})`).toBeLessThanOrEqual(TOL);
        expect(s.childPastContainer, `a stamp child pokes past the container (${where})`).toBeLessThanOrEqual(TOL);
        expect(s.childPastStamp, `a stamp child pokes past the stamp box (${where})`).toBeNull();
      }
    });
  }
});
