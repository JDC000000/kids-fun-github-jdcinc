// tests/not-found-page.test.tsx — the safety net under app/not-found.tsx.
//
// A 404 is the one page in the product that is only ever reached by accident, which means it
// is also the one page nobody looks at on purpose. That is exactly the condition under which
// a link rots unnoticed, so the things asserted here are the things that would rot: that the
// onward destinations are still the SHARED list rather than a copy somebody pasted in, that a
// retired destination cannot reappear on this surface alone, and that the page still offers a
// working way out at all.
//
// The counterpart e2e spec (tests/e2e/public/not-found.public.spec.ts) proves the route is
// actually wired to unmatched URLs and answers with a real 404 status. This file proves what
// the markup CONTAINS; that one proves the server reaches it.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The root layout's chrome is not rendered by this unit — but Next's <Link> and the UI
// primitives are, and nothing here has an app-router context. Same stub the nav-destinations
// suite uses, for the same reason.
vi.mock('next/navigation', () => ({
  usePathname: () => '/no-such-page',
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

import NotFound, { metadata } from '../app/not-found';
import {
  CATEGORY_DESTINATIONS,
  SEARCH_SHORTCUTS,
  destinationHref,
  liveCategoryDestinations,
} from '../app/_lib/nav-destinations';

const html = () => renderToStaticMarkup(<NotFound />);

const hrefsIn = (markup: string): string[] =>
  [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

describe('the 404 page offers a real way out', () => {
  it('renders a search form that submits to /search by GET, with no JavaScript involved', () => {
    const markup = html();
    // `action` + `method` rather than an onSubmit handler: this page is served from the
    // static /_not-found output and has to work before anything hydrates.
    expect(markup).toContain('action="/search"');
    expect(markup).toContain('method="get"');
    expect(markup).toContain('name="q"');
    // A search box without a submit control is a dead end for anyone not using a keyboard.
    expect(markup).toContain('type="submit"');
  });

  it('labels the query field visibly, not by placeholder alone', () => {
    const markup = html();
    // WCAG 3.3.2. A placeholder disappears the moment a parent starts typing, so it is not
    // a label — and this is the page where somebody is already having a bad time.
    expect(markup).toContain('for="kf-nf-q"');
    expect(markup).toContain('id="kf-nf-q"');
    expect(markup).toContain('What are you looking for?');
  });

  it('links home', () => {
    expect(hrefsIn(html())).toContain('/');
  });

  it('has exactly one <h1>, and it states what happened', () => {
    const markup = html();
    expect(markup.match(/<h1/g) ?? []).toHaveLength(1);
    expect(markup).toMatch(/That page isn.t here\./);
  });

  it('tells a browser tab which page went wrong', () => {
    // The root layout's bare "KIDS FUN" cannot distinguish a 404 from anything else.
    expect(metadata.title).toBe('Page not found — KIDS FUN');
  });
});

describe('the onward links are the shared vocabulary, not a third copy of it', () => {
  it('offers every LIVE destination, by the shared href encoding', () => {
    const hrefs = hrefsIn(html());
    for (const destination of liveCategoryDestinations()) {
      expect(hrefs, `${destination.label} is missing from the 404`).toContain(destinationHref(destination));
    }
  });

  it('offers the two structural shortcuts as well, so "everything" and "free" are reachable', () => {
    const hrefs = hrefsIn(html());
    expect(hrefs).toContain(SEARCH_SHORTCUTS.onNow.href);
    expect(hrefs).toContain(SEARCH_SHORTCUTS.free.href);
  });

  it('offers NO retired destination — the exclusion is enforced here too, not just in the nav', () => {
    // The precise failure this file exists for: "Festivals" was dropped from the nav and left
    // on the home page, because the exclusion lived on each surface instead of in the data.
    // A 404 whose "try one of these" list sends a parent to a query returning nothing is the
    // same bug, on the worst possible page for it.
    const hrefs = hrefsIn(html());
    const retired = CATEGORY_DESTINATIONS.filter((d) => d.status !== 'live');
    expect(retired.length, 'if nothing is retired this test proves nothing — keep one flagged').toBeGreaterThan(0);
    for (const d of retired) {
      expect(hrefs).not.toContain(destinationHref(d));
    }
  });

  it('emits no /search link the shared list does not sanction', () => {
    // Stops a well-meaning edit adding "Skating" (or any other query with no listings behind
    // it) straight into the JSX, which is precisely how the two earlier lists drifted.
    const sanctioned = new Set<string>([
      ...liveCategoryDestinations().map(destinationHref),
      ...Object.values(SEARCH_SHORTCUTS).map((s) => s.href),
    ]);
    const unsanctioned = hrefsIn(html()).filter((h) => h.startsWith('/search') && !sanctioned.has(h));
    expect(unsanctioned).toEqual([]);
  });
});
