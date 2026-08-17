// tests/ui/query-summary-free-caveat.test.tsx
//
// COMPONENT-LEVEL PIN FOR OPTION C STEP 2c ("Free filter honesty fix", Jon's ruling
// 2026-08-17): the "Some results have unconfirmed pricing." disclosure must actually reach
// the rendered page, not just exist as a string a pure-function test can pass while the real
// component never wires it in. The brief calls this out by name (its own citation of "Trap E /
// page-level rendering gates") — this project has been burned before by exactly that shape of
// gap, so this renders the REAL QuerySummary component through react-dom/server rather than
// testing a formatter.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Same node-env approach as tests/ui/card-completeness.test.tsx: next/link needs no Next
// runtime for a markup assertion, so it renders as the plain <a> it becomes on the server.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { QuerySummary } from '../../app/search/_components/QuerySummary';
import { DEFAULT_STATE, type SearchState } from '../../app/search/_lib/params';

const CAVEAT = 'Some results have unconfirmed pricing.';

function summaryHtml(overrides: Partial<SearchState> = {}, countsKnown = true): string {
  const state: SearchState = { ...DEFAULT_STATE, ...overrides };
  return renderToStaticMarkup(
    <QuerySummary
      state={state}
      tokens={[]}
      confirmed={3}
      expected={0}
      sortLabel="Best match"
      clearHref="/search"
      countsKnown={countsKnown}
    />,
  );
}

describe('QuerySummary — the Free-filter honesty disclosure actually reaches the page', () => {
  it('renders the caveat when the Free filter is active', () => {
    const html = summaryHtml({ free: true });
    expect(html).toContain(CAVEAT);
  });

  it('does NOT render the caveat when the Free filter is off (no noise on every other search)', () => {
    const html = summaryHtml({ free: false });
    expect(html).not.toContain(CAVEAT);
  });

  it('does NOT render the caveat when the search failed and no results are being stated as fact', () => {
    // countsKnown=false is the "search itself failed" case (see QuerySummaryProps' own doc
    // comment) — nothing about the result set is being asserted yet, so the pricing caveat,
    // which is a claim about the results, has nothing to attach to either.
    const html = summaryHtml({ free: true }, false);
    expect(html).not.toContain(CAVEAT);
  });

  it('anti-vacuity: the two renders actually differ, so this is not comparing identical markup', () => {
    const withFree = summaryHtml({ free: true });
    const withoutFree = summaryHtml({ free: false });
    expect(withFree).not.toEqual(withoutFree);
  });
});
