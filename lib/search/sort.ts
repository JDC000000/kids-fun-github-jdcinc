// lib/search/sort.ts — Deterministic alternate sorts (G-T19-3, TSD §5A.3).
//
// Five sort controls — best match / distance / soonest / lowest cost / newest —
// are deterministic orderings over the SAME filtered+scored result set, NOT separate
// searches. Every comparator has a stable id tiebreak so ordering is reproducible.
// Missing values (no distance, no date, unknown cost) sort last, never first.

import { isFree, readCost } from './filters/cost';
import type { ScoredListing } from './rank';
import type { SortKey } from './types';

const idTiebreak = (a: ScoredListing, b: ScoredListing) =>
  a.candidate.listing.id.localeCompare(b.candidate.listing.id);

/**
 * Push nulls to the end regardless of asc/desc. Returns comparator result or null if both present.
 *
 * Exported so the preview/demo shell's own client-side sort (app/preview/_data/filter.ts) orders
 * unknown distances by the SAME rule this file's header states, rather than re-deciding it — a
 * null distance that lands first (which `a.distanceKm - b.distanceKm` yields via NaN-ish
 * coercion) reads as "closest", the exact claim we have no basis for.
 */
export function nullsLast(av: number | null, bv: number | null): number | null {
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return null;
}

function soonestValue(s: ScoredListing): number | null {
  const iso = s.candidate.listing.startDatetimeUtc;
  return iso ? new Date(iso).getTime() : null; // open-hours (null start) → sorts last
}

/**
 * The cost we may order a listing at — DERIVED from `readCost()`, never restated.
 *
 * Ordering and DISPLAY must not be able to drift, so this reads the same authority every cost
 * label reads (lib/search/filters/cost.ts). It used to hand-roll its own mirror of the rule
 * (`costMinCad ?? costMaxCad ?? 0`), which ranked listings at prices no surface will print:
 * `known` with no bounds sorted FIRST at 0, `min=7/max=0` sorted at 7, and a negative bound
 * — reachable through the admin form — sorted ABOVE genuinely-free listings. `readCost()`
 * already screens negative bounds, contradictory bounds and lone zeros, so those cells fall
 * out of this delegation rather than needing a branch each.
 *
 * Anything it declines to state has no cost to order by, so it sorts last via `nullsLast` —
 * per this file's header and the sort sentence a parent reads in app/search/_lib/params.ts
 * ("free and low-cost first; unknown cost last").
 */
function lowestCostValue(s: ScoredListing): number | null {
  const cost = readCost(s.candidate.listing);
  switch (cost.kind) {
    case 'free':
      return 0;
    case 'amount':
      return cost.amount;
    case 'range':
      return cost.min; // it is the LOWEST-cost sort, and readCost has already ordered min <= max
    case 'unstated':
      return null;
    case 'group_range':
      // TYPE-REQUIRED, RUNTIME-DEAD — NOT live ordering policy, and nobody should read it as such.
      // This function is fed `readCost()`, which cannot return the group arm; only `readGroupCost()`
      // can, and that is called by the card formatter, long after this comparator has run
      // (lib/search/engine.ts collapses AFTER applySort). A collapsed card needs no ordering change
      // for the same reason: applySort orders per OCCURRENCE, so under lowest_cost a group's
      // representative ALREADY is its cheapest member and the card already lands at the group's
      // floor. The floor is still the right answer if that order ever changes, and the arm is
      // written out rather than defaulted so a sixth `CostRead` arm still fails the build here.
      return cost.min;
  }
}

function newestValue(s: ScoredListing): number | null {
  const iso = s.candidate.listing.lastCheckedAtUtc;
  return iso ? new Date(iso).getTime() : null;
}

/** Sort a scored set by the chosen control. Non-mutating. */
export function applySort(results: ScoredListing[], sort: SortKey): ScoredListing[] {
  const copy = [...results];
  switch (sort) {
    case 'best_match':
      return copy.sort((a, b) => b.score - a.score || idTiebreak(a, b));
    case 'distance':
      return copy.sort((a, b) => {
        const n = nullsLast(a.distanceKm, b.distanceKm);
        return (n ?? (a.distanceKm! - b.distanceKm!)) || idTiebreak(a, b);
      });
    case 'soonest':
      return copy.sort((a, b) => {
        const av = soonestValue(a);
        const bv = soonestValue(b);
        const n = nullsLast(av, bv);
        return (n ?? (av! - bv!)) || idTiebreak(a, b);
      });
    case 'lowest_cost':
      return copy.sort((a, b) => {
        const av = lowestCostValue(a);
        const bv = lowestCostValue(b);
        const n = nullsLast(av, bv);
        return (n ?? (av! - bv!)) || idTiebreak(a, b);
      });
    case 'newest':
      return copy.sort((a, b) => {
        const av = newestValue(a);
        const bv = newestValue(b);
        const n = nullsLast(av, bv);
        return (n ?? (bv! - av!)) || idTiebreak(a, b); // most-recent first
      });
  }
}

/**
 * Option C ("Free filter honesty fix", Jon's ruling 2026-08-17), step 2b — a stable partition,
 * NOT a filter. When a parent has the Free quick filter active, confirmed-free listings
 * (`isFree()` true) should read as the first impression of the search, not a wall of
 * "Price not confirmed" cards — but the standing ruling (lib/search/filters/cost.ts) is that
 * unpriced/unknown-cost listings are NEVER hidden from a Free search, so this function must
 * never drop, truncate or reclassify anything. It only moves confirmed-free members ahead of
 * everything else, preserving whatever order `applySort` already produced WITHIN each group.
 *
 * WHY THIS ISN'T INSIDE `applySort`'s switch. That switch dispatches on SORT KEY (best_match,
 * distance, …); this is a FILTER-STATE-aware step layered on top, applied only when the Free
 * quick filter is active, regardless of which sort key is chosen. `lowest_cost` already reads
 * free-first through `lowestCostValue`'s own derivation — this function still runs after it (the
 * caller in lib/search/engine.ts gates on `ctx.costFree`, not on `sort`), but a partition that is
 * ALREADY free-then-not-free is a no-op in every way that matters: `Array#sort`'s relative order
 * within an already-correctly-ordered set is exactly what a stable partition preserves anyway.
 *
 * WHY `isFree()`, NOT a hand-rolled distinction. `isFree()` (lib/search/filters/cost.ts) is the
 * one authority every surface — the card label, the Free filter predicate, the email digest —
 * reads for "what counts as free". A second, sort-local mirror of that rule is the exact defect
 * this codebase has already been bitten by once (see cost.ts's own header comment on the
 * "email said Free, card said check source" incident); this function has no opinion of its own.
 */
export function prioritizeConfirmedFreeWhenFreeActive(results: ScoredListing[]): ScoredListing[] {
  const free: ScoredListing[] = [];
  const rest: ScoredListing[] = [];
  for (const result of results) {
    // Under the Free filter, `matchesCost` only ever admits `isFree()` or unknown-cost listings
    // (matchesCost's own `free` branch) — so "not free" here means "unpriced/unstated", never a
    // known paid listing sneaking through. Written as `isFree() ? free : rest` rather than also
    // testing `isUnknownCost()` because the LATTER classification isn't this function's to make:
    // it partitions into "confirmed-free" and "everything else determined by the filter that ran
    // before it", and reclassifying "everything else" would be a second, needless mirror of a
    // distinction `matchesCost` already enforced.
    (isFree(result.candidate.listing) ? free : rest).push(result);
  }
  return [...free, ...rest];
}
