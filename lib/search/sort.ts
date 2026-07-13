// lib/search/sort.ts — Deterministic alternate sorts (G-T19-3, TSD §5A.3).
//
// Five sort controls — best match / distance / soonest / lowest cost / newest —
// are deterministic orderings over the SAME filtered+scored result set, NOT separate
// searches. Every comparator has a stable id tiebreak so ordering is reproducible.
// Missing values (no distance, no date, unknown cost) sort last, never first.

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

function lowestCostValue(s: ScoredListing): number | null {
  const l = s.candidate.listing;
  if (l.costStatus === 'free') return 0;
  if (l.costStatus === 'known') return l.costMinCad ?? l.costMaxCad ?? 0;
  return null; // unknown/check_source → sorts last
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
