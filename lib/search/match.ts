// lib/search/match.ts — Weighted tsquery + trigram matcher assembly (G-T16-3, TSD §5A.1).
//
// Builds a candidate set with a `ts_rank`-like relevance over the four weighted
// fields (A name, B category/tags, C venue/org, D description) using the default
// Postgres field weights, plus fuzzy fallbacks for typos/partials ("opengym" still
// matches open-gym). `CandidateMatcher` is the swap seam: this in-memory impl
// mirrors what a SQL `tsquery @@ tsvector` + `similarity()` will do.
//
// A query term matches an index token through exactly one of five tiers, strongest first:
//
//   exact     term === token                                            (weight × 1.00)
//   stem      same word, different inflection: swimming ↔ swim          (weight × 0.80)
//   prefix    token starts with the term: swi → swim                    (weight × 0.60 × coverage)
//   compound  term is two tokens run together: opengym → open + gym     (weight × 0.50)
//   typo      guarded trigram similarity: libary → library              (weight × 0.50 × similarity)
//
// WHY THE TIERS EXIST (relevance defect, registry round 97). Matching used to be trigram
// similarity alone, which is symmetric: a query and a token matched whenever either began
// with the other, at any length. So "parade" returned the same catalogue-wide result set as
// "pa" — both merely shared an opening with "park" — and reported it as an EXACT match with
// no broadening applied, so the UI presented a swim lesson for "parade" with full confidence.
//
// Threshold tuning cannot fix that: similarity('swim','swimxyz') = 0.444 scores HIGHER than
// similarity('swim','swimming') = 0.4, so no cutoff separates a real inflection from trailing
// junk. The distinction is linguistic, not numeric, so each direction now gets the mechanism
// that actually answers it:
//   · query-is-prefix-of-token is a plain `startsWith` — a substring test, immune to the
//     short-string Jaccard bias, scaled by how much of the token the query covers so a thin
//     two-character prefix ranks far below a near-complete one;
//   · token-is-prefix-of-query is NOT similarity at all — it is only a match when the extra
//     characters are an English inflection (stem tier) or a second real token (compound tier).
//     "swimxyz" and "storytimezz" are neither, so they correctly return nothing and the
//     empty-state broadening ladder gets to do its honest job.
// Genuine misspellings keep their trigram fallback, guarded by `typoSimilarity` so a shared
// opening alone can never carry a match. See lib/search/text/trigram.ts for that guard.

import type { ListingRecord } from './types';
import type { ExpandedQuery } from './expand';
import { tokenize } from './text/normalize';
import { typoSimilarity, DEFAULT_TRIGRAM_THRESHOLD, MIN_FUZZY_QUERY_LENGTH } from './text/trigram';

/** Postgres default tsvector field weights {A,B,C,D}. */
export const DEFAULT_FIELD_WEIGHTS = { A: 1.0, B: 0.4, C: 0.2, D: 0.1 } as const;

/** Shortest term allowed to prefix-match a longer token ("pa" → park). One character is noise. */
export const MIN_PREFIX_QUERY_LENGTH = 2;

/** Shortest half of a run-together compound ("open" + "gym"). Below this it is a coincidence. */
const MIN_COMPOUND_PART_LENGTH = 3;

export interface MatcherOptions {
  fieldWeights?: { A: number; B: number; C: number; D: number };
  trigramThreshold?: number;
  /** Relevance multiplier applied to fuzzy (trigram) hits vs exact lexeme hits. */
  fuzzyPenalty?: number;
  /** Relevance multiplier for terms derived from alias synonyms vs the user's own terms. */
  synonymWeight?: number;
  /** Relevance multiplier for a token the term is a leading prefix of ("swi" → swim). */
  prefixPenalty?: number;
  /** Relevance multiplier for an inflectional variant ("swimming" → swim). */
  stemPenalty?: number;
  /** Shortest query term eligible for trigram typo matching. */
  minFuzzyQueryLength?: number;
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

/**
 * Every index token of one listing mapped to the strongest field weight it appears under.
 * A token's match tier depends only on the two words, so collapsing the four fields to a
 * best-weight-per-token map gives the same answer as scanning each field — while evaluating
 * a repeated token (a name word echoed in the description) once instead of four times.
 */
type TokenWeights = Map<string, number>;

export class WeightedTrigramMatcher implements CandidateMatcher {
  private readonly weights: { A: number; B: number; C: number; D: number };
  private readonly threshold: number;
  private readonly fuzzyPenalty: number;
  private readonly synonymWeight: number;
  private readonly prefixPenalty: number;
  private readonly stemPenalty: number;
  private readonly minFuzzyQueryLength: number;

  constructor(opts: MatcherOptions = {}) {
    this.weights = opts.fieldWeights ?? { ...DEFAULT_FIELD_WEIGHTS };
    this.threshold = opts.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD;
    this.fuzzyPenalty = opts.fuzzyPenalty ?? 0.5;
    this.synonymWeight = opts.synonymWeight ?? 0.6;
    this.prefixPenalty = opts.prefixPenalty ?? 0.6;
    this.stemPenalty = opts.stemPenalty ?? 0.8;
    this.minFuzzyQueryLength = opts.minFuzzyQueryLength ?? MIN_FUZZY_QUERY_LENGTH;
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

      const tokenWeights = this.buildTokenWeights(listing);
      let relevance = 0;
      const matchedTerms: string[] = [];

      // User's own terms: OR — each contributes its best-field weight.
      for (const term of userTerms) {
        const contribution = this.bestTokenContribution(term, tokenWeights);
        if (contribution > 0) {
          relevance += contribution;
          matchedTerms.push(term);
        }
      }
      // Alias synonym phrases: AND — a phrase contributes only when ALL its tokens match.
      for (const phrase of synonymPhrases) {
        const contribution = this.phraseContribution(phrase, tokenWeights) * this.synonymWeight;
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

  /** Collapse the four weighted fields to one token → strongest-weight map for this listing. */
  private buildTokenWeights(listing: ListingRecord): TokenWeights {
    const out: TokenWeights = new Map();
    for (const field of this.buildFields(listing)) {
      for (const token of field.tokens) {
        const current = out.get(token);
        if (current === undefined || field.weight > current) out.set(token, field.weight);
      }
    }
    return out;
  }

  /**
   * Phrase (AND) contribution: every token must match somewhere in the listing;
   * the phrase then scores at its strongest single-token field weight. Prevents a
   * generic token (e.g. "family") from matching a phrase on its own.
   */
  private phraseContribution(phrase: string[], tokenWeights: TokenWeights): number {
    let strongest = 0;
    for (const token of phrase) {
      const w = this.bestTokenContribution(token, tokenWeights);
      if (w <= 0) return 0; // a missing token fails the whole phrase
      if (w > strongest) strongest = w;
    }
    return strongest;
  }

  /** Best (max) relevance contribution for a term over every token in the listing. */
  private bestTokenContribution(term: string, tokenWeights: TokenWeights): number {
    let best = 0;
    for (const [token, weight] of tokenWeights) {
      const factor = this.matchFactor(term, token);
      if (factor > 0) best = Math.max(best, weight * factor);
    }
    const compound = this.compoundContribution(term, tokenWeights);
    return Math.max(best, compound);
  }

  /**
   * How strongly `term` matches a single `token`, in [0,1]; 0 when it does not.
   *
   * Order matters only for cost: exact short-circuits, the two cheap string tiers are taken
   * together (a term can be both a prefix and an inflection of the same token — "swim" vs
   * "swimming" — and should score at the better explanation), and the trigram walk is
   * reached only when neither fired.
   */
  private matchFactor(term: string, token: string): number {
    if (term === token) return 1;

    let best = 0;
    if (term.length >= MIN_PREFIX_QUERY_LENGTH && token.startsWith(term)) {
      // Coverage-scaled: "swi" explains three quarters of "swim" but only a third of
      // "swimming", and the score should say so rather than treating both as equal evidence.
      best = Math.max(best, this.prefixPenalty * (term.length / token.length));
    }
    if (sharesInflectionalStem(term, token)) best = Math.max(best, this.stemPenalty);
    if (best > 0) return best;

    const sim = typoSimilarity(term, token, this.threshold, this.minFuzzyQueryLength);
    return sim > 0 ? sim * this.fuzzyPenalty : 0;
  }

  /**
   * "opengym" → "open" + "gym": a term typed as one word that is two of THIS listing's tokens
   * run together. Both halves must match a token EXACTLY — accepting fuzzy halves would let
   * the trailing junk this fix removes back in through a side door — and both must be at least
   * three characters, so "swimxyz" cannot pass as "swim" + a two-letter fragment.
   */
  private compoundContribution(term: string, tokenWeights: TokenWeights): number {
    if (term.length < MIN_COMPOUND_PART_LENGTH * 2) return 0;
    let best = 0;
    for (let cut = MIN_COMPOUND_PART_LENGTH; cut <= term.length - MIN_COMPOUND_PART_LENGTH; cut++) {
      const head = tokenWeights.get(term.slice(0, cut));
      if (head === undefined) continue;
      const tail = tokenWeights.get(term.slice(cut));
      if (tail === undefined) continue;
      // The compound is only as strong as its weaker half — both had to be present for it to mean anything.
      best = Math.max(best, Math.min(head, tail) * this.fuzzyPenalty);
    }
    return best;
  }
}

/**
 * Common English inflectional suffixes, longest first so "-ies" wins over "-es"/"-s".
 * Deliberately a short hand-written list rather than a full stemmer: the matcher needs to
 * separate "swimming" from "swimxyz", not to conflate word families, and an aggressive
 * stemmer would re-open the over-matching this list exists to close.
 */
const INFLECTIONAL_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['ies', 'y'],
  ['ing', ''],
  ['ed', ''],
  ['es', ''],
  ['s', ''],
];

/** "swimm" → "swim": undo the consonant doubling English adds before -ing/-ed. */
function undouble(base: string): string {
  return /([bdfgklmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
}

/**
 * Every form a word could be the inflection of — itself, each suffix stripped, plus the
 * undoubled and silent-e restorations ("dancing" → danc → dance, "swimming" → swimm → swim).
 * Bases shorter than three characters are dropped: "bus" is not the plural of "bu".
 */
function inflectionalForms(word: string): Set<string> {
  const forms = new Set<string>([word]);
  for (const [suffix, replacement] of INFLECTIONAL_SUFFIXES) {
    if (word.length <= suffix.length + 1 || !word.endsWith(suffix)) continue;
    const base = word.slice(0, word.length - suffix.length) + replacement;
    for (const candidate of [base, `${base}e`, undouble(base), `${undouble(base)}e`]) {
      if (candidate.length >= 3) forms.add(candidate);
    }
  }
  return forms;
}

/** True when two words are the same word under a common English inflection, either direction. */
export function sharesInflectionalStem(a: string, b: string): boolean {
  if (a === b) return true;
  const formsB = inflectionalForms(b);
  for (const form of inflectionalForms(a)) {
    if (formsB.has(form)) return true;
  }
  return false;
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}
