// lib/search/filters/cost.ts — Cost filter semantics (G-T16-5, FR-10/BR-11, TSD §5A.4).
//
// Filter against cost_status / cost_min_cad / cost_max_cad. Unknown & check_source
// are NEVER treated as free. When the user asks for "free" they get truly-free
// listings only; an explicit include-unknown flag surfaces unknown/check-source
// listings so useful entries aren't silently hidden because a source omitted price.

import type { ListingRecord } from '../types';

export interface CostFilter {
  /** User asked for free-only. */
  free: boolean;
  /** Explicitly include unknown / check-source cost listings (FR-10). */
  includeUnknown: boolean;
  /** Optional max price ceiling in CAD (P1 cost range). */
  maxCad?: number | null;
}

/** True when a listing's cost is unknown at source. */
export function isUnknownCost(listing: ListingRecord): boolean {
  return listing.costStatus === 'unknown' || listing.costStatus === 'check_source';
}

/** True when a listing is genuinely free (never inferred from unknown). */
export function isFree(listing: ListingRecord): boolean {
  if (listing.costStatus === 'free') return true;
  // A known cost of exactly 0 is free.
  return listing.costStatus === 'known' && listing.costMaxCad === 0 && (listing.costMinCad ?? 0) === 0;
}

/** Apply cost predicate to a single listing. */
export function matchesCost(listing: ListingRecord, filter: CostFilter): boolean {
  const unknown = isUnknownCost(listing);

  if (filter.free) {
    if (isFree(listing)) return true;
    // Unknown is never free; only surfaced when includeUnknown is set.
    return unknown && filter.includeUnknown;
  }

  // No free constraint. Hide unknown/check-source unless explicitly included.
  if (unknown && !filter.includeUnknown) return false;

  if (filter.maxCad != null && listing.costStatus === 'known') {
    const min = listing.costMinCad ?? listing.costMaxCad ?? 0;
    if (min > filter.maxCad) return false;
  }
  return true;
}
