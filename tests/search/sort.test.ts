// tests/search/sort.test.ts — Deterministic alternate sorts over one filtered set (G-T19-3).

import { describe, it, expect } from 'vitest';
import { applySort } from '../../lib/search/sort';
import { readCost } from '../../lib/search/filters/cost';
import type { ScoredListing } from '../../lib/search/rank';
import { makeListing } from '../../lib/search/__fixtures__/factory';

function scored(over: Partial<Parameters<typeof makeListing>[0]>, score: number, distanceKm: number | null): ScoredListing {
  return {
    candidate: { listing: makeListing(over), relevance: 1, matchedTerms: [], categoryHit: false },
    score,
    distanceKm,
    components: {
      tsRank: 0, ageMatch: 0, dateProximity: 0, distanceDecay: 0,
      statusConfidenceBoost: 0, suitabilityMatch: 0, recency: 0,
    },
  };
}

const set: ScoredListing[] = [
  scored({ id: 'a', costStatus: 'known', costMinCad: 10, startDatetimeUtc: '2026-07-15T00:00:00Z', lastCheckedAtUtc: '2026-07-10T00:00:00Z' }, 0.9, 8),
  scored({ id: 'b', costStatus: 'free', startDatetimeUtc: '2026-07-13T00:00:00Z', lastCheckedAtUtc: '2026-07-12T00:00:00Z' }, 0.5, 2),
  scored({ id: 'c', costStatus: 'known', costMinCad: 5, startDatetimeUtc: '2026-07-14T00:00:00Z', lastCheckedAtUtc: '2026-07-11T00:00:00Z' }, 0.7, 5),
];

const ids = (r: ScoredListing[]) => r.map((x) => x.candidate.listing.id);

describe('applySort — deterministic orderings over the SAME set', () => {
  it('best_match sorts by descending score', () => {
    expect(ids(applySort(set, 'best_match'))).toEqual(['a', 'c', 'b']);
  });
  it('distance sorts nearest first', () => {
    expect(ids(applySort(set, 'distance'))).toEqual(['b', 'c', 'a']);
  });
  it('soonest sorts by earliest start', () => {
    expect(ids(applySort(set, 'soonest'))).toEqual(['b', 'c', 'a']);
  });
  // NO-REGRESSION CONTROL for the readCost() derivation below: free=0, then $5, then $10.
  it('lowest_cost sorts free/cheapest first', () => {
    expect(ids(applySort(set, 'lowest_cost'))).toEqual(['b', 'c', 'a']);
  });
  it('newest sorts most-recently-checked first', () => {
    expect(ids(applySort(set, 'newest'))).toEqual(['b', 'c', 'a']);
  });
  it('does not mutate the input array', () => {
    const before = ids(set);
    applySort(set, 'distance');
    expect(ids(set)).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lowest_cost ORDERING DERIVES FROM readCost(), THE SHARED COST AUTHORITY
//
// Ordering used to hand-roll its own mirror of the cost rule
// (`costMinCad ?? costMaxCad ?? 0`), so a listing could be RANKED at a price its own tile
// refuses to print — the same display/ordering split lib/search/filters/cost.ts exists to
// close. `cost_status = 'known'` does not guarantee a usable number, and every cell where
// readCost() declines to state one must sort LAST, per this module's header ("Missing values
// ... sort last, never first") and the parent-facing sort sentence in app/search/_lib/params.ts
// ("free and low-cost first; unknown cost last").
//
// Ids carry a two-digit prefix equal to the expected final POSITION. The prefix only ever
// settles a tie between listings of EQUAL cost (idTiebreak); cost is still the primary key, so
// any cell that resolves to the wrong value moves position and fails these assertions.
// ─────────────────────────────────────────────────────────────────────────────

/** Deliberately NOT in sorted order — see the anti-vacuity control below. */
const costCells: ScoredListing[] = [
  // A negative bound is reachable through supported admin UI (app/admin/listings/_lib/vocab.ts
  // validates each bound independently as "any finite number"). It is not a cost.
  scored({ id: '07-known-min-negative', costStatus: 'known', costMinCad: -5, costMaxCad: null }, 0, null),
  scored({ id: '04-known-amount-10', costStatus: 'known', costMinCad: 10, costMaxCad: null }, 0, null),
  scored({ id: '09-status-unknown', costStatus: 'unknown' }, 0, null),
  // max exactly 0 with an ABSENT min IS free (the load-bearing asymmetry in isFree).
  scored({ id: '02-known-max-zero-is-free', costStatus: 'known', costMinCad: null, costMaxCad: 0 }, 0, null),
  // Nothing in the stack constrains min <= max; "$7–$0" is two mutually exclusive prices.
  scored({ id: '06-known-min-7-max-0', costStatus: 'known', costMinCad: 7, costMaxCad: 0 }, 0, null),
  scored({ id: '01-status-free', costStatus: 'free' }, 0, null),
  scored({ id: '10-status-check-source', costStatus: 'check_source' }, 0, null),
  // A FLOOR of zero says the cheapest option is free, not that every option is: not free, and
  // no amount we can state — so no cost we can order it at either.
  scored({ id: '08-known-min-zero', costStatus: 'known', costMinCad: 0, costMaxCad: null }, 0, null),
  scored({ id: '03-known-range-5-20', costStatus: 'known', costMinCad: 5, costMaxCad: 20 }, 0, null),
  // 'known' with no bounds at all: permitted by the DTO, the read model and the admin form.
  scored({ id: '05-known-both-null', costStatus: 'known', costMinCad: null, costMaxCad: null }, 0, null),
];

const expectedCostOrder = [
  '01-status-free', //            free           -> 0
  '02-known-max-zero-is-free', // free           -> 0
  '03-known-range-5-20', //       range          -> min, 5
  '04-known-amount-10', //        amount         -> 10
  '05-known-both-null', //        unstated       -> last
  '06-known-min-7-max-0', //      unstated (min > max)
  '07-known-min-negative', //     unstated (negative bound)
  '08-known-min-zero', //         unstated (lone zero)
  '09-status-unknown', //         unstated
  '10-status-check-source', //    unstated
];

/**
 * The cell under test alongside one genuinely-free and one $10 listing. All three costs are
 * DISTINCT, so the expected order never depends on the id tiebreak or on locale collation.
 */
function trioWith(cell: Partial<Parameters<typeof makeListing>[0]> & { id: string }): string[] {
  return ids(
    applySort(
      [
        scored({ id: 'ctl-ten', costStatus: 'known', costMinCad: 10 }, 0, null),
        scored(cell, 0, null),
        scored({ id: 'ctl-free', costStatus: 'free' }, 0, null),
      ],
      'lowest_cost',
    ),
  );
}

describe('applySort lowest_cost — ordering reads the same cost predicate as display', () => {
  it('orders every cell of the cost table by the shared predicate', () => {
    expect(ids(applySort(costCells, 'lowest_cost'))).toEqual(expectedCostOrder);
  });

  it('anti-vacuity: the fixture is not already sorted, so a comparator that never ran would fail', () => {
    expect(ids(costCells)).not.toEqual(expectedCostOrder);
    expect(ids(applySort(costCells, 'lowest_cost'))).toEqual(expectedCostOrder);
  });

  it('never orders a listing at a cost the shared predicate refuses to state', () => {
    const sorted = applySort(costCells, 'lowest_cost');
    const stated = sorted.filter((s) => readCost(s.candidate.listing).kind !== 'unstated');
    const unstated = sorted.filter((s) => readCost(s.candidate.listing).kind === 'unstated');
    // The stated block is contiguous and comes FIRST; nothing unstated is interleaved into it.
    expect(ids(sorted)).toEqual([...ids(stated), ...ids(unstated)]);
    expect(stated).toHaveLength(4);
    expect(unstated).toHaveLength(6);
  });

  // ── cells that already ordered correctly and must not regress ────────────────────
  it('a single known bound orders at that amount', () => {
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: 10, costMaxCad: null })).toEqual([
      'ctl-free',
      'cell', // tie with ctl-ten at 10; 'cell' < 'ctl-ten'
      'ctl-ten',
    ]);
  });

  it('a known RANGE orders at its minimum', () => {
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: 5, costMaxCad: 20 })).toEqual([
      'ctl-free',
      'cell',
      'ctl-ten',
    ]);
  });

  it('known with max exactly 0 and no min orders as FREE (must not regress)', () => {
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: null, costMaxCad: 0 })).toEqual([
      'cell', // tie with ctl-free at 0; 'cell' < 'ctl-free'
      'ctl-free',
      'ctl-ten',
    ]);
  });

  // ── cells that used to order at a price no surface would print ───────────────────
  const sortsLast = ['ctl-free', 'ctl-ten', 'cell'];

  it('known with NO bounds sorts last, not first', () => {
    // Pre-fix: `?? ?? 0` ranked it at 0 — the top of the Lowest cost list.
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: null, costMaxCad: null })).toEqual(sortsLast);
  });

  it('known with contradictory bounds (min > max) sorts last, not at its min', () => {
    // Pre-fix: ranked at 7 — asserting a price the tile refuses to print.
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: 7, costMaxCad: 0 })).toEqual(sortsLast);
  });

  it('known with a NEGATIVE bound sorts last, not above genuinely-free listings', () => {
    // Pre-fix: ranked at -5, i.e. the top slot of the whole list, ahead of actual free.
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: -5, costMaxCad: null })).toEqual(sortsLast);
  });

  it('known with a lone zero FLOOR sorts last, not as free', () => {
    // Pre-fix: ranked at 0 while every surface prints "cost unknown".
    expect(trioWith({ id: 'cell', costStatus: 'known', costMinCad: 0, costMaxCad: null })).toEqual(sortsLast);
  });

  it('unknown and check_source sort last', () => {
    expect(trioWith({ id: 'cell', costStatus: 'unknown' })).toEqual(sortsLast);
    expect(trioWith({ id: 'cell', costStatus: 'check_source' })).toEqual(sortsLast);
  });
});
