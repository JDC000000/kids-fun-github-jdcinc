// lib/search/filters/predicate.ts — The one place a listing is tested against a selection.
//
// Extracted from SearchEngine so the facet counter (lib/search/facets.ts) can ask the
// SAME question the result list answers — "does this listing survive this selection?" —
// without re-implementing the chain. A facet count that used a second, parallel copy of
// this logic would drift the moment either side changed, and the rail would quietly start
// promising counts the results can't deliver.
//
// A "selection" is everything that narrows results: the parsed intent (SearchContext) plus
// the structured params the parser can't express (region chips, resolved origin) and the
// status class being listed (primary results vs the expected/seasonal section).

import type { ListingRecord, SearchContext } from '../types';
import type { ResolvedOrigin } from '../../geo/origin';
import { RegionHierarchy, matchesRegion } from '../../geo/region';
import { withinRadius } from '../../geo/radius';
import { matchesAge } from './age';
import { matchesTimeOfDay, matchesDate } from './time';
import { matchesCost } from './cost';
import { matchesStatus, isPrimaryResult, isExpectedSection, isHidden } from './status';
import { isAdultOrSeniorOnly } from './audience';
import { isRegistrationShaped } from './registration';

/** Which status class is being listed (TSD §5A.5). */
export type ResultMode = 'primary' | 'expected';

/** Everything currently narrowing the result set. */
export interface FilterSelection {
  ctx: SearchContext;
  /** Resolved geo origin, or null when no radius search is in play. */
  origin: ResolvedOrigin | null;
  /** Additive region-chip ids (structured `region=` param). */
  regionChipIds: string[];
  mode: ResultMode;
}

export interface FilterDeps {
  regions: RegionHierarchy;
}

/** True when a listing survives every active constraint in the selection. */
export function passesAllFilters(
  listing: ListingRecord,
  selection: FilterSelection,
  deps: FilterDeps,
): boolean {
  const { ctx, origin, regionChipIds, mode } = selection;

  if (isHidden(listing)) return false;

  // Adult-only / senior-only programming is not this product's content in any mode or section —
  // a vendor's facility calendar carries it, a children's app does not show it. Unconditional:
  // there is no view of a kids app where "Seniors Tai Chi" is the answer. Parent-and-child
  // sessions are explicitly NOT caught by this (see filters/audience.ts).
  if (isAdultOrSeniorOnly(listing)) return false;

  // Registration-required courses are opt-in and OFF by default, in both the primary list and
  // the expected section — a 12-week registered programme is no more "what's on today" for
  // being seasonal. Nothing is deleted: flipping ctx.includeRegistration brings them all back,
  // labelled, which is what keeps a misread listing reachable instead of lost.
  if (!ctx.includeRegistration && isRegistrationShaped(listing)) return false;

  if (mode === 'primary' && !isPrimaryResult(listing)) return false;
  if (mode === 'expected' && !isExpectedSection(listing)) return false;

  // Region chips (additive, hierarchical). Independent of radius.
  if (!matchesRegion([listing.municipalityId, listing.displayArea, listing.neighbourhood], deps.regions, regionChipIds)) {
    return false;
  }
  // Radius (only when we have an origin).
  if (origin && !withinRadius(origin.geo, listing.geo, ctx.radiusKm)) return false;
  // Age (orthogonal).
  if (!matchesAge(listing, ctx.ageBands)) return false;

  // COST APPLIES IN BOTH MODES, and this is the one constraint in the block below that used
  // to be here by accident rather than by argument.
  //
  // The expected section relaxes exactly the dimensions that are UNKNOWABLE for a listing that
  // has not been posted yet: its date, its time of day, and whether it is bookable/drop-in
  // right now. A `seasonal_preseason` swim session has no published schedule — that is what
  // puts it in this section — so filtering it on the parent's date would empty the section by
  // construction. Cost is not that kind of dimension. A preseason listing carries the same
  // costStatus/costMinCad the card will print, and every other non-temporal attribute (region,
  // radius, age) is already enforced in both modes for precisely this reason.
  //
  // Leaving cost out meant a known-priced $85 seasonal row was returned under `q=free` with
  // `costFree: true` and no notice — the exact substitution the chip-drop rung was narrowed to
  // prevent (see broaden.ts CHIP_RESTRICTIVENESS), arriving through the section next door.
  //
  // This does NOT narrow the section in the ordinary case: matchesCost's free branch admits
  // unknown/check_source (Jon's unknown-cost ruling, filters/cost.ts), and an unpublished price
  // is the common shape here. Only a KNOWN, non-zero price is excluded — the one thing the Free
  // filter exists to prevent.
  if (!matchesCost(listing, { free: ctx.costFree })) return false;

  if (mode === 'primary') {
    // Strict temporal + status chips for the primary list. Deliberately NOT applied to the
    // expected section: a not-yet-posted listing has no date, no time of day, and cannot be
    // `bookable_open` (that status is primary-class), so any of these would empty the section
    // rather than filter it.
    if (!matchesDate(listing, ctx.date)) return false;
    if (!matchesTimeOfDay(listing, ctx.timeOfDay, { includeAdjacent: ctx.timeOfDayAdjacent })) return false;
    if (!matchesStatus(listing, { bookableNow: ctx.bookableNow, rainyDay: ctx.rainyDay, dropIn: ctx.dropIn })) {
      return false;
    }
  }
  return true;
}

/** A selection with the given SearchContext fields overridden (never mutates the original). */
export function withContext(selection: FilterSelection, patch: Partial<SearchContext>): FilterSelection {
  return { ...selection, ctx: { ...selection.ctx, ...patch } };
}
