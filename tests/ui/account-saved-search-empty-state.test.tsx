// tests/ui/account-saved-search-empty-state.test.tsx — /account's saved-search list.
//
// TWO THINGS ARE GUARDED HERE, and the first is the reason the unit exists.
//
// 1. A saved search that matches nothing says so, ON THIS PAGE, unconditionally. The weekly
//    email can only carry that line inside an email that is already being sent — and a
//    parent whose every saved search matches nothing gets no email at all. The population
//    that most needs the explanation is exactly the population no email can reach, so
//    /account is the surface that has to be unconditional.
//
// 2. The row's SUMMARY is read through the same parser that EXECUTES the search. A search
//    saved before the beta removal of the price controls can still carry `cost=` /
//    `includeUnknownCost=`; parseSearchState ignores unrecognised params, so those apply
//    nothing — but the old summary counted raw stored keys and therefore advertised filters
//    whose behaviour was already gone.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SavedSearches, type SavedSearchView } from '../../app/account/_components/SavedSearches';

function row(overrides: Partial<SavedSearchView> = {}): SavedSearchView {
  return {
    id: 'ss-1',
    name: null,
    params: { q: 'swim' },
    created_at: '2026-07-01T00:00:00.000Z',
    last_run_at: null,
    ...overrides,
  };
}

function render(items: SavedSearchView[], emptyById: Record<string, { blockingLabel: string | null }> = {}) {
  return renderToStaticMarkup(<SavedSearches initial={items} emptyById={emptyById} />);
}

/** The row's summary line only — the surrounding "Save a new search" form also says "Filters". */
function metaLine(html: string): string {
  return html.match(/kf-saved__item-meta">([^<]*)</)?.[1] ?? '';
}

describe('/account saved searches — empty-state line', () => {
  it('names the blocking constraint for a search that matches nothing', () => {
    const html = render([row({ name: 'Weekend swim' })], { 'ss-1': { blockingLabel: 'date' } });
    expect(html).toContain('No matches right now — removing the date would show results.');
  });

  it('is not price-specific — any constraint reads the same way', () => {
    for (const label of ['price limit', 'time of day', 'age filter', 'distance', 'Rainy-day (indoor) filter']) {
      const html = render([row()], { 'ss-1': { blockingLabel: label } });
      expect(html).toContain(`No matches right now — removing the ${label} would show results.`);
    }
  });

  it('falls back to the honest wording when no single filter unlocks results', () => {
    const html = render([row()], { 'ss-1': { blockingLabel: null } });
    expect(html).toContain('No matches right now — relaxing any single filter still shows none.');
  });

  it('says nothing about a search that is matching fine', () => {
    const html = render([row()], {});
    expect(html).not.toContain('No matches right now');
  });

  it('only marks the rows that are actually empty', () => {
    const html = render([row({ id: 'ss-1', name: 'Fine' }), row({ id: 'ss-2', name: 'Blocked' })], {
      'ss-2': { blockingLabel: 'age filter' },
    });
    expect(html.match(/No matches right now/g)).toHaveLength(1);
    expect(html).toContain('removing the age filter');
  });
});

describe('/account saved searches — the summary cannot outlive the behaviour', () => {
  it('does not count params the parser no longer recognises (inert cost= / includeUnknownCost=)', () => {
    // A row saved BEFORE the beta removal. Both extra params are inert: parseSearchState
    // ignores them, so no price ceiling and no unknown-cost switch reaches the engine.
    const meta = metaLine(render([row({ name: 'Legacy', params: { q: 'swim', cost: '20', includeUnknownCost: '1' } })]));
    expect(meta).toContain('“swim”');
    expect(meta).not.toContain('filter'); // NOT "2 filters" — neither of them filters anything
  });

  it('still counts the filters that do apply, alongside inert ones', () => {
    const meta = metaLine(
      render([row({ name: 'Mixed', params: { q: 'swim', region: 'van', cost: '20', includeUnknownCost: '1' } })]),
    );
    expect(meta).toContain('1 filter');
    expect(meta).not.toContain('3 filters');
  });

  it('counts a genuinely multi-filter search correctly', () => {
    const meta = metaLine(
      render([row({ name: 'Real', params: { q: 'swim', region: 'van', free: '1', age: 'under2' } })]),
    );
    expect(meta).toContain('3 filters');
  });
});
