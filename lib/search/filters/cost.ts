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
//
// THE MAX-PRICE CEILING IS GONE TOO, AND FOR THE SAME REASON IT IS GONE RATHER THAN UNREACHED
// (Jon's ruling, 2026-08-11: "remove the price ceiling from search, full stop — it can be found
// on the original source site").
//
// The beta round removed the ceiling's URL path and left the free-text path ("under $20") live.
// That asymmetry is the defect this change ends, so the removal is made where it cannot be half
// applied: `SearchContext.costMaxCad` no longer exists, so nothing in the product can compute a
// ceiling to hand this function. The obvious alternative — keep `maxCad` here as an unreachable
// parameter — was considered and REJECTED. An unreachable branch is a read surface: it reads as
// "ceilings work, something just isn't setting one", which is exactly the belief that has to be
// wrong for this removal to hold. The sibling `includeUnknown` removal above already settled
// this question for this file ("expressed as the ABSENCE of a switch, it cannot be got wrong"),
// and the same answer applies here.
//
// WHAT SURVIVES, DELIBERATELY: the `free` filter. Jon removed the price CEILING, not the Free
// quick filter, and "free" is a parent stating a category of thing they want rather than a
// control silently managing what they are allowed to see. Do not fold the two together.

import type { ListingRecord } from '../types';

export interface CostFilter {
  /** User asked for free-only. The only cost constraint that exists. */
  free: boolean;
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

  // No free constraint. Nothing about a listing's PRICE can exclude it any more: an
  // unknown/check-source price was never a reason to drop a listing, and since the ceiling was
  // removed a known price is not one either. A parent who wants to know what something costs
  // reads it on the card or on the source site; they do not have results withheld over it.
  return true;
}
