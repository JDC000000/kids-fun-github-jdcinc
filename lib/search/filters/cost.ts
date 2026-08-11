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

import type { CostStatus, ListingRecord } from '../types';

export interface CostFilter {
  /** User asked for free-only. The only cost constraint that exists. */
  free: boolean;
}

/**
 * The three fields every cost decision in the product is made from.
 *
 * Structural rather than `ListingRecord` so the surfaces holding a NARROWER shape can ask this
 * module instead of hand-rolling a second copy of the rule: the preview `Activity` carries the
 * same three fields with the bounds OPTIONAL (`costMinCad?: number`) rather than nullable. Every
 * reader below goes through `?? 0` or `!= null`, which treat `undefined` and `null` identically,
 * so accepting the wider type cannot change an answer `isFree` already gives.
 */
export interface CostFacts {
  costStatus: CostStatus;
  costMinCad?: number | null;
  costMaxCad?: number | null;
}

/** True when a listing's cost is unknown at source. */
export function isUnknownCost(listing: ListingRecord): boolean {
  return listing.costStatus === 'unknown' || listing.costStatus === 'check_source';
}

/**
 * True when a listing is genuinely free (never inferred from unknown). THE authority on the
 * word "free" — the Free quick filter and every cost label a parent reads derive from this one
 * function (see `readCost` below) rather than restating it.
 *
 * THE RULE IS ASYMMETRIC, AND THE ASYMMETRY IS LOAD-BEARING. The MAXIMUM must be exactly 0; the
 * minimum may be 0 **or absent**. So `known/min=null/max=0` IS free (we hold a ceiling of zero,
 * and nothing can cost less than nothing) while `known/min=0/max=null` is NOT (a floor of zero
 * says the cheapest option is free, not that every option is). Anyone paraphrasing this as
 * "both bounds at zero" gets the first of those cells wrong — a comment in the card formatter
 * said exactly that for a sprint, its two worked examples happened to agree with it, and the
 * cell it mis-states was never enumerated. State it as the asymmetry or call the function.
 */
export function isFree(listing: CostFacts): boolean {
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

// ─────────────────────────────────────────────────────────────────────────────
// WHAT WE MAY HONESTLY SAY ABOUT A COST — the one derivation of isFree() that every
// user-facing surface reads.
//
// WHY THIS EXISTS AT ALL. The card (app/preview/_data/format.ts) and the weekly digest
// (lib/email/format.ts) each used to hand-roll their own mirror of the rule above, and each got
// it right exactly where the other got it wrong. All rows below are cost_status = 'known':
//   • min=null max=0 — isFree TRUE (Free filter INCLUDES it). The email said "Free"; the CARD
//     said "Cost — check source", i.e. the tile denied a price the filter had already claimed.
//   • min=0 max=null — isFree FALSE (Free filter EXCLUDES it). The card said "check source";
//     the EMAIL said "Free" — a promise of free, in the one channel we cannot take back, for a
//     listing that vanishes the moment the parent ticks Free.
//   • min=7 max=0 — both surfaces printed "$7–$0". Nothing in the stack validates min <= max.
// Two independent mirrors of one rule is the defect; patching each mirror would only reset the
// clock on it. There is now ONE derivation, and it calls isFree() rather than restating it.
//
// THE INVARIANT, enforced by construction here and pinned by tests/cost-honesty-matrix.test.tsx:
//   1. If a surface renders "Free", isFree() is true for that listing.
//   2. If isFree() is true, no surface renders a cost-unknown label.
//   3. No surface prints a number it was not given, or a contradictory one.
// Surfaces choose their own WORDS (the card's one not-a-number read, the digest's three) — they
// do not choose the CLAIM.
// ─────────────────────────────────────────────────────────────────────────────

/** The claim a surface is permitted to make about a listing's cost. */
export type CostRead =
  /** isFree() said so. Every surface must use its free wording; none may hedge. */
  | { kind: 'free' }
  /** Exactly one number we were actually given, and it is safe to print. */
  | { kind: 'amount'; amount: number }
  /** Two numbers we were actually given, already ordered min <= max. */
  | { kind: 'range'; min: number; max: number }
  /** We hold no cost we can state. Each surface picks its own words from `costStatus`. */
  | { kind: 'unstated' };

/**
 * A number is printable only if it is finite and not negative. Postgres holds both bounds as
 * nullable numerics with NO check constraint (supabase/migrations/0004_activities.sql), and the
 * admin form validates each bound independently as "any finite number" (app/admin/listings/_lib/
 * vocab.ts) — so a negative bound is reachable through supported UI, and "$-5" is not a cost.
 */
function isPrintableAmount(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/**
 * Decide what may be said about a listing's cost. Pure; `isFree()` is consulted, never restated.
 *
 * `cost_status = 'known'` does NOT guarantee a usable number — the DTO, the postgres read model
 * and the admin listing form all permit known with null bounds — so a status of known still has
 * to earn its number here. A fabricated price is the single worst thing we can say to a parent,
 * because it is the one reading they act on.
 */
export function readCost(cost: CostFacts): CostRead {
  // The authority answers first, so no surface can disagree with the Free filter.
  if (isFree(cost)) return { kind: 'free' };
  if (cost.costStatus !== 'known') return { kind: 'unstated' };

  const min = cost.costMinCad ?? null;
  const max = cost.costMaxCad ?? null;

  if (min != null && max != null) {
    // CONTRADICTORY BOUNDS ARE AN HONEST UNDER-CLAIM, NOT A PRINTED NONSENSE RANGE. "$7–$0"
    // states two mutually exclusive prices; a parent cannot act on it and cannot tell which
    // half is the typo. Saying we do not have the cost is the only claim that is true.
    if (!isPrintableAmount(min) || !isPrintableAmount(max) || min > max) return { kind: 'unstated' };
    return min === max ? { kind: 'amount', amount: min } : { kind: 'range', min, max };
  }

  // Exactly one bound, or none. A LONE ZERO IS NOT A PRICE WE CAN STATE: isFree() has already
  // ruled this listing not-free, so "$0" would read as free on a card the Free filter drops.
  const only = min ?? max;
  if (only == null || only === 0 || !isPrintableAmount(only)) return { kind: 'unstated' };
  return { kind: 'amount', amount: only };
}
