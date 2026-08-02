// lib/search/text/trigram.ts — pg_trgm-compatible trigram similarity for typo/partial matches.
//
// Postgres `pg_trgm` pads each word with two leading spaces + one trailing space,
// slices length-3 windows, and reports `similarity(a,b) = |A ∩ B| / |A ∪ B|`
// (Jaccard over the trigram sets). We reproduce that so the fixture matcher's
// fuzzy behaviour (G-T16-3) tracks the eventual `similarity()`/`%` operator.

import { normalize } from './normalize';

/** Default `pg_trgm.similarity_threshold`. */
export const DEFAULT_TRIGRAM_THRESHOLD = 0.3;

/** Generate the pg_trgm trigram set for a string. */
export function trigrams(input: string): Set<string> {
  const words = normalize(input).split(' ').filter(Boolean);
  const set = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return set;
}

/** Jaccard similarity of two trigram sets — matches pg_trgm `similarity()` in [0,1]. */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const g of ta) if (tb.has(g)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True when similarity clears the threshold (pg_trgm `%` operator). */
export function fuzzyMatches(a: string, b: string, threshold = DEFAULT_TRIGRAM_THRESHOLD): boolean {
  return similarity(a, b) >= threshold;
}

// ---------------------------------------------------------------------------
// Coincidence guard (search relevance fix; see lib/search/match.ts).
//
// pg_trgm pads every word with TWO leading spaces, so a word's first characters
// generate boundary-anchored trigrams ("  p", " pa", "par") that ANY other word
// with the same opening carries too. Jaccard then reports a shared opening as
// genuine similarity, and because short words own few trigrams the ratio stays
// above the 0.3 threshold on nothing but that opening:
//
//   similarity('pa',     'park')    = 0.333  ← a two-character query
//   similarity('parade', 'park')    = 0.333  ← "parade" hit "park" catalogue-wide
//   similarity('swim',   'swimxyz') = 0.444  ← scores HIGHER than swim/swimming (0.4)
//
// That last line is why no threshold tuning fixes this: trigram overlap cannot tell an
// English inflection from arbitrary trailing junk. But an opening is not the only way
// two unrelated words collide — a shared ENDING does it just as well, and there the
// ratio is just as blind:
//
//   similarity('swimmer', 'summer')   = 0.364 ← shares "mme"/"mer"/"er ", no prefix at all
//   similarity('length',  'strength') = 0.333 ← shares "eng"/"ngt"/"gth"/"th "
//
// An earlier revision guarded only the prefix case, which is where the bug was REPORTED
// rather than where it lives; "swimmer" then returned Summer Reading Club and no swim
// sessions at all. So the guard is stated over the whole word instead of over one end of
// it: trigram overlap counts as a TYPO only when the two words are within a single edit.
// Anything further apart has to earn its match through an explicit, direction-safe rule
// (exact / stem / prefix / infix / compound) rather than through a coincidental ratio.
// ---------------------------------------------------------------------------

/**
 * Shortest query length that may be fuzzy-matched. Measured, not guessed: over the live
 * staging catalogue's vocabulary, dropping to 3 buys only false positives (big~bit) while
 * 4 loses no legitimate pair — every surviving fuzzy match is at least 4 characters.
 */
export const MIN_FUZZY_QUERY_LENGTH = 4;

/**
 * Damerau-style "at most one edit apart" (substitution, insertion/deletion, or an adjacent
 * transposition). Bounded at 1 so it stays O(n) — we only ever need the yes/no.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;

  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i); // insertion / deletion
}

/**
 * Trigram similarity for TYPO tolerance: pg_trgm's score, but only for pairs that are also
 * within a single edit. Both halves do work — the edit bound rejects coincidental overlap at
 * either end of the word (parade/park, swimxyz/swim, swimmer/summer, length/strength), and
 * the threshold still rejects short pairs where one edit is most of the word (cat/cot).
 * Genuine misspellings — libary/library, soccor/soccer, gymm/gym, siwm/swim — clear both.
 *
 * Queries shorter than `minLength` are not fuzzy-matched at all: below four characters a
 * single edit is a third or more of the whole word, and every legitimate short query is
 * already served by the exact / prefix / stem tiers in lib/search/match.ts.
 *
 * Relationships that span more than one edit are NOT this function's job. A longer word
 * legitimately containing the query (ball → basketball) is the infix tier; an inflection
 * (swimmer → swim) is the stem tier. Both are exact string tests, so neither can be talked
 * into a match by a ratio.
 */
export function typoSimilarity(
  query: string,
  token: string,
  threshold = DEFAULT_TRIGRAM_THRESHOLD,
  minLength = MIN_FUZZY_QUERY_LENGTH
): number {
  if (query.length < minLength) return 0;
  if (!withinOneEdit(query, token)) return 0;
  const score = similarity(query, token);
  return score >= threshold ? score : 0;
}
