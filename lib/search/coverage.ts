// lib/search/coverage.ts — how much of the CATALOGUE we actually hold for a selected area.
//
// THE DEFECT THIS CLOSES. The five area chips (app/search/_lib/params.ts REGION_CHIPS) are
// rendered identically and behave identically, and a parent has no way to tell that two of
// them stand for a municipality we have essentially no data for. Selecting one returns a page
// shaped exactly like a normal search that happened to match nothing — the empty state says
// "Nothing matches … right now", the broadening notice offers to widen dates and ages, the
// alternative chips offer other days. Every one of those is a true sentence about a query, and
// every one of them is the wrong answer, because the query was never the problem. An
// independent test round watched 5 of 15 parents follow that advice into a dead end.
//
// WHAT IS MEASURED, AND WHY IT IS NOT THE RESULT COUNT. "Your search matched nothing here" and
// "we have almost nothing here to match" are different facts, and the second one cannot be
// derived from a single search's result count — a zero-result Vancouver search says nothing
// about Vancouver. So this counts the AREA, not the query: distinct activities the catalogue
// currently holds inside a chip's region subtree, with no date/age/time/text constraint
// applied. That number is a property of our coverage and stays true whatever the parent typed.
//
// It is the same rule the rest of this product runs on (AGE_NOT_STATED, `originError`,
// `unparsedQuery`, server-engine returning null rather than an empty engine): "we could not
// answer" and "the answer is nothing" are different statements, and we never quietly
// substitute one for the other.
//
// SCOPE. This measures and reports. It does not filter, rank, exclude or broaden anything —
// a sparse region's listings are returned exactly as before, and a well-covered region's
// search is untouched by construction (`assessRegionCoverage` only ever runs over the chips
// the caller selected, and nothing downstream reads its result except the UI notice).

import type { ListingRecord } from './types';
import { RegionHierarchy, regionTagsOf } from '../geo/region';
import { isHidden } from './filters/status';
import { isAdultOrSeniorOnly } from './filters/audience';

/**
 * At or below this many distinct activities, an area is reported as sparsely covered.
 *
 * WHY 5, AND WHY THE EXACT NUMBER IS NOT LOAD-BEARING. The measured gap this constant sits in
 * is enormous: at the time of writing West Vancouver holds 0 and Burnaby 2, while the covered
 * municipalities hold hundreds. Any cut between "a handful" and "a page" separates the same two
 * populations, so the honest thing is to pick a number that cannot be mistaken for a real
 * answer to a parent's question and say why. Fewer than five distinct activities in an entire
 * municipality cannot answer "what can we do this weekend" for ANY realistic query — a parent
 * who filters to that area and types anything at all will land on an empty or near-empty page,
 * which is precisely the state that must not be presented as an ordinary search result.
 *
 * It is deliberately NOT a per-region allowlist of West Van and Burnaby. Naming the two
 * municipalities that happen to be thin today would go stale silently in both directions: a
 * region that gains coverage would keep apologising for itself, and a region that loses its
 * only source would go back to lying. The threshold reads the catalogue, so it follows it.
 */
export const SPARSE_REGION_MAX_ACTIVITIES = 5;

export interface RegionCoverage {
  /**
   * The chip id EXACTLY as the caller sent it, not the hierarchy's resolved id. This value goes
   * back out to the UI, which uses it to build links and to key the notify-me capture, and the
   * UI's vocabulary is the URL slug ('bby'), never the database UUID the hierarchy may key on
   * (see RegionHierarchy.resolveChipId for why those are two different vocabularies).
   */
  chipId: string;
  /** The region's real name as the hierarchy carries it ("West Vancouver"), for display. */
  regionName: string;
  /**
   * Distinct activities (`seriesId`) the catalogue currently holds in this region's subtree,
   * ignoring every query constraint.
   *
   * SERIES, not occurrences: one weekly drop-in swim that publishes twelve occurrences is one
   * activity a parent can go to, and counting it as twelve would report a municipality with a
   * single programme in it as comfortably covered.
   */
  activityCount: number;
  /** `activityCount <= SPARSE_REGION_MAX_ACTIVITIES` — see that constant for the argument. */
  sparse: boolean;
}

/**
 * Catalogue coverage for each area chip in `chipIds`, in the order given.
 *
 * A chip this hierarchy does not recognise is OMITTED, never reported as zero coverage. That
 * mirrors `matchesRegion`, which ignores an unreadable chip rather than treating it as "match
 * nothing", and it matters for the same reason: a typo, a stale shared link or a renamed
 * municipality would otherwise make the page announce that we have no data for an area we may
 * cover perfectly well — a data-shaped answer to a "we could not read that filter" problem.
 *
 * Listings a parent could never be shown in any search — hidden statuses and adult/senior-only
 * programming, both unconditional exclusions in filters/predicate.ts — are not counted, because
 * coverage has to mean "activities that could appear", not "rows we happen to store".
 *
 * Cost: ONE pass over the catalogue regardless of how many chips are selected, and callers only
 * pay it when a chip is selected at all (see SearchEngine.search). The loop is nested this way
 * round — listings outside, chips inside — deliberately: `isAdultOrSeniorOnly` runs regexes over
 * a listing's title and age notes, and a chip-outer loop would re-run all of them once per chip
 * over the entire catalogue. The inner loop is at most the five area chips.
 */
export function assessRegionCoverage(
  listings: readonly ListingRecord[],
  regions: RegionHierarchy,
  chipIds: readonly string[],
): RegionCoverage[] {
  const selected = chipIds
    .map((chipId) => ({ chipId, resolved: regions.resolveChipId(chipId) }))
    .filter((c): c is { chipId: string; resolved: string } => c.resolved != null)
    .map((c) => ({ ...c, allowed: new Set(regions.descendantIds(c.resolved)), series: new Set<string>() }));
  if (selected.length === 0) return [];

  for (const listing of listings) {
    if (isHidden(listing) || isAdultOrSeniorOnly(listing)) continue;
    const tags = regionTagsOf(listing);
    for (const chip of selected) {
      if (tags.some((tag) => tag != null && chip.allowed.has(tag))) chip.series.add(listing.seriesId);
    }
  }

  return selected.map((chip) => ({
    chipId: chip.chipId,
    regionName: regions.get(chip.resolved)?.name ?? chip.chipId,
    activityCount: chip.series.size,
    sparse: chip.series.size <= SPARSE_REGION_MAX_ACTIVITIES,
  }));
}
