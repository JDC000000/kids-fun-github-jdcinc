import { describe, it, expect } from 'vitest';
import { DEFAULT_RADIUS, DEFAULT_STATE, type SearchState } from './params';
import {
  activeFilterCount,
  appliedFilterTokens,
  otherFilterChips,
  whenChipLabel,
  whereChipLabel,
  type SummaryLocation,
} from './filter-summary';

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

// The desktop query summary line ("swim · Saturday · Ages 5-9 · North Van") is the same
// derivation the phone bar uses, so the two surfaces can never disagree about what is
// applied. Each token also carries the patch that removes JUST itself — the line doubles
// as the applied-filter row, which is the one idea worth keeping from Proposal B.

describe('appliedFilterTokens — the query in words, each part removable', () => {
  const labels = (s: SearchState, loc: SummaryLocation | null = null) =>
    appliedFilterTokens(s, loc).map((t) => t.label);
  const byKey = (s: SearchState, key: string, loc: SummaryLocation | null = null) =>
    appliedFilterTokens(s, loc).find((t) => t.key === key);

  it('is empty for an untouched search — there is no query to state', () => {
    expect(appliedFilterTokens(DEFAULT_STATE, null)).toEqual([]);
  });

  it('reads date, then place, then the rest — the rail’s own order', () => {
    const state = st({ when: 'weekend', regions: ['nvan'], ages: ['5-9'], free: true });
    expect(labels(state)).toEqual(['This weekend', 'North Van', 'Ages 5–9', 'Free']);
  });

  it('states a custom range instead of the quick-pick — the range is what actually filters', () => {
    const state = st({ when: 'today', dateFrom: '2026-07-13', dateTo: '2026-07-15' });
    expect(appliedFilterTokens(state, null).filter((t) => t.scope === 'when')).toHaveLength(1);
  });

  it('clears BOTH halves of the date intent, so removing it cannot leave the other filtering', () => {
    expect(byKey(st({ when: 'today' }), 'when')?.clear).toEqual({ when: 'any', dateFrom: null, dateTo: null });
    expect(byKey(st({ dateFrom: '2026-07-13', dateTo: '2026-07-15' }), 'dates')?.clear).toEqual({
      dateFrom: null,
      dateTo: null,
    });
  });

  it('makes each area independently removable — dropping Richmond must keep Vancouver', () => {
    const state = st({ regions: ['van', 'rmd'] });
    expect(byKey(state, 'area:rmd')?.clear).toEqual({ regions: ['van'] });
    expect(byKey(state, 'area:van')?.clear).toEqual({ regions: ['rmd'] });
  });

  it('drops the radius with the origin — a radius with nothing to measure from is not a filter', () => {
    expect(byKey(st({ lat: 49.27, lng: -123.07, radiusKm: 5 }), 'origin')?.clear).toEqual({
      lat: null,
      lng: null,
      radiusKm: DEFAULT_RADIUS,
    });
    expect(byKey(st({ useSavedLocation: true, radiusKm: 20 }), 'origin', { areaLabel: 'North Vancouver' })?.clear).toEqual(
      { useSavedLocation: false, radiusKm: DEFAULT_RADIUS },
    );
  });

  it('never claims a saved location the search could not resolve', () => {
    expect(labels(st({ useSavedLocation: true }), null)).toEqual([]);
  });

  it('keeps the age bands as ONE answer to "who is this for", not one token per band', () => {
    expect(labels(st({ ages: ['5-9', '10-14'] }))).toEqual(['Ages 5–9 & 10–14']);
  });

  it('agrees with activeFilterCount about whether anything is applied at all', () => {
    const cases: SearchState[] = [
      DEFAULT_STATE,
      st({ q: 'swim' }),
      st({ free: true }),
      st({ when: 'today', ages: ['2-4'], regions: ['van'], costMaxCad: 20 }),
      st({ lat: 49.2, lng: -123.1 }),
    ];
    for (const state of cases) {
      expect(appliedFilterTokens(state, null).length > 0).toBe(activeFilterCount(state) > 0);
    }
  });

  it('feeds the phone bar: otherFilterChips is exactly the "other" tokens, in the same order', () => {
    const state = st({ when: 'today', regions: ['van'], timeOfDay: 'morning', ages: ['5-9'], free: true, costMaxCad: 20 });
    expect(otherFilterChips(state)).toEqual(
      appliedFilterTokens(state, null).filter((t) => t.scope === 'other').map((t) => t.label),
    );
  });
});
