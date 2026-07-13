// lib/search/rank-config.ts — Ranking weight config (G-T19-4, TSD §5A.3, BR-18).
//
// Weights are CONFIG, not hard-coded: tunable from analytics without a redeploy and
// with NO monetisation input (BR-18 deferred). `RankConfigProvider` is the swap seam —
// this static provider now; a DB-backed provider over `rank_weights` later.
//
// NOTE (G-T19-4): the canonical store is a future migration `0014_rank_weights.sql`.
// It is intentionally NOT added here to avoid colliding with the not-yet-authored M0/M1
// migration chain (0001–0013). Keys below are the contract that migration will seed.

/** Weights w1..w7 from §5A.3. Keys map 1:1 to score components. */
export interface RankWeights {
  tsRank: number; // w1 · ts_rank(relevance)
  ageMatch: number; // w2 · age_match
  dateProximity: number; // w3 · date_proximity
  distanceDecay: number; // w4 · distance_decay
  statusConfidenceBoost: number; // w5 · status/confidence boost
  suitabilityMatch: number; // w6 · suitability_match
  recency: number; // w7 · recency
}

/** Launch defaults. Relevance-led, with an honest status/confidence boost weighted high. */
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  tsRank: 1.0,
  ageMatch: 0.6,
  dateProximity: 0.7,
  distanceDecay: 0.8,
  statusConfidenceBoost: 0.9,
  suitabilityMatch: 0.3,
  recency: 0.2,
};

export interface RankConfigProvider {
  getWeights(): RankWeights;
}

/** Static provider (fixture / default). */
export class StaticRankConfig implements RankConfigProvider {
  constructor(private readonly weights: RankWeights = DEFAULT_RANK_WEIGHTS) {}
  getWeights(): RankWeights {
    return this.weights;
  }
}
