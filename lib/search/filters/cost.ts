// lib/search/filters/cost.ts — Cost filter semantics (G-T16-5, FR-10/BR-11, TSD §5A.4).
//
// Filter against cost_status / cost_min_cad / cost_max_cad. Unknown & check_source
// are NEVER treated as free — that distinction is about HONESTY (we do not claim a
// price we do not have) and it survives untouched below.
//
// WHAT CHANGED, AND WHY THERE IS NO LONGER A FLAG (Jon's beta feedback)
// Unknown/check-source listings used to be HIDDEN unless an `includeUnknown` flag was set.
// That flag was a parent-facing toggle ("Include unknown cost") plus an `includeUnknownCost`
// query param, and it is now gone: a listing is never suppressed for the sole reason that its
// source omitted a price. A source failing to publish a number is our data problem, not
// something a parent should have to opt out of.
//
// THE FLAG IS DELETED, NOT DEFAULTED TO TRUE, AND THAT IS DELIBERATE. Its two readers disagreed
// about what an ABSENT value meant — the /search state layer defaulted it ON, the /api/search
// route defaulted it OFF — so "always include" expressed as a default would have been one more
// thing for two layers to disagree about. Expressed as the ABSENCE of a switch, it cannot be
// got wrong: there is no parameter, no default, and no caller that can turn suppression back on.
// If you are about to reintroduce an inclusion flag here, read the note in
// app/search/_lib/params.ts first.

import type { ListingRecord } from '../types';

export interface CostFilter {
  /** User asked for free-only. */
  free: boolean;
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
    // Unknown is never FREE (we do not claim a price we do not have) — but it is not hidden
    // either. A parent filtering for free sees it, labelled honestly as unknown-cost, rather
    // than having it silently withheld on the chance that it might cost something.
    return unknown;
  }

  // No free constraint. An unknown/check-source price is NEVER a reason to drop a listing.
  if (unknown) return true;

  // A price ceiling can only ever apply to a listing whose price we actually know. Reaching
  // here means cost is known, so an unknown-cost listing can never be excluded by `maxCad`.
  if (filter.maxCad != null && listing.costStatus === 'known') {
    const min = listing.costMinCad ?? listing.costMaxCad ?? 0;
    if (min > filter.maxCad) return false;
  }
  return true;
}
