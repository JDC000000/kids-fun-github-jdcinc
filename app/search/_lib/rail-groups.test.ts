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

/**
 * The registration group's real shape (lib/search/facets.ts). Unlike every other group it
 * carries no "any" value and its second value is the LARGER one: `includeRegistration` is
 * what the result set would become if courses were let back in.
 */
function registrationGroup(dropInOnly: number, includeRegistration: number): FacetGroupCounts {
  return {
    key: 'registration' as FacetGroupCounts['key'],
    selection: 'single',
    values: [
      { value: 'dropInOnly', count: dropInOnly, selected: true },
      { value: 'includeRegistration', count: includeRegistration, selected: false },
    ],
  };
}

// The rail's whole viability rests on this file. A persistent sidebar showing all nine
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
    expect(pinnedGroups(st({ lat: 49.2, lng: -123.1 }))).toEqual(['nearMe']);
  });

  it('pins Courses once a parent has opted registration content IN', () => {
    // It widens rather than narrows, but the rule is the same and matters more here: a parent
    // who turned courses on and cannot see the control has no way to turn them back off, and
    // no explanation for why 12-week programmes are suddenly in their "what's on today" list.
    expect(pinnedGroups(st({ includeRegistration: true }))).toEqual(['courses']);
    expect(pinnedGroups(st({ includeRegistration: false }))).toEqual([]);
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

  it('scores the registration group on the GAP, because it is the one group that widens', () => {
    // Its two values are "drop-in only" (the default, narrower) and "include registration"
    // (wider). Neither is ever smaller than the other by narrowing, so the generic
    // reachable-and-narrowing rule would score it zero forever and fold it away permanently.
    // What actually matters is whether this search is holding any course content back.
    const withCourses = registrationGroup(12, 31);
    const withoutCourses = registrationGroup(12, 12);
    expect(discriminationScore(withCourses, 12)).toBe(1);
    expect(discriminationScore(withoutCourses, 12)).toBe(0);
  });
});

describe('planRailGroups — the 9 → 5-6 reduction that makes the rail viable', () => {
  it('never shows all nine groups up front on an untouched search', () => {
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
      includeRegistration: true,
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
        group('courses', 12, [0, 0]), // all dead ends
      ]),
    );
    expect(plan.primary).toContain('when');
    expect(plan.primary).toContain('ages');
    expect(plan.secondary).toContain('timeOfDay');
    expect(plan.secondary).toContain('courses');
  });

  it('prefers the group that partitions this query best when it has to choose', () => {
    // Six scoreable candidates for five slots (nearMe always takes the sixth), so exactly
    // one folds — and it must be the group that partitions this query least. `costMax` was one
    // of the six until the Max price group was removed; `courses` takes its place here so the
    // case still exercises a genuine six-into-five squeeze rather than degenerating to a
    // five-candidate set where nothing has to fold and the ranking is never tested.
    const plan = planRailGroups(
      DEFAULT_STATE,
      facets(20, [
        group('when', 20, [1, 2, 3, 4, 5]), // 5
        group('timeOfDay', 20, [1, 2, 3, 4]), // 4
        group('ages', 20, [1, 2, 3]), // 3
        group('areas', 20, [1, 2]), // 2
        group('quick', 20, [1, 2]), // 2
        // Courses scores at most 1 by construction (it widens rather than narrows — see
        // discriminationScore), so it is the strictly weakest candidate here and is the one
        // that must fold. Using it as the loser keeps the case decided by SCORE rather than by
        // the RAIL_GROUP_ORDER tie-break, which is what this test is actually about.
        registrationGroup(12, 31), // 1
      ]),
    );
    expect(plan.primary).toEqual(['when', 'timeOfDay', 'ages', 'areas', 'quick', 'nearMe']);
    expect(plan.secondary).toEqual(['dates', 'courses']);
  });

  it('degrades to a FIXED set — not to every group — when counts are unavailable', () => {
    // FALLBACK_PRIORITY lost `costMax` with the Max price group, so the fixed set is now five
    // (the four remaining priorities + the always-primary nearMe) rather than six. The point of
    // the test is unchanged and is asserted explicitly below: the fallback must still be a
    // REDUCTION, not a silent "show everything".
    const plan = planRailGroups(DEFAULT_STATE, null);
    expect(plan.adaptive).toBe(false);
    expect(plan.primary).toEqual(['when', 'timeOfDay', 'ages', 'areas', 'quick', 'nearMe']);
    expect(plan.secondary).toEqual(['dates', 'courses']);
    expect(plan.secondary.length).toBeGreaterThan(0);
  });

  it('offers Courses up front only when this search is actually holding course content back', () => {
    // A skating search where every result is a drop-in session has nothing to opt into, so the
    // control is dead weight in a 200px rail. A swim search sitting on 19 hidden lesson courses
    // is exactly where a parent should be offered the choice without hunting for it.
    const nothingHeldBack = planRailGroups(
      DEFAULT_STATE,
      facets(12, [registrationGroup(12, 12), group('when', 12, [2, 3])]),
    );
    expect(nothingHeldBack.secondary).toContain('courses');

    const coursesHeldBack = planRailGroups(
      DEFAULT_STATE,
      facets(12, [registrationGroup(12, 31), group('when', 12, [2, 3])]),
    );
    expect(coursesHeldBack.primary).toContain('courses');
  });

  it('reports whether the selection was count-driven, so the UI can say so honestly', () => {
    expect(planRailGroups(DEFAULT_STATE, facets(12, [])).adaptive).toBe(true);
    expect(planRailGroups(DEFAULT_STATE, undefined).adaptive).toBe(false);
  });
});
