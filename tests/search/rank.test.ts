// tests/search/rank.test.ts — Weighted ranking + status boost (G-T19-1/2).

import { describe, it, expect } from 'vitest';
import { scoreListing, rankCandidates, type RankContext } from '../../lib/search/rank';
import type { MatchCandidate } from '../../lib/search/match';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

const baseCtx: RankContext = {
  origin: { lat: 49.26, lng: -123.07 },
  radiusKm: 10,
  ageBands: [],
  date: null,
  rainyDay: false,
  now: FIXTURE_NOW,
};

const cand = (listing: ReturnType<typeof makeListing>, relevance = 1): MatchCandidate => ({
  listing,
  relevance,
  matchedTerms: [],
  categoryHit: true,
});

describe('ranking function (§5A.3)', () => {
  it('returns a transparent per-component breakdown (no black box)', () => {
    const s = scoreListing(cand(makeListing({ statusState: 'bookable_open', geo: { lat: 49.26, lng: -123.07 } })), baseCtx);
    expect(s.components).toHaveProperty('tsRank');
    expect(s.components).toHaveProperty('statusConfidenceBoost');
    expect(s.components).toHaveProperty('distanceDecay');
    expect(s.score).toBeGreaterThan(0);
  });

  it('boosts confirmed/bookable above an otherwise-equal stale listing (AC G-T19-2)', () => {
    const geo = { lat: 49.26, lng: -123.07 };
    const confirmed = cand(makeListing({ id: 'c', statusState: 'bookable_open', confidenceLabel: 'official_recent', geo }));
    const stale = cand(makeListing({ id: 's', statusState: 'stale', confidenceLabel: 'stale', geo }));
    const ordered = rankCandidates([stale, confirmed], baseCtx);
    expect(ordered[0].candidate.listing.id).toBe('c');
    expect(ordered[0].score).toBeGreaterThan(ordered[1].score);
  });

  it('reads weights from config — zeroing a weight removes its influence (AC G-T19-1/4)', () => {
    const geo = { lat: 49.26, lng: -123.07 };
    const listing = makeListing({ statusState: 'bookable_open', confidenceLabel: 'official_recent', geo });
    const withStatus = scoreListing(cand(listing), baseCtx);
    const withoutStatus = scoreListing(cand(listing), {
      ...baseCtx,
      weights: {
        tsRank: 1, ageMatch: 0.6, dateProximity: 0.7, distanceDecay: 0.8,
        statusConfidenceBoost: 0, suitabilityMatch: 0.3, recency: 0.2,
      },
    });
    expect(withoutStatus.score).toBeLessThan(withStatus.score);
  });

  it('tolerates a live free-text confidence_label without producing NaN (integration gap D)', () => {
    const geo = { lat: 49.26, lng: -123.07 };
    // Track B stores confidence_label as free text (e.g. "official_verified").
    const listing = makeListing({ statusState: 'confirmed', confidenceLabel: 'official_verified' as never, geo });
    const s = scoreListing(cand(listing), baseCtx);
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.components.statusConfidenceBoost).toBeGreaterThan(0);
  });

  it('is deterministic and stable across runs', () => {
    const geo = { lat: 49.26, lng: -123.07 };
    const c = [
      cand(makeListing({ id: 'a', statusState: 'confirmed', geo })),
      cand(makeListing({ id: 'b', statusState: 'bookable_open', geo })),
    ];
    const first = rankCandidates(c, baseCtx).map((x) => x.candidate.listing.id);
    const second = rankCandidates(c, baseCtx).map((x) => x.candidate.listing.id);
    expect(first).toEqual(second);
  });
});
