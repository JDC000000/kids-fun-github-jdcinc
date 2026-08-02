import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// FilterRail's only next/navigation consumer in-tree is NearMeButton (useRouter). Stub it so
// the whole rail renders to static markup in the node env (no jsdom, mirroring ui.test.tsx).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));

import { FilterRail } from './FilterRail';
import { DEFAULT_STATE, type SearchState } from '../_lib/params';

function st(overrides: Partial<SearchState> = {}): SearchState {
  return { ...DEFAULT_STATE, ...overrides };
}
function render(state: SearchState): string {
  return renderToStaticMarkup(<FilterRail state={state} savedLocation={null} />);
}
/** The opening <a …> tag (attrs) of the chip whose visible label is exactly `label`. */
function chipTag(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  if (at === -1) throw new Error(`chip "${label}" not found`);
  return html.slice(html.lastIndexOf('<a', at), at);
}
const isActive = (html: string, label: string) => chipTag(html, label).includes('aria-current="true"');

describe('FilterRail — consistent "Any X" default pill across chip groups (Round 30)', () => {
  it('renders an "Any age" and "Any area" default pill (the gap the UX review flagged)', () => {
    const html = render(DEFAULT_STATE);
    expect(html).toContain('>Any age<');
    expect(html).toContain('>Any area<');
    // The pre-existing "Any X" pills are still there (regression guard).
    expect(html).toContain('>Any day<');
    expect(html).toContain('>Any time<');
    expect(html).toContain('>Any price<');
  });

  it('every "Any X" pill is CHECKMARKED (aria-current) when its group is unset', () => {
    const html = render(DEFAULT_STATE);
    for (const label of ['Any age', 'Any area', 'Any day', 'Any time', 'Any price']) {
      expect(isActive(html, label)).toBe(true);
    }
  });

  it('the "Any X" pill DESELECTS once its group has a selection', () => {
    const html = render(st({ ages: ['5-9'], regions: ['van'] }));
    expect(isActive(html, 'Any age')).toBe(false); // an age is chosen
    expect(isActive(html, 'Any area')).toBe(false); // an area is chosen
    // Other groups, still unset, keep their Any-X pill active.
    expect(isActive(html, 'Any day')).toBe(true);
    expect(isActive(html, 'Any price')).toBe(true);
  });

  it('the "· optional" label now appears EXACTLY once — on Quick filters only', () => {
    const html = render(DEFAULT_STATE);
    expect((html.match(/kf-fgroup__optional"/g) || []).length).toBe(1);
    // …and it sits inside the Quick-filters group (after its id, before the Max-price group).
    const optIdx = html.indexOf('kf-fgroup__optional"');
    expect(optIdx).toBeGreaterThan(html.indexOf('id="kf-fg-quick"'));
    expect(optIdx).toBeLessThan(html.indexOf('id="kf-fg-cost"'));
    // Ages/Areas/Max-price no longer carry the label (they use the pill instead).
    const between = (fromId: string, toId: string) =>
      html.slice(html.indexOf(`id="${fromId}"`), html.indexOf(`id="${toId}"`));
    expect(between('kf-fg-ages', 'kf-fg-areas')).not.toContain('kf-fgroup__optional');
    expect(between('kf-fg-areas', 'kf-fg-quick')).not.toContain('kf-fgroup__optional');
  });
});

// ── Round 31: the two optional extensions the desktop rail turns on ──────────────────
// Both default to OFF so the inline rail and the mobile sheet (which pass neither) render
// exactly the markup they rendered before. These pin that, and pin that folding never
// costs a chip its <Link>-ness — which is what the Round 18 a11y fix bought.

import { facetCount, type FacetCounts } from '@/lib/search/facets';
import { planRailGroups } from '../_lib/rail-groups';

const FACETS: FacetCounts = {
  total: 12,
  groups: [
    { key: 'when', selection: 'single', values: [
      { value: 'any', count: 12, selected: true },
      { value: 'today', count: 2, selected: false },
      { value: 'tomorrow', count: 0, selected: false },
      { value: 'weekend', count: 5, selected: false },
    ] },
    { key: 'ages', selection: 'multi', values: [
      { value: 'any', count: 12, selected: true },
      { value: '5-9', count: 7, selected: false },
    ] },
    { key: 'areas', selection: 'multi', values: [
      { value: 'any', count: 12, selected: true },
      { value: 'van', count: 7, selected: false },
    ] },
    { key: 'quick', selection: 'toggle', values: [{ value: 'free', count: 2, selected: false }] },
    { key: 'costMax', selection: 'single', values: [
      { value: 'any', count: 12, selected: true },
      { value: '20', count: 4, selected: false },
    ] },
  ],
};

describe('FilterRail — optional facet counts (Proposal C)', () => {
  it('renders no counts at all when the caller supplies none (the pre-count markup)', () => {
    expect(render(DEFAULT_STATE)).not.toContain('kf-fchip__n');
  });

  it('puts each chip’s live count beside its label when facets are supplied', () => {
    const html = renderToStaticMarkup(<FilterRail state={DEFAULT_STATE} savedLocation={null} facets={FACETS} />);
    expect(html).toContain('>Today<');
    expect(html).toContain('kf-fchip__n');
    // Sighted numeral AND a spoken phrase — a bare trailing digit is ambiguous read aloud.
    expect(html).toContain('2 matching');
  });

  it('marks a zero-count chip as empty but leaves it a real, focusable link', () => {
    const html = renderToStaticMarkup(<FilterRail state={DEFAULT_STATE} savedLocation={null} facets={FACETS} />);
    const tag = chipTag(html, 'Tomorrow');
    expect(tag).toContain('data-empty="true"');
    expect(tag.startsWith('<a')).toBe(true);
    expect(tag).toContain('href=');
  });

  it('never invents a count for a value the facets do not carry', () => {
    expect(facetCount(FACETS, 'when', 'never')).toBeNull();
    const html = renderToStaticMarkup(<FilterRail state={DEFAULT_STATE} savedLocation={null} facets={FACETS} />);
    // Time of day has no facet group here, so its chips carry no numerals.
    const timeBlock = html.slice(html.indexOf('id="kf-fg-time"'), html.indexOf('id="kf-fg-ages"'));
    expect(timeBlock).not.toContain('kf-fchip__n');
  });
});

describe('FilterRail — optional group plan (the 9 → 5-6 reduction)', () => {
  const planned = (state: SearchState, facets: FacetCounts | null = FACETS) =>
    renderToStaticMarkup(
      <FilterRail state={state} savedLocation={null} facets={facets} plan={planRailGroups(state, facets)} />,
    );

  it('renders all nine groups with no disclosure when no plan is given', () => {
    const html = render(DEFAULT_STATE);
    expect(html).not.toContain('kf-filters__more');
    const ids = [
      'kf-fg-when',
      'kf-fg-daterange',
      'kf-fg-time',
      'kf-fg-ages',
      'kf-fg-areas',
      'kf-fg-quick',
      'kf-fg-courses',
      'kf-fg-cost',
      'kf-fg-near',
    ];
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    // Count them too: a group silently dropped from the record would still pass the loop above.
    expect(html.match(/class="kf-fgroup"/g)).toHaveLength(ids.length);
  });

  it('offers Courses up front only when this search is holding course content back', () => {
    // The gap between the two counts IS the reason to show it — see rail-groups.ts.
    const held = planned(DEFAULT_STATE, {
      ...FACETS,
      groups: [
        ...FACETS.groups,
        {
          key: 'registration',
          selection: 'single',
          values: [
            { value: 'dropInOnly', count: 12, selected: true },
            { value: 'includeRegistration', count: 31, selected: false },
          ],
        },
      ],
    });
    expect(held.slice(0, held.indexOf('<details'))).toContain('id="kf-fg-courses"');
  });

  it('folds the rest behind a native <details> — no JavaScript needed to reach them', () => {
    const html = planned(DEFAULT_STATE);
    expect(html).toContain('<details');
    expect(html).toContain('More filters');
  });

  it('still renders every folded chip as a real <Link>, so deep links keep resolving', () => {
    // The custom-date group always folds on an untouched search; its controls must survive.
    const html = planned(DEFAULT_STATE);
    expect(html).toContain('id="kf-fg-daterange"');
    expect(html).toContain('href="/search?');
  });

  it('never folds a group the parent has already applied', () => {
    const state = st({ timeOfDay: 'morning' });
    const html = planned(state);
    const details = html.slice(html.indexOf('<details'));
    expect(details).not.toContain('id="kf-fg-time"');
    expect(html).toContain('id="kf-fg-time"');
  });
});
