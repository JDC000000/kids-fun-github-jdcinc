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
//   · a term merely BURIED inside a longer token (ball in basketball) is deliberately NOT
//     matched. An infix tier shipped here briefly and was removed on measurement against the
//     live corpus: on the old 500-row capped page it bought two real rescues, and even
//     its best possible tightening still carried ~11% coincidental matches. Since the whole
//     point of this file is replacing coincidental matching with deliberate rules, a tier that
//     is mostly coincidence cannot sit in it. Compounds are right-headed — basketball IS a
//     ball — which is a LEXICAL fact, so it belongs in expand.ts aliases where it is stated
//     deliberately, next to gymnast→gym for the same reason.
// Genuine misspellings keep their trigram fallback, guarded by `typoSimilarity` so that only
// pairs within a single edit can match on a ratio. That guard is stated over the whole word,
// not over its opening: "swimmer" and "summer" collide on a shared ENDING and an opening-only
// guard let them through. See lib/search/text/trigram.ts.

import type { ListingRecord } from './types';
import type { ExpandedQuery } from './expand';
import { tokenize } from './text/normalize';
import { typoSimilarity, DEFAULT_TRIGRAM_THRESHOLD, MIN_FUZZY_QUERY_LENGTH } from './text/trigram';

/** Postgres default tsvector field weights {A,B,C,D}. */
export const DEFAULT_FIELD_WEIGHTS = { A: 1.0, B: 0.4, C: 0.2, D: 0.1 } as const;

/**
 * Shortest term allowed to prefix-match a longer token ("pa" → park). One character is noise.
 *
 * DO NOT RAISE THIS TO 3 — it was tested, not assumed. Independent QA (round 97) ran a build
 * with only this constant flipped to 3, side by side with 2 and with the pre-fix baseline,
 * against the same live catalogue: "sw", "op", "ki" and "ba" all fell from real results to
 * zero, and two-character type-ahead stopped working entirely. Two is the measured answer.
 */
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

/** Shortest stem worth matching on. "bus" is not the plural of "bu". */
const MIN_STEM_LENGTH = 3;

/**
 * Shortest stem an UNDOUBLED agentive "-er"/"-ers" may produce — one character longer than
 * everywhere else, and the difference is a false-root guard rather than a style choice.
 *
 * Undoubling turns "swimmer" into "swim", but it turns "matter" into "mat", "manner" into
 * "man", "ladder" into "lad", "supper" into "sup" and "copper" into "cop" just as happily,
 * because nothing here knows which words are agent nouns. Swept over the live catalogue's
 * 1204-word vocabulary, every false root the rule produced bottomed out at three characters
 * (mat~matters and manner~man both collide with real vocabulary), and every true agentive
 * stem reached four or came through the silent-e path instead (swimmer → swim, skater →
 * skate, dancer → dance). So four is where the two populations actually separate.
 *
 * The cost is runner → run and jogger → jog. Measured rather than assumed: "run", "jog" and
 * "dig" are not tokens anywhere in the catalogue, so nothing real is lost today — and the
 * reliable inflections keep the lower floor, so "running" → "run" still works if one appears.
 */
const MIN_AGENTIVE_STEM_LENGTH = 4;

/**
 * Common English inflectional suffixes, longest first so "-ies" wins over "-es"/"-s".
 * Deliberately a short hand-written list rather than a full stemmer: the matcher needs to
 * separate "swimming" from "swimxyz", not to conflate word families, and an aggressive
 * stemmer would re-open the over-matching this list exists to close.
 *
 * `bareBase` says whether stripping the suffix leaves a word we are willing to match on its
 * own. It is false for the agentive "-er"/"-ers" because that ending is not reliably a
 * suffix at all: "swimmer" really is swim + -er, but "mother" is not moth + -er and "corner"
 * is not corn + -er. Restricting those two to the forms that only arise through a real
 * spelling change — an undoubled consonant (swimmer → swimm → swim, runner → run) or a
 * restored silent e (skater → skat → skate, dancer → dance) — keeps the agentive nouns a
 * parent actually types while refusing to turn a search for "mother" into moth listings.
 */
const INFLECTIONAL_SUFFIXES: ReadonlyArray<{
  suffix: string;
  replacement: string;
  bareBase: boolean;
  minUndoubled: number;
}> = [
  { suffix: 'ies', replacement: 'y', bareBase: true, minUndoubled: MIN_STEM_LENGTH },
  { suffix: 'ing', replacement: '', bareBase: true, minUndoubled: MIN_STEM_LENGTH },
  { suffix: 'ers', replacement: '', bareBase: false, minUndoubled: MIN_AGENTIVE_STEM_LENGTH },
  { suffix: 'ed', replacement: '', bareBase: true, minUndoubled: MIN_STEM_LENGTH },
  { suffix: 'er', replacement: '', bareBase: false, minUndoubled: MIN_AGENTIVE_STEM_LENGTH },
  { suffix: 'es', replacement: '', bareBase: true, minUndoubled: MIN_STEM_LENGTH },
  { suffix: 's', replacement: '', bareBase: true, minUndoubled: MIN_STEM_LENGTH },
];

/** "swimm" → "swim": undo the consonant doubling English adds before -ing/-ed/-er. */
function undouble(base: string): string {
  return /([bdfgklmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
}

/**
 * Every form a word could be the inflection of — itself, each suffix stripped, plus the
 * undoubled and silent-e restorations ("dancing" → danc → dance, "swimming" → swimm → swim,
 * "swimmer" → swimm → swim). Bases shorter than three characters are dropped: "bus" is not
 * the plural of "bu".
 */
function inflectionalForms(word: string): Set<string> {
  const forms = new Set<string>([word]);
  for (const { suffix, replacement, bareBase, minUndoubled } of INFLECTIONAL_SUFFIXES) {
    if (word.length <= suffix.length + 1 || !word.endsWith(suffix)) continue;
    const base = word.slice(0, word.length - suffix.length) + replacement;
    const undoubled = undouble(base);
    const plain = bareBase
      ? [base, `${base}e`]
      : // Only the spelling-change forms; the bare base is where moth/corn would come from.
        [`${base}e`];
    for (const candidate of plain) {
      if (candidate.length >= MIN_STEM_LENGTH) forms.add(candidate);
    }
    // The undoubled forms carry the false-root risk, so they answer to their own floor.
    if (undoubled !== base && undoubled.length >= minUndoubled) {
      forms.add(undoubled);
      forms.add(`${undoubled}e`);
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
