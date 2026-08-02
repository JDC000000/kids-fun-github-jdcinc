import type { FacetCounts, FacetGroupCounts } from '@/lib/search/facets';
import { hasDateRange, hasOrigin, type SearchState } from './params';

/**
 * WHICH filter groups the rail shows up front — the adaptive-selection half of the
 * desktop design (Proposal C in the 1 Aug desktop-scope decision).
 *
 * WHY THIS EXISTS AT ALL
 * A persistent sidebar that statically lists all nine groups is the same crowding
 * problem rotated ninety degrees, and worse: the mobile sheet at least scrolls away.
 * The measured desktop filter block is 400px tall with its groups permanently
 * expanded, which is the single largest contributor to results starting below the
 * fold. Relocating those groups into a rail without REDUCING them was the
 * failure mode the audit named ("A relocates 46 controls without reducing them"),
 * so reduction is not a nice-to-have here — it is the thing that makes the rail
 * viable. The target is 5-6 groups up front, the rest one disclosure away.
 *
 * WHAT "ADAPTIVE" MEANS
 * With live facet counts (lib/search/facets.ts, `&facets=1`) a group can be judged on
 * whether it would actually do anything for THIS query: a group whose every option
 * returns either the whole result set or nothing cannot narrow the search, so showing
 * it costs vertical space and buys nothing. Those groups fold away; the ones that can
 * genuinely partition the results stay up front.
 *
 * NOTHING IS EVER REMOVED, ONLY FOLDED
 * `secondary` groups still render, inside a native <details> disclosure. That is
 * deliberate and load-bearing:
 *   - every chip stays a real <Link> in the DOM, so the URL/deep-link contract and the
 *     homepage quick-start links are untouched (see FilterRail.tsx's Round-18 note);
 *   - <details> needs no JavaScript, so a JS-off parent can still reach every filter;
 *   - a filter the parent has ALREADY APPLIED is never folded (see `pinnedGroups`) —
 *     hiding applied state would leave them filtering blind with no way to clear it.
 *
 * DEGRADATION
 * `facets` is optional by design. If the counts are unavailable (older API response,
 * a failed search, `facets=1` not requested) the plan falls back to a FIXED 6-group
 * primary set rather than to all nine — the fallback is still a reduction, just not a
 * query-aware one. The decision document flagged "if facet counts slip, the fallback is
 * a static rail" as the plan's weakest link; this is the answer to that.
 */

export type RailGroupId =
  | 'when'
  | 'dates'
  | 'timeOfDay'
  | 'ages'
  | 'areas'
  | 'quick'
  | 'courses'
  | 'costMax'
  | 'nearMe';

/** Canonical render order. The plan re-sorts into this, so the rail never reshuffles. */
export const RAIL_GROUP_ORDER: RailGroupId[] = [
  'when',
  'dates',
  'timeOfDay',
  'ages',
  'areas',
  'quick',
  'courses',
  'costMax',
  'nearMe',
];

/** How many groups the rail shows before the "More filters" disclosure. */
export const MAX_PRIMARY_GROUPS = 6;

/**
 * Always up front, regardless of counts: the geo entry point. Radius-first geography is
 * a PRD-level product decision (v1.2), not something a count should be able to demote —
 * and its counts only exist once an origin is already set, so it can never score its way
 * in on its own.
 */
const ALWAYS_PRIMARY: RailGroupId[] = ['nearMe'];

/**
 * Never promoted by scoring: the custom date range. It has no facet group (a range is not
 * a finite chip set), and it is the tallest control in the rail — a two-field form plus a
 * submit. It appears up front only when a parent has actually set a range.
 */
const NEVER_ADAPTIVE: RailGroupId[] = ['dates'];

/** Fallback ordering when there are no counts to rank by. Mirrors expected parent usage. */
const FALLBACK_PRIORITY: RailGroupId[] = ['when', 'areas', 'ages', 'quick', 'costMax', 'timeOfDay'];

/** Rail group → the facet group that scores it. `dates` has none; `nearMe` only with an origin. */
const FACET_KEY_FOR: Partial<Record<RailGroupId, string>> = {
  when: 'when',
  timeOfDay: 'timeOfDay',
  ages: 'ages',
  areas: 'areas',
  quick: 'quick',
  courses: 'registration',
  costMax: 'costMax',
  nearMe: 'radius',
};

export interface RailPlan {
  /** Rendered expanded, in RAIL_GROUP_ORDER. 5-6 groups in the normal case. */
  primary: RailGroupId[];
  /** Rendered inside the "More filters" <details>, in RAIL_GROUP_ORDER. Never dropped. */
  secondary: RailGroupId[];
  /** True when live facet counts drove the selection; false when the fixed fallback did. */
  adaptive: boolean;
}

/**
 * Groups the parent has ALREADY constrained. These are pinned to `primary` unconditionally:
 * folding an applied filter away hides the parent's own state and the control that clears it.
 */
export function pinnedGroups(state: SearchState): RailGroupId[] {
  const pinned: RailGroupId[] = [];
  if (state.when !== 'any') pinned.push('when');
  if (hasDateRange(state)) pinned.push('dates');
  if (state.timeOfDay !== 'any') pinned.push('timeOfDay');
  if (state.ages.length > 0) pinned.push('ages');
  if (state.regions.length > 0) pinned.push('areas');
  if (state.bookableNow || state.dropIn || state.rainyDay || state.free) pinned.push('quick');
  // Courses widens rather than narrows, but the pin matters MORE for it, not less: a parent who
  // opted registration content in and cannot see the control has no way to opt back out, and no
  // explanation for why 12-week programmes appeared in a "what's on today" list.
  if (state.includeRegistration) pinned.push('courses');
  if (state.costMaxCad != null) pinned.push('costMax');
  if (hasOrigin(state)) pinned.push('nearMe');
  return pinned;
}

/**
 * How many of a group's options would actually change the result set.
 *
 * An option scores when it is reachable (count > 0) AND narrowing (count < the group's
 * unconstrained total). An option returning the whole set narrows nothing; an option
 * returning nothing is a dead end. A group with no scoring options cannot partition this
 * query at all, which is exactly the group worth folding away.
 */
export function discriminationScore(group: FacetGroupCounts, facetTotal: number): number {
  // The registration group is the one group in the payload that WIDENS: its two values are
  // "drop-in only" (today's set) and "include registration courses" (a larger set). Nothing in
  // it is ever narrowing, so the generic rule below would score it zero for every query and
  // fold it away permanently. The question worth asking of it is different: is this search
  // holding any course content back? If the two counts agree, there is nothing to opt into.
  if (group.key === 'registration') {
    const dropIn = group.values.find((v) => v.value === 'dropInOnly')?.count ?? 0;
    const included = group.values.find((v) => v.value === 'includeRegistration')?.count ?? 0;
    return included > dropIn ? 1 : 0;
  }
  const any = group.values.find((v) => v.value === 'any');
  const reference = any ? any.count : facetTotal;
  let n = 0;
  for (const value of group.values) {
    if (value.value === 'any') continue;
    if (value.count > 0 && value.count < reference) n += 1;
  }
  return n;
}

/**
 * Choose the rail's primary/secondary split.
 *
 * Order of precedence, highest first:
 *   1. groups the parent has applied (never folded, no cap applies to them);
 *   2. ALWAYS_PRIMARY (the geo entry point);
 *   3. groups ranked by how well their counts partition THIS query (facets present), or
 *      the fixed FALLBACK_PRIORITY order (facets absent), until MAX_PRIMARY_GROUPS is met.
 * Everything else folds into the disclosure. Pure — no URL, no fetch, no clock.
 */
export function planRailGroups(state: SearchState, facets?: FacetCounts | null): RailPlan {
  const primary = new Set<RailGroupId>(pinnedGroups(state));
  for (const id of ALWAYS_PRIMARY) primary.add(id);

  const candidates = RAIL_GROUP_ORDER.filter((id) => !primary.has(id) && !NEVER_ADAPTIVE.includes(id));

  let ranked: RailGroupId[];
  if (facets) {
    ranked = candidates
      .map((id) => {
        const key = FACET_KEY_FOR[id];
        const group = key ? facets.groups.find((g) => g.key === key) : undefined;
        return { id, score: group ? discriminationScore(group, facets.total) : 0 };
      })
      // A group that cannot narrow this query is not worth six chips of vertical space.
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || RAIL_GROUP_ORDER.indexOf(a.id) - RAIL_GROUP_ORDER.indexOf(b.id))
      .map((entry) => entry.id);
  } else {
    ranked = FALLBACK_PRIORITY.filter((id) => candidates.includes(id));
  }

  for (const id of ranked) {
    if (primary.size >= MAX_PRIMARY_GROUPS) break;
    primary.add(id);
  }

  return {
    primary: RAIL_GROUP_ORDER.filter((id) => primary.has(id)),
    secondary: RAIL_GROUP_ORDER.filter((id) => !primary.has(id)),
    adaptive: facets != null,
  };
}
