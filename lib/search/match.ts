// lib/search/match.ts — Weighted tsquery + trigram matcher assembly (G-T16-3, TSD §5A.1).
//
// Builds a candidate set with a `ts_rank`-like relevance over the four weighted
// fields (A name, B category/tags, C venue/org, D description) using the default
// Postgres field weights, plus a pg_trgm fuzzy fallback for typos/partials
// ("opengym" still matches open-gym). `CandidateMatcher` is the swap seam: this
// in-memory impl mirrors what a SQL `tsquery @@ tsvector` + `similarity()` will do.

import type { ListingRecord } from './types';
import type { ExpandedQuery } from './expand';
import { tokenize } from './text/normalize';
import { similarity, DEFAULT_TRIGRAM_THRESHOLD } from './text/trigram';

/** Postgres default tsvector field weights {A,B,C,D}. */
export const DEFAULT_FIELD_WEIGHTS = { A: 1.0, B: 0.4, C: 0.2, D: 0.1 } as const;

export interface MatcherOptions {
  fieldWeights?: { A: number; B: number; C: number; D: number };
  trigramThreshold?: number;
  /** Relevance multiplier applied to fuzzy (trigram) hits vs exact lexeme hits. */
  fuzzyPenalty?: number;
  /** Relevance multiplier for terms derived from alias synonyms vs the user's own terms. */
  synonymWeight?: number;
}

export interface MatchCandidate {
  listing: ListingRecord;
  /** ts_rank-like relevance in ~[0, n]; higher is better. 0 for browse-only (no text) queries. */
  relevance: number;
  matchedTerms: string[];
  /** True when a category boost fired (query resolved to this listing's canonical category). */
  categoryHit: boolean;
}

/** Query→candidates contract. */
export interface CandidateMatcher {
  match(expanded: ExpandedQuery, listings: ListingRecord[]): MatchCandidate[];
}

interface WeightedField {
  tokens: Set<string>;
  weight: number;
}

export class WeightedTrigramMatcher implements CandidateMatcher {
  private readonly weights: { A: number; B: number; C: number; D: number };
  private readonly threshold: number;
  private readonly fuzzyPenalty: number;
  private readonly synonymWeight: number;

  constructor(opts: MatcherOptions = {}) {
    this.weights = opts.fieldWeights ?? { ...DEFAULT_FIELD_WEIGHTS };
    this.threshold = opts.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD;
    this.fuzzyPenalty = opts.fuzzyPenalty ?? 0.5;
    this.synonymWeight = opts.synonymWeight ?? 0.6;
  }

  match(expanded: ExpandedQuery, listings: ListingRecord[]): MatchCandidate[] {
    const userTerms = uniq(expanded.originalTerms);
    const synonymPhrases = expanded.synonymPhrases;
    const categoryKeys = new Set(expanded.canonicalCategoryKeys);
    const tagKeys = new Set(expanded.canonicalTagKeys);
    const browseMode =
      userTerms.length === 0 && synonymPhrases.length === 0 && categoryKeys.size === 0 && tagKeys.size === 0;

    const out: MatchCandidate[] = [];
    for (const listing of listings) {
      if (browseMode) {
        // No text intent → every listing is a candidate; filters/ranking decide.
        out.push({ listing, relevance: 0, matchedTerms: [], categoryHit: false });
        continue;
      }

      const fields = this.buildFields(listing);
      let relevance = 0;
      const matchedTerms: string[] = [];

      // User's own terms: OR — each contributes its best-field weight.
      for (const term of userTerms) {
        const contribution = this.bestFieldContribution(term, fields);
        if (contribution > 0) {
          relevance += contribution;
          matchedTerms.push(term);
        }
      }
      // Alias synonym phrases: AND — a phrase contributes only when ALL its tokens match.
      for (const phrase of synonymPhrases) {
        const contribution = this.phraseContribution(phrase, fields) * this.synonymWeight;
        if (contribution > 0) relevance += contribution;
      }

      // Category boost: query resolved to a canonical category/tag this listing carries.
      let categoryHit = false;
      if (categoryKeys.has(listing.primaryCategoryKey)) {
        relevance += this.weights.A; // primary category match ≈ a name-weight hit
        categoryHit = true;
      } else if (listing.categoryTags.some((t) => categoryKeys.has(t))) {
        relevance += this.weights.B;
        categoryHit = true;
      }
      if (listing.suitabilityTags.some((t) => tagKeys.has(t)) || listing.categoryTags.some((t) => tagKeys.has(t))) {
        relevance += this.weights.B;
        categoryHit = true;
      }

      if (relevance > 0) out.push({ listing, relevance, matchedTerms, categoryHit });
    }
    return out;
  }

  private buildFields(listing: ListingRecord): WeightedField[] {
    return [
      { tokens: new Set(tokenize(listing.activityName)), weight: this.weights.A },
      {
        tokens: new Set(tokenize([listing.primaryCategoryKey, ...listing.categoryTags, ...listing.suitabilityTags].join(' '))),
        weight: this.weights.B,
      },
      { tokens: new Set(tokenize([listing.venueName, listing.organisation ?? ''].join(' '))), weight: this.weights.C },
      { tokens: new Set(tokenize(listing.descriptionSnippet)), weight: this.weights.D },
    ];
  }

  /**
   * Phrase (AND) contribution: every token must match some field (exact or fuzzy);
   * the phrase then scores at its strongest single-token field weight. Prevents a
   * generic token (e.g. "family") from matching a phrase on its own.
   */
  private phraseContribution(phrase: string[], fields: WeightedField[]): number {
    let strongest = 0;
    for (const token of phrase) {
      const w = this.bestFieldContribution(token, fields);
      if (w <= 0) return 0; // a missing token fails the whole phrase
      if (w > strongest) strongest = w;
    }
    return strongest;
  }

  /** Best (max) relevance contribution for a term across all fields: exact lexeme or trigram fuzzy. */
  private bestFieldContribution(term: string, fields: WeightedField[]): number {
    let best = 0;
    for (const field of fields) {
      if (field.tokens.has(term)) {
        best = Math.max(best, field.weight);
        continue;
      }
      let bestSim = 0;
      for (const token of field.tokens) {
        const sim = similarity(term, token);
        if (sim > bestSim) bestSim = sim;
      }
      if (bestSim >= this.threshold) {
        best = Math.max(best, field.weight * bestSim * this.fuzzyPenalty);
      }
    }
    return best;
  }
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}
