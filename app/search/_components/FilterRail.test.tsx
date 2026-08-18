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
    // "Any price" is deliberately absent: the whole Max price group was removed on Jon's beta
    // feedback (see app/search/_lib/params.ts). Asserted negatively so the group cannot creep
    // back without this test noticing.
    expect(html).not.toContain('>Any price<');
    expect(html).not.toContain('id="kf-fg-cost"');
  });

  it('every "Any X" pill is CHECKMARKED (aria-current) when its group is unset', () => {
    const html = render(DEFAULT_STATE);
    for (const label of ['Any age', 'Any area', 'Any day', 'Any time']) {
      expect(isActive(html, label)).toBe(true);
    }
  });

  it('the "Any X" pill DESELECTS once its group has a selection', () => {
    const html = render(st({ ages: ['5-9'], regions: ['van'] }));
    expect(isActive(html, 'Any age')).toBe(false); // an age is chosen
    expect(isActive(html, 'Any area')).toBe(false); // an area is chosen
    // Other groups, still unset, keep their Any-X pill active.
    expect(isActive(html, 'Any day')).toBe(true);
    expect(isActive(html, 'Any time')).toBe(true);
  });

  it('the "· optional" label now appears EXACTLY once — on Quick filters only', () => {
    const html = render(DEFAULT_STATE);
    expect((html.match(/kf-fgroup__optional"/g) || []).length).toBe(1);
    // …and it sits inside the Quick-filters group (after its id, before the Courses group).
    const optIdx = html.indexOf('kf-fgroup__optional"');
    expect(optIdx).toBeGreaterThan(html.indexOf('id="kf-fg-quick"'));
    expect(optIdx).toBeLessThan(html.indexOf('id="kf-fg-courses"'));
    // Ages/Areas no longer carry the label (they use the pill instead).
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

import { type FacetCounts } from '@/lib/search/facets';
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
    // Was the removed Max price group. Replaced with `category` — the one facet group that,
    // like costMax, maps to NO rail group (see FACET_KEY_FOR in rail-groups.ts), so the payload
    // stays as rich as it was without silently changing which groups the adaptive plan picks.
    { key: 'category', selection: 'breakdown', values: [
      { value: 'open_gym', count: 7, selected: false },
      { value: 'storytime', count: 4, selected: false },
    ] },
  ],
};

describe('FilterRail — chips carry NO count, whatever the facet payload says', () => {
  // This describe is the exact INVERSE of the block it replaces. Those tests asserted that a
  // supplied facet payload put a numeral on every chip; the counts were removed from the rail
  // on Jon's beta feedback, so the same payload must now change nothing about the markup.
  //
  // Asserting "no numeral" on a rail rendered WITHOUT facets would prove nothing — it never had
  // one. The count-removal only has teeth if it is asserted against a rail that has every
  // opportunity to render one, which is why these cases build the richest facet payload the old
  // tests used and then assert its total absence from the DOM.

  it('renders no numeral, no "N matching" phrase and no data-empty hook — bare /search', () => {
    const html = render(DEFAULT_STATE);
    expect(html).not.toContain('kf-fchip__n');
    expect(html).not.toContain('matching');
    expect(html).not.toContain('data-empty');
  });

  it('DECISIVE: the rail cannot be given counts — there is no prop to pass them through', () => {
    // The old API was <FilterRail facets={...} />. It is gone, so a caller cannot reintroduce
    // counts by wiring the payload back up; they would have to change the component. Rendered
    // with the identical state the old count tests used, the markup carries no numbers.
    const html = render(st({ ages: ['5-9'], regions: ['van'], free: true }));
    expect(html).not.toContain('kf-fchip__n');
    expect(html).not.toContain('matching');
    // …and the chips themselves are all still real, labelled links. Removing the numeral must
    // not have removed the control.
    expect(html).toContain('>Any age<');
    expect(html).toContain('>Vancouver<');
    expect(chipTag(html, 'Vancouver').startsWith('<a')).toBe(true);
  });

  it('every chip label is still exactly its label, with no digits appended', () => {
    const html = render(DEFAULT_STATE);
    for (const label of ['Any day', 'Today', 'Any age', 'Under 2', 'Any area', 'Vancouver', 'Free']) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it('renders all five age bands, 15+ last, each a real link', () => {
    // 15+ was off the rail for a period and is back (Jon, 2026-08-18) \u2014 this test used to assert
    // its ABSENCE. The order assertion is the part that matters beyond mere presence: the chips
    // must read youngest-first, so 15+ has to render after 10\u201314, not wherever AGE_OPTIONS
    // happened to put it.
    const html = render(DEFAULT_STATE);
    const labels = ['Under 2', '2\u20134', '5\u20139', '10\u201314', '15+'];
    for (const label of labels) expect(html).toContain(`>${label}<`);
    const positions = labels.map((l) => html.indexOf(`>${l}<`));
    const ascending = positions.every((p, i) => i === 0 || p > positions[i - 1]);
    expect(ascending, `age chips render out of order: ${JSON.stringify(positions)}`).toBe(true);
    // A chip, not inert text: tapping it has to be able to apply the band with JS off.
    expect(chipTag(html, '15+').startsWith('<a')).toBe(true);
  });
});

describe('FilterRail — optional group plan (the 9 → 5-6 reduction)', () => {
  // The rail no longer takes `facets` — the counts were removed from every chip. The facet
  // payload is still what rail-groups.ts PLANS from, so it is threaded into planRailGroups here
  // and nowhere else, which is exactly the split this change introduced.
  const planned = (state: SearchState, facets: FacetCounts | null = FACETS) =>
    renderToStaticMarkup(<FilterRail state={state} savedLocation={null} plan={planRailGroups(state, facets)} />);

  it('renders every group with no disclosure when no plan is given', () => {
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
