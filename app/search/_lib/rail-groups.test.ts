import { describe, it, expect } from 'vitest';
import type { FacetCounts, FacetGroupCounts } from '@/lib/search/facets';
import { DEFAULT_STATE, type SearchState } from './params';
import {
  MAX_PRIMARY_GROUPS,
  RAIL_GROUP_ORDER,
  discriminationScore,
  pinnedGroups,
  planRailGroups,
  type RailGroupId,
} from './rail-groups';

function st(overrides: Partial<SearchState> = {}): SearchState {
  return { ...DEFAULT_STATE, ...overrides };
}

/** A facet group whose non-"any" values carry the given counts, against an `any` total. */
function group(key: string, total: number, counts: number[]): FacetGroupCounts {
  return {
    key: key as FacetGroupCounts['key'],
    selection: 'single',
    values: [
      { value: 'any', count: total, selected: true },
      ...counts.map((count, i) => ({ value: `v${i}`, count, selected: false })),
    ],
  };
}

/** Counts where every listed group discriminates equally; unlisted groups are absent. */
function facets(total: number, groups: FacetGroupCounts[]): FacetCounts {
  return { total, groups };
}

// The rail's whole viability rests on this file. A persistent sidebar showing all eight
// groups is the "relocates 46 controls without reducing them" failure the audit named —
// so the reduction has to be pinned, not merely intended.

describe('pinnedGroups — a filter the parent applied is never folded away', () => {
  it('pins nothing for an untouched search', () => {
    expect(pinnedGroups(DEFAULT_STATE)).toEqual([]);
  });

  it('pins each group the parent has actually constrained', () => {
    expect(pinnedGroups(st({ when: 'today' }))).toEqual(['when']);
    expect(pinnedGroups(st({ dateFrom: '2026-07-13', dateTo: '2026-07-15' }))).toEqual(['dates']);
    expect(pinnedGroups(st({ timeOfDay: 'morning' }))).toEqual(['timeOfDay']);
    expect(pinnedGroups(st({ ages: ['5-9'] }))).toEqual(['ages']);
    expect(pinnedGroups(st({ regions: ['van'] }))).toEqual(['areas']);
    expect(pinnedGroups(st({ costMaxCad: 20 }))).toEqual(['costMax']);
    expect(pinnedGroups(st({ lat: 49.2, lng: -123.1 }))).toEqual(['nearMe']);
  });

  it('pins "quick filters" once, whichever of the four independent toggles is on', () => {
    expect(pinnedGroups(st({ free: true }))).toEqual(['quick']);
    expect(pinnedGroups(st({ free: true, dropIn: true, rainyDay: true, bookableNow: true }))).toEqual(['quick']);
  });

  it('ignores the text query and the sort — neither is a rail group', () => {
    expect(pinnedGroups(st({ q: 'swim', sort: 'distance' }))).toEqual([]);
  });
});

describe('discriminationScore — can this group actually narrow the query?', () => {
  it('scores zero when every option returns the whole result set (narrows nothing)', () => {
    expect(discriminationScore(group('ages', 12, [12, 12, 12]), 12)).toBe(0);
  });

  it('scores zero when every option is a dead end (returns nothing)', () => {
    expect(discriminationScore(group('ages', 12, [0, 0, 0]), 12)).toBe(0);
  });

  it('counts only the options that are both reachable and narrowing', () => {
    expect(discriminationScore(group('ages', 12, [0, 5, 12, 3]), 12)).toBe(2);
  });

  it('falls back to the overall total for a group with no "any" option (the quick toggles)', () => {
    const quick: FacetGroupCounts = {
      key: 'quick',
      selection: 'toggle',
      values: [
        { value: 'free', count: 2, selected: false },
        { value: 'dropIn', count: 12, selected: false },
        { value: 'rainyDay', count: 0, selected: false },
      ],
    };
    expect(discriminationScore(quick, 12)).toBe(1);
  });
});

describe('planRailGroups — the 8 → 5-6 reduction that makes the rail viable', () => {
  it('never shows all eight groups up front on an untouched search', () => {
    const plan = planRailGroups(DEFAULT_STATE, null);
    expect(plan.primary.length).toBeLessThanOrEqual(MAX_PRIMARY_GROUPS);
    expect(plan.secondary.length).toBeGreaterThan(0);
  });

  it('folds rather than drops — primary + secondary is always every group, exactly once', () => {
    const cases: Array<FacetCounts | null> = [
      null,
      facets(12, [group('when', 12, [2, 2, 2]), group('ages', 12, [7, 9, 10])]),
      facets(12, []),
    ];
    for (const f of cases) {
      const plan = planRailGroups(st({ ages: ['5-9'], free: true }), f);
      expect([...plan.primary, ...plan.secondary].sort()).toEqual([...RAIL_GROUP_ORDER].sort());
    }
  });

  it('renders in canonical order, so the rail never reshuffles between queries', () => {
    const plan = planRailGroups(
      DEFAULT_STATE,
      facets(12, [group('costMax', 12, [11]), group('when', 12, [2, 3]), group('ages', 12, [7, 9, 10])]),
    );
    const order = (ids: RailGroupId[]) => ids.map((id) => RAIL_GROUP_ORDER.indexOf(id));
    expect(order(plan.primary)).toEqual([...order(plan.primary)].sort((a, b) => a - b));
    expect(order(plan.secondary)).toEqual([...order(plan.secondary)].sort((a, b) => a - b));
  });

  it('keeps every applied filter up front even when that exceeds the soft cap', () => {
    const everything = st({
      when: 'today',
      timeOfDay: 'morning',
      ages: ['5-9'],
      regions: ['van'],
      free: true,
      costMaxCad: 20,
      lat: 49.2,
      lng: -123.1,
      dateFrom: '2026-07-13',
      dateTo: '2026-07-15',
    });
    const plan = planRailGroups(everything, facets(12, []));
    expect(plan.secondary).toEqual([]);
    expect(plan.primary).toEqual(RAIL_GROUP_ORDER);
  });

  it('always keeps the geo entry point up front (radius-first geography, PRD v1.2)', () => {
    expect(planRailGroups(DEFAULT_STATE, facets(12, [])).primary).toContain('nearMe');
    expect(planRailGroups(DEFAULT_STATE, null).primary).toContain('nearMe');
  });

  it('never promotes the custom date range on counts alone — it is the tallest control', () => {
    const plan = planRailGroups(DEFAULT_STATE, facets(12, [group('when', 12, [2, 3, 4])]));
    expect(plan.secondary).toContain('dates');
  });

  it('shows the range up front the moment a parent sets one', () => {
    const plan = planRailGroups(st({ dateFrom: '2026-07-13', dateTo: '2026-07-15' }), facets(12, []));
    expect(plan.primary).toContain('dates');
  });

  it('folds groups whose every option returns everything or nothing (they buy no space back)', () => {
    const plan = planRailGroups(
      DEFAULT_STATE,
      facets(12, [
        group('when', 12, [2, 3, 4]), // narrows
        group('ages', 12, [5, 9]), // narrows
        group('timeOfDay', 12, [12, 12, 12]), // narrows nothing
        group('costMax', 12, [0, 0]), // all dead ends
      ]),
    );
    expect(plan.primary).toContain('when');
    expect(plan.primary).toContain('ages');
    expect(plan.secondary).toContain('timeOfDay');
    expect(plan.secondary).toContain('costMax');
  });

  it('prefers the group that partitions this query best when it has to choose', () => {
    // Six scoreable candidates for five slots (nearMe always takes the sixth), so exactly
    // one folds — and it must be the group that partitions this query least.
    const plan = planRailGroups(
      DEFAULT_STATE,
      facets(20, [
        group('when', 20, [1]), // 1 discriminating option — the weakest
        group('timeOfDay', 20, [1, 2]), // 2
        group('ages', 20, [1, 2, 3, 4, 5]), // 5
        group('areas', 20, [1, 2, 3]), // 3
        group('quick', 20, [1, 2]), // 2
        group('costMax', 20, [1, 2, 3, 4]), // 4
      ]),
    );
    expect(plan.primary).toEqual(['timeOfDay', 'ages', 'areas', 'quick', 'costMax', 'nearMe']);
    expect(plan.secondary).toEqual(['when', 'dates']);
  });

  it('degrades to a FIXED 6-group set — not to all eight — when counts are unavailable', () => {
    const plan = planRailGroups(DEFAULT_STATE, null);
    expect(plan.adaptive).toBe(false);
    expect(plan.primary).toEqual(['when', 'ages', 'areas', 'quick', 'costMax', 'nearMe']);
    expect(plan.secondary).toEqual(['dates', 'timeOfDay']);
  });

  it('reports whether the selection was count-driven, so the UI can say so honestly', () => {
    expect(planRailGroups(DEFAULT_STATE, facets(12, [])).adaptive).toBe(true);
    expect(planRailGroups(DEFAULT_STATE, undefined).adaptive).toBe(false);
  });
});
