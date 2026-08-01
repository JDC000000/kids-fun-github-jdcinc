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

  if (mode === 'primary') {
    // Strict temporal + cost + status chips for the primary list.
    if (!matchesDate(listing, ctx.date)) return false;
    if (!matchesTimeOfDay(listing, ctx.timeOfDay)) return false;
    if (!matchesCost(listing, { free: ctx.costFree, includeUnknown: ctx.includeUnknownCost, maxCad: ctx.costMaxCad })) {
      return false;
    }
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
