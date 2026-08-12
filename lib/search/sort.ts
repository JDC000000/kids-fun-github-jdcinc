// lib/search/sort.ts — Deterministic alternate sorts (G-T19-3, TSD §5A.3).
//
// Five sort controls — best match / distance / soonest / lowest cost / newest —
// are deterministic orderings over the SAME filtered+scored result set, NOT separate
// searches. Every comparator has a stable id tiebreak so ordering is reproducible.
// Missing values (no distance, no date, unknown cost) sort last, never first.

import { readCost } from './filters/cost';
import type { ScoredListing } from './rank';
import type { SortKey } from './types';

const idTiebreak = (a: ScoredListing, b: ScoredListing) =>
  a.candidate.listing.id.localeCompare(b.candidate.listing.id);

/** Push nulls to the end regardless of asc/desc. Returns comparator result or null if both present. */
function nullsLast(av: number | null, bv: number | null): number | null {
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
