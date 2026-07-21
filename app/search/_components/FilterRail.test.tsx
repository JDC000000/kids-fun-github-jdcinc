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
