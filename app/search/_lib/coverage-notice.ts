// app/search/_lib/coverage-notice.ts — "we barely cover this area" vs "your search matched
// nothing".
//
// THE DEFECT THIS CLOSES. Two of the five area chips stand for municipalities the catalogue
// holds effectively nothing for (0 and 2 activities at the time of writing), and /search
// rendered them exactly like the three it covers well: the same empty state ("Nothing matches …
// right now"), the same offer to widen dates and ages, the same alternative-day chips. Every one
// of those is a true sentence about a QUERY, and every one of them is the wrong answer, because
// the query was never what emptied the page. An independent test round watched 5 of 15 parents
// take that advice and arrive nowhere.
//
// WHAT MAY AND MAY NOT BE SAID. The number below is a real measurement over the whole catalogue
// (lib/search/coverage.ts) with no query constraint applied, so it is a statement about our
// COVERAGE and stays true whatever the parent typed. Nothing here claims the area is quiet, that
// nothing is happening there, or that coverage is about to change — we do not know any of those.
// The only forward-looking thing on this notice is the parent's own request to be told, which is
// why the capture form is part of the honest state rather than a promotion attached to it.
//
// Sibling of _lib/day-remainder-notice.ts and _lib/broadening-notice.ts: a pure derivation the
// page renders, so the wording is unit-testable without a request, a database or a browser.

import type { RegionCoverage } from '@/lib/search/coverage';
import { joinPhrases } from './broadening-notice';

export interface SparseCoverageNotice {
  /** Short bold opener — the fact, stated first. */
  lede: string;
  /** The measurement, and the limit of what it means. */
  body: string;
  /**
   * Every sparsely-covered area currently selected — what the capture form signs up for.
   *
   * A list rather than one region because the area chips are multi-select: a parent may have
   * both thin municipalities on at once, and picking one of them to name (or to sign up for)
   * would silently drop the other. Always non-empty when a notice is returned.
   */
  regions: { chipId: string; regionName: string }[];
}

/**
 * Describe the sparsely-covered areas in a search's selection, or null when there is nothing
 * worth saying.
 *
 * Null is the ordinary case and means render nothing — no area chip selected, or every selected
 * area is one we genuinely cover. A well-covered search must be untouched by this feature, and
 * this early return is where that is guaranteed.
 */
export function describeSparseCoverage(
  coverage: RegionCoverage[] | null | undefined,
): SparseCoverageNotice | null {
  const sparse = (coverage ?? []).filter((c) => c.sparse);
  if (sparse.length === 0) return null;

  const names = sparse.map((c) => c.regionName);
  const regions = sparse.map((c) => ({ chipId: c.chipId, regionName: c.regionName }));
  const lede = `Limited coverage in ${joinPhrases(names)}.`;

  // Several thin areas at once: the counts differ per area and adding them up would invent a
  // number that describes no place a parent can go, so this states the shape and not a total.
  if (sparse.length > 1) {
    return {
      lede,
      body: `We hold very little for ${joinPhrases(names)} so far — a gap in our coverage rather than a quiet week. Widening this search will not uncover much more there.`,
      regions,
    };
  }

  const only = sparse[0];
  // Zero is the one case where "changing your search cannot help" is provably true rather than
  // merely likely: there is nothing in the area for any query to find.
  const body =
    only.activityCount === 0
      ? `We have nothing listed in ${only.regionName} yet. That is a gap in our coverage, not a quiet week — no change to this search can find something we do not hold.`
      : `We hold just ${only.activityCount} ${only.activityCount === 1 ? 'activity' : 'activities'} in ${only.regionName} in total, across every date and age. That is a gap in our coverage rather than a quiet week, so widening this search will not uncover much more.`;

  return { lede, body, regions };
}
