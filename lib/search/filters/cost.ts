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
  | { kind: 'unstated' }
  /**
   * A COLLAPSED CARD whose members do not agree on price, every one of which yields a cost we may
   * state. `min`/`max` are the GROUP's floor and ceiling — different SESSIONS at different prices,
   * already ordered min <= max.
   *
   * NO SURFACE MAY WORD THIS THE WAY IT WORDS `range`. "$103–$240" already means ONE session whose
   * own bounds span that; for a group it means one session at $103 and another at $240. Printing
   * the same string for both claims recreates the two-meanings-one-label defect this module exists
   * to close, so the wording must be visibly distinct on every surface. (Jon's ruling, 2026-08-12.)
   */
  | { kind: 'group_range'; min: number; max: number };

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

/**
 * Decide what may be said about the cost of a COLLAPSED CARD — one card standing for every
 * same-series-same-day occurrence of one activity (lib/search/collapse.ts). Pure, and it consults
 * `readCost()` per member rather than restating any part of it.
 *
 * THE DEFECT THIS CLOSES. A collapsed card printed its REPRESENTATIVE's cost as though that spoke
 * for the whole group, so a group holding a $103 session and a $240 session said "$103" and stood
 * for both. It is worst exactly where it hurts most: `applySort` runs per-OCCURRENCE BEFORE
 * `collapseSameDaySeries` (lib/search/engine.ts) and collapse keeps the first member in sorted
 * order, so under the lowest-cost sort the representative is systematically the CHEAPEST member of
 * its group — the parent who is choosing on price is the one guaranteed to be shown the lowest
 * number in a group they cannot see the rest of.
 *
 * THE RULE (Jon's ruling, 2026-08-12 — candidate D, branch (b)):
 *   • the members AGREE on what may be said → say exactly that. This is the arm that keeps a
 *     single-member card, and a group that happens to agree, byte-identical to what they printed
 *     before this function existed — the fix must not touch a card that never had the defect.
 *   • every member yields a statable cost and they DIFFER → the group's range, in its OWN arm so
 *     that no surface can word it like one session's bounds.
 *   • ANY member whose cost we cannot state → DECLINE (`unstated`). A range missing its floor or
 *     its ceiling is not a range, and declining is the same honest under-claim `readCost` already
 *     makes for contradictory bounds.
 *
 * A `free` MEMBER COUNTS AS $0 RATHER THAN BLOCKING THE RANGE, and that is deliberate. `isFree()`
 * has already ruled that session genuinely free, so 0 is a number we HOLD about it, not the lone
 * zero `readCost` refuses to print (that cell is a listing isFree() ruled NOT free, where "$0"
 * would read as free on a card the Free filter drops — it cannot reach this path). It is also the
 * value `lowestCostValue` (lib/search/sort.ts) has always ordered free at, so the aggregate and the
 * ordering cannot come to disagree about what free is worth. A group whose members are ALL free
 * still reads `free`, through the agreement rule above, and still prints each surface's free words.
 */
export function readGroupCost(slots: CostFacts[]): CostRead {
  // No members is not a group. Nothing constructs one — `collapseSameDaySeries` always seats at
  // least the representative — but declining costs nothing and is the honest answer if it ever does.
  if (slots.length === 0) return { kind: 'unstated' };

  const reads = slots.map(readCost);
  const agreed = reads[0];
  if (reads.every((read) => sameRead(read, agreed))) return agreed;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const read of reads) {
    const bounds = statableBounds(read);
    // One member we cannot price is enough to decline: the group's true floor or ceiling might sit
    // outside anything we could print, so any range we drew would be narrower than the truth.
    if (bounds == null) return { kind: 'unstated' };
    min = Math.min(min, bounds[0]);
    max = Math.max(max, bounds[1]);
  }

  // Members that disagree can still share one number (a $10 amount beside a $10–$20 range floors
  // and ceilings differently, but [$10,$10] beside [$10,$10] cannot arise here). Collapsing the
  // degenerate span to `amount` is cheaper to state than to reason about, and it keeps the group
  // arm meaning what it says: two DIFFERENT prices.
  return min === max ? { kind: 'amount', amount: min } : { kind: 'group_range', min, max };
}

/**
 * The [floor, ceiling] one member contributes to its group's span, or null when we hold no cost for
 * it and the group must therefore decline.
 */
function statableBounds(read: CostRead): [number, number] | null {
  switch (read.kind) {
    case 'free':
      return [0, 0];
    case 'amount':
      return [read.amount, read.amount];
    case 'range':
      return [read.min, read.max];
    case 'unstated':
      return null;
    case 'group_range':
      // Unreachable: collapse is one level deep, so a GROUP is never a MEMBER of another group and
      // every read here comes from `readCost`, which cannot return this arm. Handled rather than
      // defaulted so that a sixth `CostRead` arm still fails the build in this function too.
      return [read.min, read.max];
  }
}

/**
 * Two members agree when the claim we may make about them is identical — same kind AND same
 * numbers. Delegating the numbers to `statableBounds` keeps this exhaustive by construction
 * instead of re-listing the union a second time.
 */
function sameRead(a: CostRead, b: CostRead): boolean {
  if (a.kind !== b.kind) return false;
  const ab = statableBounds(a);
  const bb = statableBounds(b);
  if (ab == null || bb == null) return true; // same kind, and neither states a number
  return ab[0] === bb[0] && ab[1] === bb[1];
}
