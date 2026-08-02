import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE, type SearchState } from './params';
import { activeFilterCount, whenChipLabel, whereChipLabel } from './filter-summary';

function st(overrides: Partial<SearchState> = {}): SearchState {
  return { ...DEFAULT_STATE, ...overrides };
}

// The mobile sticky filter bar (Blueprint §04) is a SUMMARY of state a parent can no
// longer see — the 11 filter groups now live behind a bottom sheet. If the summary is
// wrong the parent is filtering blind, so the derivation is pure and pinned here rather
// than assembled inline in the component.

describe('activeFilterCount — the "⚙ N" badge on the sticky bar', () => {
  it('is 0 for an untouched search (nothing is filtering)', () => {
    expect(activeFilterCount(DEFAULT_STATE)).toBe(0);
  });

  it('ignores the text query, sort and the include-unknown-cost default — none of them narrow by facet', () => {
    expect(activeFilterCount(st({ q: 'swim', sort: 'distance', includeUnknownCost: false }))).toBe(0);
  });

  it('counts a GROUP once, however many chips inside it are selected', () => {
    expect(activeFilterCount(st({ ages: ['5-9'] }))).toBe(1);
    expect(activeFilterCount(st({ ages: ['under2', '2-4', '5-9'] }))).toBe(1);
    expect(activeFilterCount(st({ regions: ['van'] }))).toBe(1);
    expect(activeFilterCount(st({ regions: ['van', 'nvan', 'bby'] }))).toBe(1);
  });

  it('counts each independent quick filter separately (they are orthogonal facets)', () => {
    expect(activeFilterCount(st({ free: true }))).toBe(1);
    expect(activeFilterCount(st({ free: true, dropIn: true, rainyDay: true, bookableNow: true }))).toBe(4);
  });

  it('counts a custom date range as the same single "when" constraint the quick-pick is', () => {
    expect(activeFilterCount(st({ when: 'today' }))).toBe(1);
    expect(activeFilterCount(st({ dateFrom: '2026-07-13', dateTo: '2026-07-15' }))).toBe(1);
    // when + range cannot both apply (the UI clears one when the other is set), but even
    // if a hand-written URL carries both it is still ONE date constraint to the parent.
    expect(activeFilterCount(st({ when: 'today', dateFrom: '2026-07-13', dateTo: '2026-07-15' }))).toBe(1);
  });

  it('counts a half-open (invalid) date range as no constraint — it does not filter', () => {
    expect(activeFilterCount(st({ dateFrom: '2026-07-13' }))).toBe(0);
    expect(activeFilterCount(st({ dateTo: '2026-07-15' }))).toBe(0);
  });

  it('counts an origin (near-me coords or the saved location) once — the radius rides with it', () => {
    expect(activeFilterCount(st({ lat: 49.27, lng: -123.07 }))).toBe(1);
    expect(activeFilterCount(st({ lat: 49.27, lng: -123.07, radiusKm: 20 }))).toBe(1);
    expect(activeFilterCount(st({ useSavedLocation: true }))).toBe(1);
  });

  it('a radius alone is not a filter — it only bites once there is an origin to measure from', () => {
    expect(activeFilterCount(st({ radiusKm: 20 }))).toBe(0);
  });

  it('sums across groups', () => {
    const state = st({ when: 'today', ages: ['5-9'], regions: ['nvan'], free: true, costMaxCad: 20 });
    expect(activeFilterCount(state)).toBe(5);
  });

  it('never disagrees with hasActiveFilters — a non-zero badge means filters ARE applied', async () => {
    const { hasActiveFilters } = await import('./params');
    const cases: Partial<SearchState>[] = [
      {},
      { q: 'swim' },
      { when: 'weekend' },
      { timeOfDay: 'morning' },
      { ages: ['2-4'] },
      { regions: ['bby'] },
      { costMaxCad: 50 },
      { dropIn: true },
      { useSavedLocation: true },
      { dateFrom: '2026-07-13', dateTo: '2026-07-15' },
    ];
    for (const c of cases) {
      const state = st(c);
      expect(activeFilterCount(state) > 0, JSON.stringify(c)).toBe(hasActiveFilters(state));
    }
  });
});

describe('whenChipLabel — the [ When ▾ ] control on the sticky bar', () => {
  it('reads "Any day" when unset, so an untouched group never looks like a constraint', () => {
    expect(whenChipLabel(DEFAULT_STATE)).toBe('Any day');
  });

  it('mirrors the quick-pick label the sheet shows', () => {
    expect(whenChipLabel(st({ when: 'today' }))).toBe('Today');
    expect(whenChipLabel(st({ when: 'tomorrow' }))).toBe('Tomorrow');
    expect(whenChipLabel(st({ when: 'weekend' }))).toBe('This weekend');
  });

  it('shows a custom range in parent-readable short dates', () => {
    expect(whenChipLabel(st({ dateFrom: '2026-07-13', dateTo: '2026-07-15' }))).toBe('Jul 13 – Jul 15');
    expect(whenChipLabel(st({ dateFrom: '2026-07-13', dateTo: '2026-07-13' }))).toBe('Jul 13');
  });

  it('prefers the range over a stale quick-pick (the range is what actually filters)', () => {
    expect(whenChipLabel(st({ when: 'today', dateFrom: '2026-07-13', dateTo: '2026-07-15' }))).toBe('Jul 13 – Jul 15');
  });
});

describe('whereChipLabel — the [ Where ▾ ] control on the sticky bar', () => {
  it('reads "Any area" when nothing narrows the geography', () => {
    expect(whereChipLabel(DEFAULT_STATE, null)).toBe('Any area');
  });

  it('names a single selected area', () => {
    expect(whereChipLabel(st({ regions: ['nvan'] }), null)).toBe('North Van');
  });

  it('names the first area and counts the rest, so the control never wraps', () => {
    expect(whereChipLabel(st({ regions: ['van', 'nvan'] }), null)).toBe('Vancouver +1');
    expect(whereChipLabel(st({ regions: ['van', 'nvan', 'bby'] }), null)).toBe('Vancouver +2');
  });

  it('states the near-me origin WITH its radius — the radius is meaningless without it', () => {
    expect(whereChipLabel(st({ lat: 49.27, lng: -123.07, radiusKm: 5 }), null)).toBe('Near you · 5 km');
  });

  it('names the signed-in saved location when that origin is the one in play', () => {
    expect(whereChipLabel(st({ useSavedLocation: true, radiusKm: 20 }), { areaLabel: 'North Vancouver' })).toBe(
      'North Vancouver · 20 km',
    );
  });

  it('falls back to areas when a saved-location intent could NOT be resolved (no signed-in profile behind it)', () => {
    // `home=1` with no resolvable saved postal is not a real origin — page.tsx degrades it
    // to null, and the bar must not claim a location the search is not actually using.
    expect(whereChipLabel(st({ useSavedLocation: true, regions: ['bby'] }), null)).toBe('Burnaby');
    expect(whereChipLabel(st({ useSavedLocation: true }), null)).toBe('Any area');
  });

  it('lets browser coords win over the saved-location intent, exactly as the search itself does', () => {
    expect(
      whereChipLabel(st({ lat: 49.27, lng: -123.07, useSavedLocation: true, radiusKm: 10 }), {
        areaLabel: 'North Vancouver',
      }),
    ).toBe('Near you · 10 km');
  });
});
