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
// Prefix-collision guard (search relevance fix; see lib/search/match.ts).
//
// pg_trgm pads every word with TWO leading spaces, so a word's first characters
// generate boundary-anchored trigrams ("  p", " pa", "par") that ANY other word
// with the same opening carries too. Jaccard then reports a shared opening as
// genuine similarity, and because short words own few trigrams the ratio stays
// above the 0.3 threshold on nothing but that opening:
//
//   similarity('pa',     'park')  = 0.333   ← a two-character query
//   similarity('parade', 'park')  = 0.333   ← the user-visible bug: "parade" hit "park"
//   similarity('swim',   'swimxyz') = 0.444 ← scores HIGHER than swim/swimming (0.4)
//
// The last line is why no threshold tuning fixes this: trigram overlap cannot tell an
// English inflection from arbitrary trailing junk, because in BOTH cases the entire
// overlap is just the shared opening. So the matcher asks a structural question
// instead — "is there any shared trigram the common prefix does NOT explain?" — and
// treats prefix-only overlap as evidence only when the two words are a single edit
// apart (a real typo), not merely a coincidental shared opening.
// ---------------------------------------------------------------------------

/**
 * Shortest query length that may be fuzzy-matched. Measured, not guessed: over the live
 * staging catalogue's 220-word vocabulary, dropping to 3 buys only false positives
 * (big~bit) and 4 loses no legitimate pair — every surviving fuzzy match is ≥ 4 characters.
 */
export const MIN_FUZZY_QUERY_LENGTH = 4;

/** Length of the longest common leading run of characters. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** The padded length-3 windows of a single word, in order. */
function paddedWindows(word: string): string[] {
  const padded = `  ${word} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

/**
 * True when EVERY trigram two words share is one their common prefix already accounts for —
 * i.e. the overlap says "these start the same" and nothing more.
 *
 * The first `p` windows of `  word ` are exactly the ones that end inside a common prefix of
 * length `p`; a pair with real structural agreement (a typo sharing an interior or a suffix,
 * like libary/library sharing "ary"/"ry ") contributes trigrams outside that set.
 *
 * Multi-word inputs return false — this guard is a single-token question, and declining to
 * answer keeps it from silently suppressing a phrase comparison.
 */
export function overlapIsPrefixOnly(a: string, b: string): boolean {
  const wa = normalize(a);
  const wb = normalize(b);
  if (!wa || !wb || wa.includes(' ') || wb.includes(' ')) return false;

  const prefixLength = commonPrefixLength(wa, wb);
  if (prefixLength === 0) return false;

  const explained = new Set(paddedWindows(wa).slice(0, prefixLength));
  const other = trigrams(wb);
  let shared = 0;
  for (const gram of trigrams(wa)) {
    if (!other.has(gram)) continue;
    shared++;
    if (!explained.has(gram)) return false; // overlap reaches past the common prefix
  }
  return shared > 0;
}

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
 * Trigram similarity for TYPO tolerance: pg_trgm's score, but 0 whenever the only thing the
 * two words share is an opening and they are more than one edit apart. That single guard is
 * what stops "parade" matching "park" and "swimxyz" matching "swim" while leaving genuine
 * misspellings (libary/library, soccor/soccer, gymm/gym) exactly where they were.
 *
 * Queries shorter than `minLength` are not fuzzy-matched at all: below four characters a
 * single edit is a third or more of the whole word, and every legitimate short query is
 * already served by the exact / prefix / stem tiers in lib/search/match.ts.
 */
export function typoSimilarity(
  query: string,
  token: string,
  threshold = DEFAULT_TRIGRAM_THRESHOLD,
  minLength = MIN_FUZZY_QUERY_LENGTH
): number {
  if (query.length < minLength) return 0;
  const score = similarity(query, token);
  if (score < threshold) return 0;
  if (overlapIsPrefixOnly(query, token) && !withinOneEdit(query, token)) return 0;
  return score;
}
