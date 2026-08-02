import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileFilterSheet } from './MobileFilterSheet';

// SERVER-RENDER CONTRACT for the mobile sticky filter bar + bottom sheet (Blueprint §04).
//
// What can be pinned here is the markup a browser receives BEFORE any JavaScript runs —
// which is exactly where the two failure modes that matter live:
//
//   1. Modal semantics leaking into a non-modal surface. The same DOM node is an inline
//      filter column at >=768px and a modal sheet at <=767px-when-open. If `role=dialog` /
//      `aria-modal` ship in the static markup, every desktop visitor and every JS-off
//      visitor is handed a dialog that can never be closed. The attributes must appear
//      ONLY once the sheet is actually open (client-side, mobile-only).
//   2. Duplicated filter DOM. Rendering the rail twice (once inline, once in the sheet)
//      would double every chip, every group id and every landmark — the same class of
//      double-counting the v2 design audit had to correct in its own icon measurement.
//
// Interaction (focus trap, Esc, scroll lock, focus return) is NOT assertable here: this
// suite runs in the node environment with no layout engine and no media-query matching.
// It is covered in tests/e2e/public/search-mobile-filter-sheet.public.spec.ts against a
// real browser, deliberately — the desktop-shell regression is the standing proof that
// media-query-dependent behaviour cannot be verified without one.

const RAIL = <div className="kf-filters" data-testid="rail">rail contents</div>;

function render(props: Partial<Parameters<typeof MobileFilterSheet>[0]> = {}): string {
  return renderToStaticMarkup(
    <MobileFilterSheet
      whenLabel="Any day"
      whereLabel="Any area"
      activeCount={0}
      clearHref="/search"
      resultCount={7}
      {...props}
    >
      {RAIL}
    </MobileFilterSheet>,
  );
}

describe('MobileFilterSheet — static (pre-JS) markup', () => {
  it('renders the filter rail EXACTLY once — never an inline copy plus a sheet copy', () => {
    const html = render();
    expect((html.match(/data-testid="rail"/g) || []).length).toBe(1);
  });

  it('ships NO dialog semantics before it is opened (desktop + JS-off must never see a modal)', () => {
    const html = render();
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  });

  it('marks the panel closed, so mobile CSS can hide it and desktop CSS can ignore the state', () => {
    expect(render()).toContain('data-open="false"');
  });

  it('gives every trigger real disclosure semantics pointing at the panel it opens', () => {
    const html = render();
    const panelId = /id="([^"]*sheet[^"]*)"/.exec(html)?.[1];
    expect(panelId, 'the sheet panel needs a stable id for aria-controls').toBeTruthy();
    // Each trigger: collapsed, owns the panel, and announces that it opens a dialog.
    const triggers = html.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/g) || [];
    expect(triggers.length, 'When / Where / Filters should each open the sheet').toBeGreaterThanOrEqual(3);
    for (const t of triggers) {
      expect(t).toContain('aria-expanded="false"');
      expect(t).toContain(`aria-controls="${panelId}"`);
    }
  });

  it('summarises the state a parent can no longer see, so filtering is never blind', () => {
    const html = render({ whenLabel: 'This weekend', whereLabel: 'North Van +1', activeCount: 3 });
    expect(html).toContain('This weekend');
    expect(html).toContain('North Van +1');
    // The count badge is a number AND carries its meaning in text for screen readers —
    // "3" alone on a gear icon is colour/shape-only information.
    expect(html).toMatch(/>3</);
    expect(html).toMatch(/3 filters applied|3 active/i);
  });

  it('shows no count badge at all when nothing is filtering', () => {
    const html = render({ activeCount: 0 });
    expect(html).not.toMatch(/filters applied/i);
  });

  it('offers "Clear all" only when there is something to clear, and as a real URL link', () => {
    expect(render({ activeCount: 0 })).not.toContain('Clear all');
    const html = render({ activeCount: 2, clearHref: '/search?q=swim' });
    expect(html).toContain('Clear all');
    expect(html).toContain('href="/search?q=swim"');
  });

  it('carries a labelled close control and a titled header the dialog can name itself from', () => {
    const html = render();
    const titleId = /id="([^"]*title[^"]*)"/.exec(html)?.[1];
    expect(titleId, 'the sheet needs a heading id for aria-labelledby when it opens').toBeTruthy();
    expect(html).toMatch(/aria-label="Close filters"/);
  });

  it('states the live result count in the sheet footer (Blueprint Screen 5: count as chips toggle)', () => {
    const html = render({ resultCount: 14 });
    // A real polite status region, not a live count buried in a button label — every chip
    // tap re-renders this and announces the new total without stealing focus.
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/>14</);
    expect(html).toContain('Show results');
  });

  it('pluralises the result count honestly (a "1 results" bar reads as a bug to a parent)', () => {
    expect(render({ resultCount: 1 })).toMatch(/1<\/b> result\b/);
    expect(render({ resultCount: 0 })).toMatch(/0<\/b> results/);
  });

  it('emits a <noscript> fallback so a JS-off parent still gets the full filter set', () => {
    const html = render();
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';
    expect(noscript, 'no-JS parents would otherwise lose every filter on mobile').toContain('<style');
    // It must un-hide the panel and retire the dead trigger bar — not merely exist.
    expect(noscript).toMatch(/kf-msheet/);
    expect(noscript).toMatch(/kf-mfilters/);
  });
});
