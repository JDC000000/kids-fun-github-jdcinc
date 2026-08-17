// tests/search/free-sort-does-not-hide-unstated.test.ts
//
// PIN FOR OPTION C STEP 2b ("Free filter honesty fix", Jon's ruling 2026-08-17), required by
// section 3 of the brief: the sort-ordering change that puts confirmed-free listings ahead of
// unpriced ones under the Free quick filter must be provably an ORDERING change and nothing
// else. The standing ruling this whole unit exists to protect (lib/search/filters/cost.ts) is
// that unpriced/unknown-cost listings are NEVER hidden from a Free search — the sharpest way an
// implementer under time pressure could accidentally regress that, while still shipping
// "genuinely-free reads first", is to truncate or filter the unstated tail instead of merely
// reordering it. This file is the guard against exactly that.
//
// Two layers, on purpose:
//   (A) UNIT — prioritizeConfirmedFreeWhenFreeActive() in isolation. Cheap, and it is the one
//       place that could silently start dropping/filtering instead of partitioning.
//   (B) INTEGRATION — through the real SearchEngine, end to end. A unit test of the sort step
//       alone would not catch a caller that applies it in the wrong place, or forgets to gate it
//       on `ctx.costFree` — this project has been burned before by a pure-function test passing
//       while the real pipeline never wired the change in (see the brief's own citation of
//       "Trap E / page-level rendering gates").
//
// Both layers are NON-VACUOUS by construction: the fixtures are built so the unstated-cost item
// has the HIGHER raw rank score, so if the reordering step were a no-op (or were never called),
// the unstated item would sort FIRST under best_match. A pin that used a fixture where free
// already happened to score higher would prove nothing — see tests/search/sort.test.ts's own
// "anti-vacuity" convention, followed here.

import { describe, it, expect } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { prioritizeConfirmedFreeWhenFreeActive } from '../../lib/search/sort';
import type { ScoredListing } from '../../lib/search/rank';

// ─────────────────────────────────────────────────────────────────────────────
// (A) UNIT — prioritizeConfirmedFreeWhenFreeActive
// ─────────────────────────────────────────────────────────────────────────────

function scored(id: string, over: Parameters<typeof makeListing>[0]): ScoredListing {
  return {
    candidate: { listing: makeListing({ id, ...over }), relevance: 1, matchedTerms: [], categoryHit: false },
    score: 0,
    distanceKm: null,
    components: {
      tsRank: 0, ageMatch: 0, dateProximity: 0, distanceDecay: 0,
      statusConfidenceBoost: 0, suitabilityMatch: 0, recency: 0,
    },
  };
}

describe('prioritizeConfirmedFreeWhenFreeActive — a stable partition, never a filter', () => {
  // Deliberately interleaved and deliberately NOT in the expected output order, so a
  // pass-through implementation (or one that merely preserves input order) fails visibly.
  const input: ScoredListing[] = [
    scored('u1', { costStatus: 'unknown' }),
    scored('f1', { costStatus: 'free' }),
    scored('u2', { costStatus: 'check_source' }),
    scored('f2', { costStatus: 'known', costMinCad: null, costMaxCad: 0 }), // isFree() true (§ cost.ts asymmetry)
    scored('u3', { costStatus: 'unknown' }),
  ];
  const ids = (rs: ScoredListing[]) => rs.map((r) => r.candidate.listing.id);

  it('drops nothing: same ids, same length, before and after', () => {
    const out = prioritizeConfirmedFreeWhenFreeActive(input);
    expect(out).toHaveLength(input.length);
    expect(new Set(ids(out))).toEqual(new Set(ids(input)));
  });

  it('every confirmed-free member sorts ahead of every unstated member', () => {
    const out = prioritizeConfirmedFreeWhenFreeActive(input);
    expect(ids(out)).toEqual(['f1', 'f2', 'u1', 'u2', 'u3']);
  });

  it('anti-vacuity: the input is not already in that order', () => {
    expect(ids(input)).not.toEqual(['f1', 'f2', 'u1', 'u2', 'u3']);
  });

  it('preserves relative order WITHIN each group (stable, not re-sorted by anything else)', () => {
    // Reverse the free members' relative order in the input and confirm the reversal survives —
    // proves this is a stable partition on top of whatever ordering fed it, not a fresh sort.
    const reordered: ScoredListing[] = [
      scored('u1', { costStatus: 'unknown' }),
      scored('f2', { costStatus: 'free' }),
      scored('f1', { costStatus: 'free' }),
      scored('u2', { costStatus: 'unknown' }),
    ];
    expect(ids(prioritizeConfirmedFreeWhenFreeActive(reordered))).toEqual(['f2', 'f1', 'u1', 'u2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) INTEGRATION — through the real SearchEngine (engine.ts gates on ctx.costFree)
// ─────────────────────────────────────────────────────────────────────────────

/** Same construction pattern as tests/search/broaden-never-drops-free.test.ts's thinCatalogueEngine. */
function customEngine(listings: Parameters<typeof makeListing>[0][]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings.map((l) => makeListing(l))),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
  });
}

// Same start/end time on BOTH listings — isolates the engineered score gap to status +
// confidence + recency, and sidesteps any date-proximity/date-filter interaction entirely.
const SHARED_WHEN = {
  startDatetimeUtc: '2026-07-13T20:00:00Z',
  endDatetimeUtc: '2026-07-13T21:00:00Z',
};

/** Engineered to score HIGH under best_match (§5A.3): bookable, official+recent, freshly checked. */
const UNSTATED_HIGH_SCORE = {
  id: 'oc-unstated-high',
  activityName: 'Community Yoga Session',
  primaryCategoryKey: 'yoga',
  costStatus: 'unknown' as const,
  statusState: 'bookable_open' as const,
  confidenceLabel: 'official_recent' as const,
  lastCheckedAtUtc: '2026-07-13T18:00:00Z', // 1h before FIXTURE_NOW — maximally fresh
  ...SHARED_WHEN,
};

/** Engineered to score LOW: stale status, stale confidence, long-unchecked — but genuinely free. */
const FREE_LOW_SCORE = {
  id: 'oc-free-low',
  activityName: 'Community Yoga Session',
  primaryCategoryKey: 'yoga',
  costStatus: 'free' as const,
  statusState: 'stale' as const,
  confidenceLabel: 'stale' as const,
  lastCheckedAtUtc: '2026-06-01T00:00:00Z', // 43 days before FIXTURE_NOW — past the recency horizon
  ...SHARED_WHEN,
};

describe('SearchEngine, Free filter active — unpriced listings are reordered, never hidden', () => {
  it('DECISIVE: free-active search shows BOTH, unstated still present, but ordered AFTER free', () => {
    const engine = customEngine([UNSTATED_HIGH_SCORE, FREE_LOW_SCORE]);
    const res = engine.search({ q: 'free', now: FIXTURE_NOW, minResults: 0, limit: 100 });

    expect(res.context.costFree).toBe(true);

    const ids = res.results.map((r) => r.listing.id);
    // STILL PRESENT — the standing ruling. Not a subset check: exactly these two, nothing lost.
    expect(new Set(ids)).toEqual(new Set([UNSTATED_HIGH_SCORE.id, FREE_LOW_SCORE.id]));
    expect(res.results).toHaveLength(2);

    // Non-vacuous proof that reordering, not coincidence, produced this order: the unstated
    // item's own raw score (returned alongside each result) is HIGHER than the free item's —
    // so best_match's own score ordering alone would have put it first. It didn't.
    const scoreOf = (id: string) => res.results.find((r) => r.listing.id === id)!.score;
    expect(scoreOf(UNSTATED_HIGH_SCORE.id)).toBeGreaterThan(scoreOf(FREE_LOW_SCORE.id));

    // And yet the FREE listing is first — the reorder step, not the raw ranking, decided this.
    expect(ids).toEqual([FREE_LOW_SCORE.id, UNSTATED_HIGH_SCORE.id]);
  });

  it('CONTROL: the SAME two listings, same scores, WITHOUT the Free filter — score alone decides', () => {
    // Isolates the gate: with `ctx.costFree` false, prioritizeConfirmedFreeWhenFreeActive must
    // not run at all, so best_match's own score ordering is what a parent sees — unstated
    // (higher score) first. If this ever also came back free-first, the reorder step would be
    // running unconditionally rather than gated on the Free filter, which is its own regression.
    const engine = customEngine([UNSTATED_HIGH_SCORE, FREE_LOW_SCORE]);
    const res = engine.search({ q: 'yoga', now: FIXTURE_NOW, minResults: 0, limit: 100 });

    expect(res.context.costFree).toBe(false);
    const ids = res.results.map((r) => r.listing.id);
    expect(new Set(ids)).toEqual(new Set([UNSTATED_HIGH_SCORE.id, FREE_LOW_SCORE.id]));
    expect(ids).toEqual([UNSTATED_HIGH_SCORE.id, FREE_LOW_SCORE.id]); // higher score first, unchanged
  });

  it('the reorder is an ORDERING change only — matchesCost/CostFilter untouched (cross-check with cost.ts)', () => {
    // Belt-and-braces alongside tests/search/cost-always-includes-unknown.test.ts's own
    // type-level pin on CostFilter's shape: this asserts the BEHAVIOURAL half — a known,
    // genuinely-priced listing dropped into the same catalogue is still EXCLUDED by the Free
    // filter (the reorder step only ever touches the set matchesCost already decided).
    const paid = { id: 'oc-paid', activityName: 'Community Yoga Session', primaryCategoryKey: 'yoga', costStatus: 'known' as const, costMinCad: 40, costMaxCad: 40, ...SHARED_WHEN };
    const engine = customEngine([UNSTATED_HIGH_SCORE, FREE_LOW_SCORE, paid]);
    const res = engine.search({ q: 'free', now: FIXTURE_NOW, minResults: 0, limit: 100 });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).not.toContain('oc-paid');
    expect(ids).toEqual([FREE_LOW_SCORE.id, UNSTATED_HIGH_SCORE.id]);
  });
});
